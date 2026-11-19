import { randomBytes } from "node:crypto";
import { StepError } from "@daloy/engine";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeSmtp } from "../../../test/fake-smtp";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { secretValuesToHide } from "./crypto";
import type { Db } from "./index";
import { sendAs, smtpMailer, type MailDeps } from "./mail";
import { connectGmail, readSender, resolveSender, saveProfile } from "./mail-senders";
import { blobTokens, consumeFlow, disconnectOAuth, finishFlow, freshToken, gmail, GMAIL_GRANT, keepOAuthAlive, startFlow } from "./oauth";
import { decryptSecret } from "./crypto";
import type { ProviderUrls } from "./providers";
import { mailSenders, users } from "./schema";

// Decision 0063: Gmail through a Google sign-in (gmail.send) and the Gmail API, against the fake Google OAuth app and
// the fake Gmail API. Nothing here contacts Google.
const key = randomBytes(32);
const PUBLIC = "http://localhost:3000";
const ANA = { id: "google-ana", email: "Ana.Cruz@gmail.com" };
const BEN = { id: "google-ben", email: "ben.cruz@gmail.com" };
const SEND = "/gmail/v1/users/me/messages/send";
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let smtp: Awaited<ReturnType<typeof startFakeSmtp>>;
let installation: Awaited<ReturnType<typeof startFakeSmtp>>;
let deps: MailDeps;
let seq = 0;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  const app = fake.addOAuthApp("google", { rotation: "none" });
  urls = { ...fake.urls, timeoutMs: 1500, googleOAuth: { clientId: app.clientId, clientSecret: app.clientSecret, ...fake.oauthUrls("google") } };
  smtp = await startFakeSmtp();
  installation = await startFakeSmtp();
  deps = {
    installation: smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(installation.port) }),
    gmail: (auth) => smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_USER: auth.user, SMTP_PASS: auth.pass }).transport,
    sharedMail: "open",
    urls,
  };
}, 120_000);
afterAll(async () => {
  await fake?.close();
  await smtp?.close();
  await installation?.close();
  await pool?.end();
});
beforeEach(() => {
  Object.assign(fake.oauth.google!, { consent: "grant", user: ANA, emailVerified: true, grantScopes: [] });
});

async function owner() {
  const [u] = await db.insert(users).values({ email: `gm${++seq}@test.local`, passwordHash: "x" }).returning();
  return u!.id;
}
/** The whole consent, as the callback runs it: start, the fake's consent page, the one-time flow, then the outcome. */
async function connect(ws: string, who = ANA) {
  fake.oauth.google!.user = who;
  const back = new URL((await fetch(await startFlow(db, key, urls, PUBLIC, gmail, { workspaceId: ws, memberId: ws }), { redirect: "manual" })).headers.get("location")!);
  const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: ws, memberId: ws });
  expect(flow?.provider).toBe("gmail");
  if (back.searchParams.get("error")) return gmail.outcome(back.searchParams.get("error")!, back.searchParams.get("error_description") ?? "");
  return finishFlow(db, key, urls, PUBLIC, gmail, ws, back.searchParams.get("code")!, flow!.verifier);
}
const sender = async (ws: string) => (await db.select().from(mailSenders).where(eq(mailSenders.userId, ws)))[0];
const tokensOf = async (ws: string) => {
  const r = (await sender(ws))!;
  return blobTokens(decryptSecret(key, ws, GMAIL_GRANT, { ciphertext: r.passwordCiphertext!, iv: r.passwordIv!, authTag: r.passwordAuthTag! }));
};
const mail = (to: string, subject = "Your booking") => ({ to, subject, text: "Hello,\nyour booking is confirmed for Friday.\n\nThanks" });
const send = (ws: string, cfg = mail("customer@example.com"), o: Parameters<typeof sendAs>[6] = {}) => sendAs(db, key, deps, ws, cfg, `run-${++seq}:email:1`, o);
const failure = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(StepError);
  return err as StepError;
};
/** The message Google received, with its line breaks as the SMTP fake records them. */
const lastApiMessage = () => fake.gmail.sent.at(-1)!.raw.replace(/\r\n/g, "\n");
const headersAndBody = (raw: string) => {
  const [head, ...body] = raw.split("\n\n");
  // Date is the build time; everything else must be the same bytes. The SMTP fake drops the line break before its end-of-data dot.
  return { headers: head!.split("\n").filter((l) => !l.startsWith("Date:")), body: body.join("\n\n").trimEnd() };
};

