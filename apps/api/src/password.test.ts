import { randomBytes } from "node:crypto";
import { passwordResets, sessions, smtpMailer, users, type Db, type MailDeps } from "@daloy/db";
import { builtInEmailCopy } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeSmtp } from "../../../test/fake-smtp";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let smtp: Awaited<ReturnType<typeof startFakeSmtp>>;
let seq = 0;
let ipSeq = 0;
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "another long passphrase";

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  smtp = await startFakeSmtp();
  const mail: MailDeps = {
    installation: smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port) }),
    gmail: () => {
      throw new Error("not used");
    },
    sharedMail: "open",
  };
  // trustProxy lets each request pick its own client IP, so the per-IP limits do not leak between tests.
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, mail, publicUrl: "https://daloy.example.com", trustProxy: 1 });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await smtp?.close();
  await pool?.end();
});

const nextIp = () => `203.0.113.${++ipSeq}`;
const from = (r: request.Test, ip: string) => r.set("X-Forwarded-For", ip);

async function account() {
  const email = `pw${++seq}@test.local`;
  const agent = request.agent(server).set("X-Forwarded-For", nextIp());
  await agent.post("/auth/register").send({ email, password: PASSWORD }).expect(201);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { agent, email, userId: user!.id };
}
/** A second signed-in browser for the same account. */
async function secondSession(email: string) {
  const agent = request.agent(server).set("X-Forwarded-For", nextIp());
  await agent.post("/auth/login").send({ email, password: PASSWORD }).expect(200);
  return agent;
}
const signIn = (email: string, password: string) => from(request(server).post("/auth/login"), nextIp()).send({ email, password });
const requestReset = (email: string, ip = nextIp()) => from(request(server).post("/auth/password-reset"), ip).send({ email });
const useReset = (token: string, password: string) => from(request(server).post(`/auth/password-reset/${token}`), nextIp()).send({ password });

// Quoted-printable splits long lines with "=" at the end; drop those soft breaks before reading the link.
const text = (m: { raw: string }) => m.raw.replace(/=\r?\n/g, "");
const mailsTo = (email: string) => smtp.messages.filter((m) => m.to.includes(email));
const tokenIn = (m: { raw: string }) => /#\/reset-password\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(text(m))?.[1];
/** Asks for a link and returns the token from the mail that arrives after the response. */
async function resetToken(email: string) {
  const before = mailsTo(email).length;
  await requestReset(email).expect(202);
  await vi.waitFor(() => expect(mailsTo(email)).toHaveLength(before + 1));
  return tokenIn(mailsTo(email).at(-1)!)!;
}
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("change password", () => {
  it("needs a session", async () => {
    await request(server).post("/auth/password").send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
  });

  it("refuses a wrong current password and a bad new one with 400, and stays signed in", async () => {
    const { agent } = await account();
    const wrong = await agent.post("/auth/password").send({ currentPassword: "not the password", newPassword: NEW_PASSWORD }).expect(400);
    expect(JSON.stringify(wrong.body)).toContain("current password is wrong");
    await agent.post("/auth/password").send({ currentPassword: PASSWORD, newPassword: "short" }).expect(400);
    await agent.post("/auth/password").send({ currentPassword: PASSWORD, newPassword: "x".repeat(201) }).expect(400);
    await agent.get("/auth/me").expect(200);
  });

  it("signs out other sessions but keeps this one, and swaps which password works", async () => {
    const { agent, email } = await account();
    const other = await secondSession(email);
    await other.get("/auth/me").expect(200);
    await agent.post("/auth/password").send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(204);
    await other.get("/auth/me").expect(401);
    await agent.get("/auth/me").expect(200);
    await signIn(email, PASSWORD).expect(401);
    await signIn(email, NEW_PASSWORD).expect(200);
  });

  it("leaves other accounts' sessions alone", async () => {
    const a = await account();
    const b = await account();
    await a.agent.post("/auth/password").send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(204);
    await b.agent.get("/auth/me").expect(200);
  });

  it("makes a link requested earlier useless", async () => {
    const { agent, email } = await account();
    const token = await resetToken(email);
    await agent.post("/auth/password").send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(204);
    await useReset(token, "a password nobody chose").expect(400);
    await signIn(email, NEW_PASSWORD).expect(200);
  });
});

