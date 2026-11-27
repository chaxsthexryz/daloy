import { randomBytes } from "node:crypto";
import { adminActions, businessProfiles, feedback, joinWorkspace, mailDeps, sessions, smtpMailer, users, type Db, type MailDeps } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeSmtp } from "../../../test/fake-smtp";
import { createApp } from "./app";
import { sha256 } from "./http";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let smtp: Awaited<ReturnType<typeof startFakeSmtp>>;

const PASSWORD = "correct horse battery";
const ADMIN = "boss@daloy.test";
const ORIGIN = "http://localhost:3000";

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  smtp = await startFakeSmtp();
  const mail: MailDeps = { ...mailDeps({}), installation: smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port) }) };
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, mail, platformAdmins: ADMIN, publicUrl: ORIGIN });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
  await smtp?.close();
});

let seq = 0;
async function signUp() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `owner${++seq}@test.local`, password: PASSWORD }).expect(201);
  return { agent, id: res.body.id as string, email: `owner${seq}@test.local` };
}

async function member(workspaceId: string, role: "operator" | "approver" | "requester") {
  const [u] = await db.insert(users).values({ email: `member${++seq}@test.local`, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return { agent: request.agent(server).set("Cookie", `daloy_session=${token}`), id: u!.id };
}

async function admin() {
  const [u] = await db.insert(users).values({ email: ADMIN, passwordHash: await hash(PASSWORD) }).onConflictDoNothing().returning();
  if (u) await joinWorkspace(db, u.id, u.id, "owner");
  const agent = request.agent(server);
  await agent.post("/auth/login").send({ email: ADMIN, password: PASSWORD }).expect(200);
  return agent;
}

const send = (agent: ReturnType<typeof request.agent>, body: object = { topic: "idea", message: "Please add a dark mode." }) => agent.post("/support/feedback").send(body);

describe("sending feedback", () => {
  it("stores a message for the sender's workspace and lists it back as new", async () => {
    const owner = await signUp();
    const res = await send(owner.agent).expect(201);
    expect(res.body).toMatchObject({ topic: "idea", message: "Please add a dark mode.", status: "new", reply: null, repliedAt: null });
    const list = await owner.agent.get("/support/feedback").expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(res.body.id);
  });

  it("lets every role send, approvers and requesters included", async () => {
    const owner = await signUp();
    for (const role of ["operator", "approver", "requester"] as const) await send((await member(owner.id, role)).agent).expect(201);
    expect((await owner.agent.get("/support/feedback").expect(200)).body.items).toHaveLength(3);
  });

  it("rejects bad input at the boundary", async () => {
    const { agent } = await signUp();
    await send(agent, { topic: "rant", message: "hi" }).expect(400);
    await send(agent, { topic: "bug", message: "   " }).expect(400);
    await send(agent, { topic: "bug", message: "x".repeat(2001) }).expect(400);
    await send(agent, { topic: "bug", message: "ok", status: "closed" }).expect(400);
    await send(agent, { topic: "bug", message: "x".repeat(2000) }).expect(201);
  });

  it("needs a session", async () => {
    await send(request(server)).expect(401);
    await request(server).get("/support/feedback").expect(401);
  });

  it("allows 5 messages an hour per user, and a colleague has their own count", async () => {
    const owner = await signUp();
    const other = await member(owner.id, "operator");
    for (let i = 0; i < 5; i++) await send(owner.agent).expect(201);
    await send(owner.agent).expect(429);
    await send(other.agent).expect(201);
  });

  it("shows a member only their own workspace's messages, with the reply", async () => {
    const a = await signUp();
    const b = await signUp();
    const mine = (await send(a.agent, { topic: "bug", message: "Workspace A message" })).body;
    await send(b.agent, { topic: "bug", message: "Workspace B message" });
    await db.update(feedback).set({ status: "replied", reply: "We fixed it.", repliedAt: new Date() }).where(eq(feedback.id, mine.id));
    const seen = (await (await member(a.id, "requester")).agent.get("/support/feedback").expect(200)).body.items;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ message: "Workspace A message", status: "replied", reply: "We fixed it." });
    expect(seen[0].repliedAt).toBeTruthy();
  });

  it("the database refuses a topic, status or message length outside the allowed set", async () => {
    const o = await signUp();
    const row = { workspaceId: o.id, senderId: o.id, topic: "bug" as const, message: "ok" };
    await expect(db.insert(feedback).values({ ...row, topic: "rant" as never })).rejects.toThrow();
    await expect(db.insert(feedback).values({ ...row, status: "open" as never })).rejects.toThrow();
    await expect(db.insert(feedback).values({ ...row, message: "x".repeat(2001) })).rejects.toThrow();
  });
});