describe("Connect Gmail with Google", () => {
  it("connects with gmail.send and Google's verified address, which replaces the confirmation email", async () => {
    const ws = await owner();
    expect(await connect(ws)).toBe("connected");
    expect(await sender(ws)).toMatchObject({ address: "ana.cruz@gmail.com", status: "active", authMethod: "oauth", externalId: ANA.id, scopes: "openid email https://www.googleapis.com/auth/gmail.send", verifyTokenHash: null, lastError: null });
    expect((await sender(ws))!.verifiedAt).toBeInstanceOf(Date);
    expect(await resolveSender(db, key, ws)).toMatchObject({ kind: "gmail_api", address: "ana.cruz@gmail.com" });
  });

  it("saves nothing when the owner declines, leaves out gmail.send, or Google did not verify the address", async () => {
    const ws = await owner();
    fake.oauth.google!.consent = "declined";
    expect(await connect(ws)).toBe("declined");
    Object.assign(fake.oauth.google!, { consent: "narrow", grantScopes: ["openid", "email"] });
    expect(await connect(ws)).toBe("missing_scope");
    Object.assign(fake.oauth.google!, { consent: "grant", emailVerified: false });
    await expect(connect(ws)).rejects.toMatchObject({ kind: "invalid", message: expect.stringContaining("did not confirm") });
    expect(await sender(ws)).toBeUndefined();
    expect(await resolveSender(db, key, ws)).toMatchObject({ kind: "installation" });
  });

  it("a reconnect with another Google account changes the address, as connecting a new address does", async () => {
    const ws = await owner();
    await connect(ws, ANA);
    await connect(ws, BEN);
    expect(await sender(ws)).toMatchObject({ address: BEN.email, externalId: BEN.id, status: "active" });
    await send(ws);
    expect(fake.gmail.sent.at(-1)).toMatchObject({ user: BEN.email });
    expect(lastApiMessage()).toContain(`From: ${BEN.email}`);
  });

  it("replaces an app password sender, and an app password replaces it back", async () => {
    const ws = await owner();
    await connectGmail(db, key, ws, { address: "ana.cruz@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    expect(await sender(ws)).toMatchObject({ status: "unverified", authMethod: "app_password" });
    await connect(ws);
    expect(await sender(ws)).toMatchObject({ status: "active", authMethod: "oauth" });
    await connectGmail(db, key, ws, { address: "ana.cruz@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    // The same address stays confirmed: Google proved the mailbox.
    expect(await sender(ws)).toMatchObject({ status: "active", authMethod: "app_password", externalId: null, scopes: null });
    expect(await resolveSender(db, key, ws)).toMatchObject({ kind: "gmail", password: "abcdefghijklmnop" });
  });
});

describe("sending through the Gmail API", () => {
  it("sends the same headers and plain text that the SMTP path sends for the same input", async () => {
    const viaSmtp = await owner();
    const viaApi = await owner();
    const profile = { businessName: "Cruz Bakery, Inc.", website: null, inquiryEmail: null, replyTo: "hello@cruzbakery.example" };
    await saveProfile(db, viaSmtp, profile);
    await saveProfile(db, viaApi, profile);
    await connectGmail(db, key, viaSmtp, { address: "ana.cruz@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    await db.update(mailSenders).set({ status: "active", verifiedAt: new Date() }).where(eq(mailSenders.userId, viaSmtp));
    await connect(viaApi);
    const cfg = { to: "a@example.com, b@example.com", subject: "Order 42: ready for pickup", text: "Hi Liza,\n\nYour cake is ready.\nSalamat po!" };
    await sendAs(db, key, deps, viaSmtp, cfg, "run-1:email:1");
    await sendAs(db, key, deps, viaApi, cfg, "run-1:email:1");
    const a = headersAndBody(smtp.messages.at(-1)!.raw);
    const b = headersAndBody(lastApiMessage());
    expect(b).toEqual(a);
    expect(b.headers).toEqual(expect.arrayContaining(['From: "Cruz Bakery, Inc." <ana.cruz@gmail.com>', "Reply-To: hello@cruzbakery.example", "To: a@example.com, b@example.com", "Message-ID: <run-1.email.1@daloy>"]));
  });

  it("a refused grant (the owner changed their Google password) marks the sender failed and sends nothing anywhere", async () => {
    const ws = await owner();
    const other = await owner();
    await connect(ws, ANA);
    await connect(other, BEN);
    const tokens = await tokensOf(ws);
    // Google ends a Gmail grant on a password change: the access token stops working and the refresh token is refused.
    for (const t of tokens) {
      fake.oauth.google!.accessTokens.delete(t);
      fake.oauth.google!.refreshTokens.delete(t);
    }
    const before = { api: fake.gmail.sent.length, installation: installation.messages.length, smtp: smtp.messages.length };
    const err = await failure(send(ws));
    expect(err).toMatchObject({ retryable: false, outcome: "not_sent", message: expect.stringContaining("Reconnect Gmail") });
    expect(await readSender(db, ws)).toMatchObject({ status: "failed", lastError: expect.stringContaining("Reconnect Gmail") });
    expect(await resolveSender(db, key, ws)).toMatchObject({ kind: "blocked", reason: expect.stringContaining("Reconnect Gmail") });
    // The next send is blocked before any server is contacted: no installation server, no other owner's Gmail.
    expect(await failure(send(ws))).toMatchObject({ retryable: false, message: expect.stringContaining("Reconnect Gmail") });
    expect({ api: fake.gmail.sent.length, installation: installation.messages.length, smtp: smtp.messages.length }).toEqual(before);
    // The other owner is untouched.
    await send(other);
    expect(fake.gmail.sent.at(-1)).toMatchObject({ user: BEN.email });
    // Reconnecting brings it back.
    await connect(ws, ANA);
    expect(await resolveSender(db, key, ws)).toMatchObject({ kind: "gmail_api" });
  });

  it("refreshes once after a 401 and sends the message once", async () => {
    const ws = await owner();
    await connect(ws);
    const calls = fake.oauth.google!.tokenCalls;
    const sent = fake.gmail.sent.length;
    fake.once(SEND, { status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } });
    await send(ws);
    expect(fake.oauth.google!.tokenCalls).toBe(calls + 1);
    expect(fake.gmail.sent.length).toBe(sent + 1);
  });

  it("backs off with Retry-After on 429 or a rate limit 403", async () => {
    const ws = await owner();
    await connect(ws);
    fake.once(SEND, { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, headers: { "retry-after": "120" } });
    expect(await failure(send(ws))).toMatchObject({ retryable: true, outcome: "throttled", retryAfterMs: 120_000 });
    fake.once(SEND, { status: 403, body: { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }, headers: { "retry-after": "30" } });
    expect(await failure(send(ws))).toMatchObject({ retryable: true, outcome: "throttled", retryAfterMs: 30_000 });
    // A quota answer is not a broken grant.
    expect(await readSender(db, ws)).toMatchObject({ status: "active" });
  });

  it("a timeout or a 5xx after the request left is unknown and is not resent", async () => {
    const ws = await owner();
    await connect(ws);
    const sent = fake.gmail.sent.length;
    fake.once(SEND, "hang-after");
    expect(await failure(send(ws))).toMatchObject({ retryable: false, outcome: "unknown" });
    expect(fake.gmail.sent.length).toBe(sent + 1);
    fake.once(SEND, { status: 503, body: { error: { code: 503 } } });
    expect(await failure(send(ws))).toMatchObject({ retryable: false, outcome: "unknown" });
    expect(await readSender(db, ws)).toMatchObject({ status: "active" });
  });

  it("claims the send after the token is fresh, and releases it as the request goes out", async () => {
    const ws = await owner();
    await connect(ws);
    const order: string[] = [];
    await send(ws, mail("customer@example.com"), { claim: async () => (order.push("claim"), () => order.push("release")) });
    expect(order).toEqual(["claim", "release"]);
  });

  it("counts recipients against the workspace's daily mailbox cap", async () => {
    const ws = await owner();
    await connect(ws);
    const before = process.env.MAILBOX_DAILY_CAP;
    process.env.MAILBOX_DAILY_CAP = "3";
    try {
      await send(ws, mail("a@example.com, b@example.com"), { capKey: "run-cap:email" });
      // The same step key again (a retry) is not counted twice.
      await send(ws, mail("a@example.com, b@example.com"), { capKey: "run-cap:email" });
      const sent = fake.gmail.sent.length;
      expect(await failure(send(ws, mail("c@example.com, d@example.com"), { capKey: "run-cap-2:email" }))).toMatchObject({ review: true, outcome: "not_sent" });
      expect(fake.gmail.sent.length).toBe(sent);
    } finally {
      if (before === undefined) delete process.env.MAILBOX_DAILY_CAP;
      else process.env.MAILBOX_DAILY_CAP = before;
    }
  });

  it("blocks, without falling back, when the installation no longer has a Google client", async () => {
    const ws = await owner();
    await connect(ws);
    const before = installation.messages.length;
    const err = await failure(sendAs(db, key, { ...deps, urls: { ...urls, googleOAuth: undefined } }, ws, mail("x@example.com"), "run-x:email:1"));
    expect(err).toMatchObject({ retryable: false, message: expect.stringContaining("Connect Gmail again") });
    expect(installation.messages.length).toBe(before);
  });
});

describe("the grant on mail_senders", () => {
  it("refreshes under a row lock on the mail_senders row: two senders at once refresh once", async () => {
    const ws = await owner();
    await connect(ws);
    const rejected = (await tokensOf(ws))[0]!;
    const calls = fake.oauth.google!.tokenCalls;
    const r = (await resolveSender(db, key, ws)) as { grant: { credential: string; revision: string } };
    const [a, b] = await Promise.all([
      freshToken(db, key, urls, ws, gmail, { ...r.grant }, { rejected }),
      freshToken(db, key, urls, ws, gmail, { ...r.grant }, { rejected }),
    ]);
    expect(a).toBe(b);
    expect(fake.oauth.google!.tokenCalls).toBe(calls + 1);
  });

  it("keeps an idle grant alive", async () => {
    const ws = await owner();
    await connect(ws);
    await db.update(mailSenders).set({ refreshedAt: sql`now() - interval '100 days'` }).where(eq(mailSenders.userId, ws));
    expect(await keepOAuthAlive(db, key, urls, [gmail])).toBeGreaterThanOrEqual(1);
    expect((await sender(ws))!.refreshedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("disconnect blocks the sender first, then revokes the grant at Google", async () => {
    const ws = await owner();
    await connect(ws);
    const [, refresh] = await tokensOf(ws);
    expect(await disconnectOAuth(db, key, urls, ws, gmail)).toEqual({ removed: true, revoked: true });
    expect(fake.oauth.google!.revoked).toContain(refresh);
    expect(await sender(ws)).toMatchObject({ status: "disconnected", passwordCiphertext: null });
    expect(await resolveSender(db, key, ws)).toMatchObject({ kind: "blocked" });
    fake.oauth.google!.revokeStatus = 500;
    await connect(ws);
    expect(await disconnectOAuth(db, key, urls, ws, gmail)).toEqual({ removed: true, revoked: false });
    fake.oauth.google!.revokeStatus = 200;
    // An app password has nothing to revoke.
    await connectGmail(db, key, ws, { address: "ana.cruz@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    expect(await disconnectOAuth(db, key, urls, ws, gmail)).toEqual({ removed: true, revoked: null });
  });

  it("keeps tokens out of errors, logs and history (R3, R4)", async () => {
    const ws = await owner();
    await connect(ws);
    const tokens = await tokensOf(ws);
    expect(tokens.length).toBe(2);
    // The history hider has them, so run history, Activity, CSV and the delivery list show [secret].
    expect(await secretValuesToHide(db, key, ws)).toEqual(expect.arrayContaining(tokens));
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" "))));
    const errors: string[] = [];
    try {
      for (const b of [{ status: 429, body: { error: { message: tokens[0] } } }, { status: 400, body: { error: { message: tokens[0] } } }, { status: 500, body: { error: { message: tokens[1] } } }] as const) {
        fake.once(SEND, b);
        const e = await failure(send(ws));
        errors.push(e.message, String((e.cause as Error | undefined)?.message));
      }
      for (const t of tokens) fake.oauth.google!.accessTokens.delete(t);
      fake.oauth.google!.refreshTokens.clear();
      errors.push((await failure(send(ws))).message, (await readSender(db, ws))!.lastError!);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    for (const t of tokens) {
      expect(errors.join("\n")).not.toContain(t);
      expect(logged.join("\n")).not.toContain(t);
    }
  });
});
