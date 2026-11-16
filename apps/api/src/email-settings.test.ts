import { randomBytes } from "node:crypto";
import { approveSharedMail, mailSenders, readSender, resolveSender, smtpMailer, users, type Db, type MailDeps } from "@daloy/db";
import { websiteInquiryDefinition } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeSmtp } from "../../../test/fake-smtp";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { installationLocal } from "./email-settings";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let gmail: Awaited<ReturnType<typeof startFakeSmtp>>;
let installation: Awaited<ReturnType<typeof startFakeSmtp>>;
const key = randomBytes(32);
let seq = 0;
const REJECTED = "zzzzzzzzzzzzzzzz";
let mail: MailDeps;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  gmail = await startFakeSmtp(new Set([REJECTED]));
  installation = await startFakeSmtp();
  mail = {
    installation: smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(installation.port) }),
    // The fake stands in for smtp.gmail.com; the login is the owner's address and app password, as with the real one.
    gmail: (auth) => smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(gmail.port), SMTP_USER: auth.user, SMTP_PASS: auth.pass }).transport,
    sharedMail: "open",
  };
  app = await createApp({ db, boss, secretsKey: key, secureCookies: false, mail, publicUrl: "https://daloy.example.com" });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await gmail?.close();
  await installation?.close();
  await pool?.end();
});

