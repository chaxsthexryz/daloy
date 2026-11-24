import { randomBytes } from "node:crypto";
import { joinWorkspace, mailSenders, sessions, smtpMailer, users, type Db, type MailDeps } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { startFakeSmtp } from "../../../test/fake-smtp";
import { createApp } from "./app";
import { sha256 } from "./http";

// Decision 0063: Connect Gmail with Google, through the shared start and callback routes, against the fake Google
// OAuth app and the fake Gmail API.
let app: INestApplication;
let plain: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let installation: Awaited<ReturnType<typeof startFakeSmtp>>;
const secretsKey = randomBytes(32);
const ANA = { id: "google-ana", email: "ana.lim@gmail.com" };
const BEN = { id: "google-ben", email: "ben.lim@gmail.com" };
let seq = 0;
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  installation = await startFakeSmtp();
  const g = fake.addOAuthApp("google", { rotation: "none" });
  const mail: MailDeps = { installation: smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(installation.port) }), gmail: () => smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: "9" }).transport, sharedMail: "open" };
  const providers = { ...fake.urls, timeoutMs: 2000, googleOAuth: { clientId: g.clientId, clientSecret: g.clientSecret, ...fake.oauthUrls("google") } };
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000", mail, providers });
  await app.init();
  server = app.getHttpServer();
  plain = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000", mail, providers: { ...fake.urls, timeoutMs: 2000 } });
  await plain.init();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await plain?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await installation?.close();
  await pool?.end();
});

beforeEach(() => {
  Object.assign(fake.oauth.google!, { consent: "grant", user: ANA, emailVerified: true, grantScopes: [], revokeStatus: 200 });
});

async function owner(s = server) {
  const agent = request.agent(s);
  const res = await agent.post("/auth/register").send({ email: `gmail${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string, email: `gmail${seq}@test.local` };
}
async function member(workspaceId: string, role: "operator" | "approver" | "requester") {
  const [u] = await db.insert(users).values({ email: `${role}${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}
/** Connect Gmail: kymavo's start, the fake consent page, then the shared callback. Returns where the browser lands. */
async function connect(agent: Agent, who = ANA) {
  fake.oauth.google!.user = who;
  const { body } = await agent.post("/settings/connections/gmail/oauth/start").expect(200);
  expect(body.url).toContain("gmail.send");
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  return (await agent.get(back.pathname + back.search).expect(302)).headers.location as string;
}
const row = async (ws: string) => (await db.select().from(mailSenders).where(eq(mailSenders.userId, ws)))[0];

describe("Connect Gmail with Google", () => {
  it("connects, lists Gmail as configured, and sends the test email to the owner's own address with no confirmation link", async () => {
    const { agent, id } = await owner();
    expect((await agent.get("/settings/connections").expect(200)).body.oauth).toContain("gmail");
    expect(await connect(agent)).toBe("/#/apps/gmail-connected");
    expect((await agent.get("/settings/email").expect(200)).body.sender).toMatchObject({ address: ANA.email, status: "active", authMethod: "oauth", lastError: null });
    const before = installation.messages.length;
    const test = await agent.post("/settings/email/test").expect(200);
    expect(test.body).toEqual({ ok: true, to: ANA.email, from: ANA.email, gmail: true, needsConfirmation: false });
    expect(fake.gmail.sent.at(-1)).toMatchObject({ user: ANA.email });
    expect(fake.gmail.sent.at(-1)!.raw).toContain(`To: ${ANA.email}`);
    expect(fake.gmail.sent.at(-1)!.raw).not.toContain("verify-sender");
    expect(installation.messages.length).toBe(before);
    // The page never sees a token.
    const page = JSON.stringify((await agent.get("/settings/email").expect(200)).body);
    expect(page).not.toMatch(/google-access|google-refresh|Ciphertext/);
    expect((await row(id))!.passwordCiphertext).toBeTruthy();
  });

  it("lands on a closed outcome for a decline, a missing gmail.send and an unverified address, and saves nothing", async () => {
    const { agent, id } = await owner();
    fake.oauth.google!.consent = "declined";
    expect(await connect(agent)).toBe("/#/apps/gmail-declined");
    Object.assign(fake.oauth.google!, { consent: "narrow", grantScopes: ["openid", "email"] });
    expect(await connect(agent)).toBe("/#/apps/gmail-missing_scope");
    Object.assign(fake.oauth.google!, { consent: "grant", emailVerified: false });
    expect(await connect(agent)).toBe("/#/apps/gmail-failed");
    expect(await row(id)).toBeUndefined();
  });

  it("a reconnect with another Google account sends from the new address", async () => {
    const { agent } = await owner();
    await connect(agent, ANA);
    await connect(agent, BEN);
    expect((await agent.post("/settings/email/test").expect(200)).body).toMatchObject({ ok: true, to: BEN.email, from: BEN.email });
  });

  it("after Google refuses the grant, the test email says Reconnect Gmail and nothing goes out another way", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    fake.oauth.google!.accessTokens.clear();
    fake.oauth.google!.refreshTokens.clear();
    const before = { api: fake.gmail.sent.length, installation: installation.messages.length };
    expect((await agent.post("/settings/email/test").expect(200)).body).toMatchObject({ ok: false, error: expect.stringContaining("Reconnect Gmail") });
    expect(await row(id)).toMatchObject({ status: "failed" });
    expect({ api: fake.gmail.sent.length, installation: installation.messages.length }).toEqual(before);
    expect(await connect(agent)).toBe("/#/apps/gmail-connected");
    expect(await row(id)).toMatchObject({ status: "active", lastError: null });
  });

  it("Disconnect blocks mail and revokes at Google; the local server choice also revokes", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    expect((await agent.post("/settings/email/disconnect").expect(200)).body).toEqual({ revoked: true });
    expect(await row(id)).toMatchObject({ status: "disconnected", passwordCiphertext: null });
    expect((await agent.post("/settings/email/test").expect(200)).body).toMatchObject({ ok: false, error: expect.stringContaining("disconnected") });
    await connect(agent);
    const revoked = fake.oauth.google!.revoked.length;
    await agent.delete("/settings/email/gmail").expect(204);
    expect(fake.oauth.google!.revoked.length).toBe(revoked + 1);
    expect(await row(id)).toBeUndefined();
    // An app password still disconnects with 204, as before.
    await agent.put("/settings/email/gmail").send({ address: "ana.lim@gmail.com", appPassword: "abcd efgh ijkl mnop" }).expect(200);
    await agent.post("/settings/email/disconnect").expect(204);
  });

  it("only the owner can start it, and an installation without a Google client offers no Gmail sign-in", async () => {
    const { id } = await owner();
    for (const role of ["operator", "approver", "requester"] as const) {
      const m = await member(id, role);
      await m.post("/settings/connections/gmail/oauth/start").expect(403);
      await m.post("/settings/email/disconnect").expect(403);
    }
    await request(server).post("/settings/connections/gmail/oauth/start").expect(401);
    const other = await owner(plain.getHttpServer());
    expect((await other.agent.get("/settings/connections").expect(200)).body.oauth).not.toContain("gmail");
    await other.agent.post("/settings/connections/gmail/oauth/start").expect(400);
  });
});