describe("request a reset link", () => {
  it("answers a known and an unknown email the same way, and mails only the known one", async () => {
    const { email } = await account();
    const ghost = `ghost${++seq}@test.local`;
    const unknown = await requestReset(ghost);
    const known = await requestReset(email);
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect(known.body).toEqual({ ok: true });
    await vi.waitFor(() => expect(mailsTo(email)).toHaveLength(1));
    await settle();
    expect(mailsTo(ghost)).toEqual([]);
  });

  it("mails a 43 character token in the link fragment and stores only its hash", async () => {
    const { email, userId } = await account();
    const token = await resetToken(email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const mail = mailsTo(email)[0]!;
    expect(text(mail)).toContain(`https://daloy.example.com/#/reset-password/${token}`);
    expect(mail.from).toBe("daloy@localhost");
    const rows = await db.select().from(passwordResets).where(eq(passwordResets.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    const minutes = (rows[0]!.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it("writes the mail in the workspace language", async () => {
    const { email, userId } = await account();
    await resetToken(email);
    expect(mailsTo(email)[0]!.raw).toContain(`Subject: ${builtInEmailCopy("en").resetSubject}`);
    await db.update(users).set({ language: "tl" }).where(eq(users.id, userId));
    await resetToken(email);
    expect(mailsTo(email)[1]!.raw).toContain(`Subject: ${builtInEmailCopy("tl").resetSubject}`);
  });

  it("rejects a body that is not an email", async () => {
    await requestReset("not an email").expect(400);
  });
});

describe("use a reset link", () => {
  it("sets the password and signs out every session", async () => {
    const { agent, email } = await account();
    const other = await secondSession(email);
    const token = await resetToken(email);
    await useReset(token, NEW_PASSWORD).expect(204);
    await agent.get("/auth/me").expect(401);
    await other.get("/auth/me").expect(401);
    expect(await db.select().from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(eq(users.email, email))).toEqual([]);
    await signIn(email, PASSWORD).expect(401);
    await signIn(email, NEW_PASSWORD).expect(200);
  });

  it("works once", async () => {
    const { email } = await account();
    const token = await resetToken(email);
    await useReset(token, NEW_PASSWORD).expect(204);
    await useReset(token, "a third long passphrase").expect(400);
    await signIn(email, NEW_PASSWORD).expect(200);
  });

  it("keeps the link usable after a too-short password", async () => {
    const { email } = await account();
    const token = await resetToken(email);
    await useReset(token, "short").expect(400);
    await useReset(token, NEW_PASSWORD).expect(204);
  });

  it("refuses an expired link, and gives unknown, used and expired the same answer", async () => {
    const { email } = await account();
    const expired = await resetToken(email);
    await db.update(passwordResets).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(passwordResets.tokenHash, sha256(expired)));
    const used = await resetToken(email);
    await useReset(used, NEW_PASSWORD).expect(204);
    const bodies = [];
    for (const t of [expired, used, randomBytes(32).toString("base64url")]) {
      const res = await useReset(t, "a fourth long passphrase");
      expect(res.status).toBe(400);
      bodies.push(res.body);
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    await signIn(email, PASSWORD).expect(401);
  });

  it("keeps an older unused link alive when a new one is requested, then using either retires the other", async () => {
    const { email } = await account();
    const first = await resetToken(email);
    const second = await resetToken(email);
    expect(second).not.toBe(first);
    await useReset(first, NEW_PASSWORD).expect(204);
    await useReset(second, "a fifth long passphrase").expect(400);
    await signIn(email, NEW_PASSWORD).expect(200);
  });
});

describe("limits", () => {
  it("answers the 6th request from one IP within 15 minutes with 429", async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) await requestReset(`nobody${++seq}@test.local`, ip).expect(202);
    await requestReset(`nobody${++seq}@test.local`, ip).expect(429);
    await requestReset(`nobody${++seq}@test.local`, nextIp()).expect(202);
  });

  it("sends at most 3 mails an hour to one account, however many IPs ask", async () => {
    const { email, userId } = await account();
    const other = await account();
    for (let i = 0; i < 4; i++) await requestReset(email).expect(202);
    await vi.waitFor(() => expect(mailsTo(email)).toHaveLength(3));
    // A control request that does get mail shows the 4th has been handled by now.
    await requestReset(other.email).expect(202);
    await vi.waitFor(() => expect(mailsTo(other.email)).toHaveLength(1));
    await settle();
    expect(mailsTo(email)).toHaveLength(3);
    expect(await db.select().from(passwordResets).where(eq(passwordResets.userId, userId))).toHaveLength(3);
  });

  it("limits using a link to 10 a minute per IP", async () => {
    const ip = nextIp();
    const post = () => from(request(server).post(`/auth/password-reset/${randomBytes(32).toString("base64url")}`), ip).send({ password: NEW_PASSWORD });
    for (let i = 0; i < 10; i++) await post().expect(400);
    await post().expect(429);
  });
});