const signedIn = async () => {
  const email = `owner${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { agent, email, userId: user!.id };
};
const profile = { businessName: "Lim Dental", website: "https://limdental.example", inquiryEmail: "front@limdental.example", replyTo: "hello@limdental.example" };
// Quoted-printable splits long lines with "=" at the end; drop those soft breaks before reading the link.
const lastText = () => gmail.messages.at(-1)!.raw.replace(/=\r?\n/g, "");
const lastLink = () => /verify-sender\/([A-Za-z0-9_-]{43})/.exec(lastText())?.[1];

describe("email settings", () => {
  it("needs a session", async () => {
    await request(server).get("/settings/email").expect(401);
    await request(server).put("/settings/email/gmail").send({ address: "a@gmail.com", appPassword: "abcdefghijklmnop" }).expect(401);
  });

  it("saves the business profile and validates it", async () => {
    const { agent } = await signedIn();
    expect((await agent.get("/settings/email").expect(200)).body).toMatchObject({ profile: null, sender: null, installationFrom: "daloy@localhost", installationAllowed: true });
    await agent.put("/settings/email/profile").send(profile).expect(204);
    expect((await agent.get("/settings/email").expect(200)).body.profile).toEqual(profile);
    await agent.put("/settings/email/profile").send({ ...profile, businessName: "{{secrets.x}}" }).expect(400);
    await agent.put("/settings/email/profile").send({ ...profile, website: "javascript:alert(1)" }).expect(400);
  });

  it("stores the app password write-only and starts unconfirmed", async () => {
    const { agent, userId } = await signedIn();
    const res = await agent.put("/settings/email/gmail").send({ address: "lim.dental@gmail.com", appPassword: "abcd efgh ijkl mnop" }).expect(200);
    expect(res.body).toMatchObject({ address: "lim.dental@gmail.com", status: "unverified" });
    const body = JSON.stringify((await agent.get("/settings/email").expect(200)).body);
    expect(body).not.toContain("abcdefghijklmnop");
    expect(body).not.toContain("Ciphertext");
    await agent.put("/settings/email/gmail").send({ address: "lim.dental@gmail.com", appPassword: "my-real-password" }).expect(400);
    expect(await resolveSender(db, key, userId)).toMatchObject({ kind: "blocked" });
  });

  it("sends the test email to the Gmail address with a one-time link that confirms the sender", async () => {
    const { agent, userId } = await signedIn();
    await agent.put("/settings/email/profile").send(profile).expect(204);
    await agent.put("/settings/email/gmail").send({ address: "lim.dental@gmail.com", appPassword: "abcd efgh ijkl mnop" }).expect(200);
    const test = await agent.post("/settings/email/test").expect(200);
    expect(test.body).toEqual({ ok: true, to: "lim.dental@gmail.com", from: "lim.dental@gmail.com", replyTo: "hello@limdental.example", gmail: true, needsConfirmation: true });
    expect(gmail.messages.at(-1)).toMatchObject({ user: "lim.dental@gmail.com", to: ["lim.dental@gmail.com"] });
    const token = lastLink()!;
    expect(lastText()).toContain("https://daloy.example.com/#/verify-sender/");

    await agent.post("/settings/email/verify").send({ token }).expect(204);
    expect(await readSender(db, userId)).toMatchObject({ status: "active" });
    // One use only.
    await agent.post("/settings/email/verify").send({ token }).expect(400);
    // A confirmed sender's next test carries no link.
    expect((await agent.post("/settings/email/test").expect(200)).body).toMatchObject({ ok: true, needsConfirmation: false });
    expect(lastText()).not.toContain("verify-sender");
  });

  it("a link sent to one owner cannot confirm another owner's sender", async () => {
    const a = await signedIn();
    const b = await signedIn();
    await a.agent.put("/settings/email/gmail").send({ address: "a.shop@gmail.com", appPassword: "aaaa aaaa aaaa aaaa" }).expect(200);
    await b.agent.put("/settings/email/gmail").send({ address: "b.shop@gmail.com", appPassword: "bbbb bbbb bbbb bbbb" }).expect(200);
    await a.agent.post("/settings/email/test").expect(200);
    const token = lastLink()!;
    await b.agent.post("/settings/email/verify").send({ token }).expect(400);
    expect(await readSender(db, b.userId)).toMatchObject({ status: "unverified" });
    await request(server).post("/settings/email/verify").send({ token }).expect(401);
    await a.agent.post("/settings/email/verify").send({ token }).expect(204);
  });

  it("reports a rejected app password without falling back, and marks the sender failed", async () => {
    const { agent, userId } = await signedIn();
    await agent.put("/settings/email/gmail").send({ address: "wrong.pass@gmail.com", appPassword: REJECTED }).expect(200);
    const before = installation.messages.length;
    const res = await agent.post("/settings/email/test").expect(200);
    expect(res.body).toMatchObject({ ok: false, error: expect.stringContaining("rejected the app password") });
    expect(installation.messages).toHaveLength(before);
    expect(await readSender(db, userId)).toMatchObject({ status: "failed" });
  });

  it("without Gmail, sends the test email to the sign-in address through the installation server", async () => {
    const { agent, email } = await signedIn();
    const res = await agent.post("/settings/email/test").expect(200);
    expect(res.body).toEqual({ ok: true, to: email, from: "daloy@localhost", gmail: false, needsConfirmation: false });
    expect(installation.messages.at(-1)).toMatchObject({ user: undefined, to: [email] });
  });

  it("tells the page whether the installation's mail server is a local catcher", async () => {
    const { agent } = await signedIn();
    expect((await agent.get("/settings/email").expect(200)).body).toMatchObject({ installationLocal: true });
    expect(installationLocal(smtpMailer({ SMTP_HOST: "mailpit" }))).toBe(true);
    expect(installationLocal(smtpMailer({ SMTP_HOST: "smtp.example.com" }))).toBe(false);
  });

  it("with an approved-only shared server, a fresh sign-up's test email sends nothing and the page says so", async () => {
    mail.sharedMail = "approved";
    try {
      const { agent, userId } = await signedIn();
      expect((await agent.get("/settings/email").expect(200)).body).toMatchObject({ installationAllowed: false });
      const before = installation.messages.length;
      expect((await agent.post("/settings/email/test").expect(200)).body).toMatchObject({ ok: false, error: expect.stringContaining("Connect Gmail") });
      expect(installation.messages).toHaveLength(before);

      await approveSharedMail(db, userId, 5);
      expect((await agent.get("/settings/email").expect(200)).body).toMatchObject({ installationAllowed: true });
      expect((await agent.post("/settings/email/test").expect(200)).body).toMatchObject({ ok: true, gmail: false });
      expect(installation.messages).toHaveLength(before + 1);
    } finally {
      mail.sharedMail = "open";
    }
  });

  it("disconnect blocks sending and deletes the password; using the local server again removes the sender", async () => {
    const { agent, userId } = await signedIn();
    await agent.put("/settings/email/gmail").send({ address: "c.shop@gmail.com", appPassword: "cccc cccc cccc cccc" }).expect(200);
    await agent.post("/settings/email/disconnect").expect(204);
    const [row] = await db.select().from(mailSenders).where(eq(mailSenders.userId, userId));
    expect(row).toMatchObject({ status: "disconnected", passwordCiphertext: null });
    expect((await agent.post("/settings/email/test").expect(200)).body).toMatchObject({ ok: false, error: expect.stringContaining("disconnected") });
    await agent.delete("/settings/email/gmail").expect(204);
    expect(await resolveSender(db, key, userId)).toMatchObject({ kind: "installation" });
    await agent.post("/settings/email/disconnect").expect(404);
  });

  it("limits test emails", async () => {
    const { agent } = await signedIn();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await agent.post("/settings/email/test")).status);
    expect(codes).toContain(429);
  });
});

describe("hosted inquiry form", () => {
  it("shows the business name on the form page", async () => {
    const { agent } = await signedIn();
    await agent.put("/settings/email/profile").send({ ...profile, businessName: "Lim <Dental>" }).expect(204);
    const wf = (await agent.post("/workflows").send({ name: "Website inquiries", slug: "website-inquiries" }).expect(201)).body as { id: string };
    const definition = websiteInquiryDefinition({ businessName: "Lim Dental", inquiryEmail: profile.inquiryEmail });
    await agent.post(`/workflows/${wf.id}/versions`).send({ definition, publish: true }).expect(201);
    const detail = (await agent.get(`/workflows/${wf.id}`).expect(200)).body as { trigger: { id: string } };
    const page = await request(server).get(`/forms/${detail.trigger.id}`).expect(200);
    expect(page.text).toContain("<h1>Lim &lt;Dental&gt;</h1>");
    expect(page.text).toContain("<title>Lim &lt;Dental&gt;</title>");
  });
});