describe("the admin inbox", () => {
  it("answers 404 to everyone who is not a platform admin, even a workspace owner", async () => {
    const owner = await signUp();
    const m = (await send(owner.agent)).body.id as string;
    for (const call of [(a: typeof owner.agent) => a.get("/admin/feedback"), (a: typeof owner.agent) => a.put(`/admin/feedback/${m}/reply`).set("Origin", ORIGIN).send({ reply: "hi" }), (a: typeof owner.agent) => a.put(`/admin/feedback/${m}/close`).set("Origin", ORIGIN)]) {
      await call(owner.agent).expect(404);
      await call(request.agent(server) as typeof owner.agent).expect(404);
    }
  });

  it("lists items with workspace name and sender email, filtered by status", async () => {
    const owner = await signUp();
    await db.insert(businessProfiles).values({ userId: owner.id, businessName: "Lola's Bakeshop" });
    const op = await member(owner.id, "operator");
    const one = (await send(op.agent, { topic: "billing", message: "Where is my invoice?" })).body.id as string;
    await send(owner.agent, { topic: "bug", message: "Second one" });
    const boss = await admin();
    const all = (await boss.get("/admin/feedback").expect(200)).body.items as Record<string, unknown>[];
    const item = all.find((i) => i.id === one)!;
    expect(item).toEqual({ id: one, workspaceId: owner.id, workspaceName: "Lola's Bakeshop", senderEmail: expect.stringMatching(/^member\d+@test\.local$/), topic: "billing", message: "Where is my invoice?", status: "new", reply: null, createdAt: expect.any(String), repliedAt: null });
    await boss.put(`/admin/feedback/${one}/close`).set("Origin", ORIGIN).expect(200);
    const closed = (await boss.get("/admin/feedback?status=closed").expect(200)).body.items as { id: string }[];
    expect(closed.map((i) => i.id)).toContain(one);
    const fresh = (await boss.get("/admin/feedback?status=new").expect(200)).body.items as { id: string }[];
    expect(fresh.map((i) => i.id)).not.toContain(one);
    await boss.get("/admin/feedback?status=bogus").expect(400);
  });

  it("a reply is stored, emailed to the sender and recorded in admin_actions", async () => {
    const owner = await signUp();
    const sender = await member(owner.id, "requester");
    const id = (await send(sender.agent, { topic: "question", message: "How do I add a teammate?" })).body.id as string;
    const [senderRow] = await db.select().from(users).where(eq(users.id, sender.id));
    const boss = await admin();
    const before = smtp.messages.length;
    const res = await boss.put(`/admin/feedback/${id}/reply`).set("Origin", ORIGIN).send({ reply: "Use Settings, then Team." }).expect(200);
    expect(res.body).toMatchObject({ id, status: "replied", reply: "Use Settings, then Team.", emailed: true });
    expect(smtp.messages).toHaveLength(before + 1);
    const mail = smtp.messages.at(-1)!;
    expect(mail.to).toEqual([senderRow!.email]);
    expect(mail.raw).toContain("Use Settings, then Team.");
    expect((await sender.agent.get("/support/feedback").expect(200)).body.items[0]).toMatchObject({ status: "replied", reply: "Use Settings, then Team." });
    const [row] = await db.select().from(adminActions).where(eq(adminActions.action, "feedback_reply"));
    expect(row).toMatchObject({ adminEmail: ADMIN, workspaceId: owner.id, before: { feedbackId: id, status: "new" }, after: { feedbackId: id, status: "replied" } });
    // The audit row names the message, never its text.
    expect(JSON.stringify(row)).not.toContain("teammate");
  });

  it("closing sets the status and records an audit row", async () => {
    const owner = await signUp();
    const id = (await send(owner.agent)).body.id as string;
    const boss = await admin();
    const res = await boss.put(`/admin/feedback/${id}/close`).set("Origin", ORIGIN).expect(200);
    expect(res.body).toMatchObject({ id, status: "closed" });
    const rows = (await db.select().from(adminActions)).filter((r) => r.action === "feedback_close" && r.workspaceId === owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ before: { feedbackId: id, status: "new" }, after: { feedbackId: id, status: "closed" } });
  });

  it("refuses a closed message's reply, an empty reply, an unknown id and a foreign origin", async () => {
    const owner = await signUp();
    const id = (await send(owner.agent)).body.id as string;
    const boss = await admin();
    await boss.put(`/admin/feedback/${id}/reply`).set("Origin", ORIGIN).send({ reply: "  " }).expect(400);
    await boss.put(`/admin/feedback/${id}/reply`).set("Origin", "https://evil.example").send({ reply: "hi" }).expect(403);
    await boss.put(`/admin/feedback/00000000-0000-4000-8000-000000000000/reply`).set("Origin", ORIGIN).send({ reply: "hi" }).expect(404);
    await boss.put(`/admin/feedback/${id}/close`).set("Origin", ORIGIN).expect(200);
    await boss.put(`/admin/feedback/${id}/reply`).set("Origin", ORIGIN).send({ reply: "too late" }).expect(409);
    expect((await db.select().from(feedback).where(eq(feedback.id, id)))[0]!.reply).toBeNull();
  });
});
