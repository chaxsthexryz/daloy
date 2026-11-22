import { randomBytes } from "node:crypto";
import { connections, joinWorkspace, sessions, users, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";
import { sha256 } from "./http";

// Phase I1, decision 0104: the Discord connection and the template check for Make a document. Fake providers only.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
const secretsKey = randomBytes(32);
const ANA = { id: "google-ana", email: "ana@shop.example" };
const TEMPLATE = "1InvoiceTemplateDocId01";
const FOLDER = "1InvoiceFolderIdForTests";
const TOKEN = "fake-webhook-token-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
let seq = 0;
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  const g = fake.addOAuthApp("google", { rotation: "none" });
  fake.oauth.google!.user = ANA;
  const googleOAuth = { clientId: g.clientId, clientSecret: g.clientSecret, ...fake.oauthUrls("google"), pickerApiKey: "picker-key-synthetic", projectNumber: "123456789012" };
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000", providers: { ...fake.urls, timeoutMs: 2000, googleOAuth } });
  await app.init();
  server = app.getHttpServer();
  fake.addDocsTemplate(TEMPLATE, "Invoice template", "Invoice for {{name}}", [ANA.email]);
  fake.addDriveFolder(FOLDER, "Invoices", [ANA.email], null);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `i1-${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}
async function operator(workspaceId: string) {
  const [u] = await db.insert(users).values({ email: `op${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, "operator");
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}
async function connectDrive(agent: Agent) {
  const { body } = await agent.post("/settings/connections/google-drive/oauth/start").expect(200);
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  await agent.get(back.pathname + back.search).expect(302);
}
const publish = async (agent: Agent, steps: object[], edges: object[] = []) => {
  const wf = await agent.post("/workflows").send({ name: "I1", slug: `i1-${++seq}` }).expect(201);
  return agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: { trigger: { type: "manual", config: {} }, steps, edges }, publish: true });
};

describe("Discord connection", () => {
  it("stores the webhook URL encrypted and never returns it", async () => {
    const { agent, id } = await owner();
    const hook = fake.addDiscordWebhook();
    const res = await agent.put("/settings/connections/discord").send({ url: hook, channelName: "orders" }).expect(200);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(res.body.connections).toEqual([expect.objectContaining({ provider: "discord", authMethod: "webhook_url", account: "orders", destination: { channelName: "orders" } })]);
    const [row] = await db.select().from(connections).where(and(eq(connections.userId, id), eq(connections.provider, "discord")));
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify((await agent.get("/settings/connections").expect(200)).body)).not.toContain(TOKEN);
  });

  it.each([
    ["another host", `https://example.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["a lookalike host", `https://discord.com.evil.example/api/webhooks/123456789012345678/${TOKEN}`],
    ["plain http", `http://discord.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["a channel link, not a webhook", "https://discord.com/channels/123456789012345678/123456789012345679"],
    ["a private address", `http://169.254.169.254/api/webhooks/123456789012345678/${TOKEN}`],
  ])("refuses %s and does not echo it", async (_what, url) => {
    const { agent, id } = await owner();
    const res = await agent.put("/settings/connections/discord").send({ url, channelName: "orders" }).expect(400);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(await db.select().from(connections).where(eq(connections.userId, id))).toEqual([]);
  });

  it("is for owners only", async () => {
    const { id } = await owner();
    const op = await operator(id);
    await op.put("/settings/connections/discord").send({ url: fake.addDiscordWebhook(), channelName: "orders" }).expect(403);
    await op.post("/settings/connections/discord/test").expect(403);
  });

  it("sends a test message to the channel", async () => {
    const { agent } = await owner();
    await agent.put("/settings/connections/discord").send({ url: fake.addDiscordWebhook(), channelName: "orders" }).expect(200);
    const before = fake.discord.posts.length;
    const res = await agent.post("/settings/connections/discord/test").expect(200);
    expect(res.body).toMatchObject({ ok: true, posted: true });
    expect(fake.discord.posts.slice(before)[0]!.content).toMatch(/^Test message from Daloy/);
  });

  it("reports a deleted webhook, marks the connection failed and keeps the URL out of the answer", async () => {
    const { agent, id } = await owner();
    const token = "gone-webhook-token-AbCdEfGhIjKlMnOpQrStUvWxYz0123456";
    const hook = fake.addDiscordWebhook("323456789012345678", token);
    await agent.put("/settings/connections/discord").send({ url: hook, channelName: "orders" }).expect(200);
    fake.discord.hooks.delete("323456789012345678");
    const res = await agent.post("/settings/connections/discord/test").expect(200);
    expect(res.body).toMatchObject({ ok: false, error: expect.stringMatching(/deleted|new webhook/i) });
    expect(JSON.stringify(res.body)).not.toContain(token);
    const [row] = await db.select().from(connections).where(and(eq(connections.userId, id), eq(connections.provider, "discord")));
    expect(row!.status).toBe("failed");
  });

  it("needs a working connection before a workflow with a Discord step is turned on", async () => {
    const { agent } = await owner();
    const step = { id: "ping", type: "discord", config: { text: "New order" } };
    const res = await publish(agent, [step]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Connect Discord/);
    await agent.put("/settings/connections/discord").send({ url: fake.addDiscordWebhook(), channelName: "orders" }).expect(200);
    expect((await publish(agent, [step])).status).toBe(201);
  });
});

describe("Make a document: template check and publish", () => {
  it("reads a picked template with the Drive grant and returns its name, saving nothing", async () => {
    const { agent, id } = await owner();
    await connectDrive(agent);
    const before = await db.select().from(connections).where(eq(connections.userId, id));
    const res = await agent.post("/settings/connections/google-drive/template").send({ templateId: TEMPLATE }).expect(200);
    expect(res.body).toEqual({ templateId: TEMPLATE, title: "Invoice template" });
    expect(await db.select().from(connections).where(eq(connections.userId, id))).toEqual(before);
  });

  it("refuses a folder, a file this Google account never picked, and a malformed id", async () => {
    const { agent } = await owner();
    await connectDrive(agent);
    await agent.post("/settings/connections/google-drive/template").send({ templateId: FOLDER }).expect(400);
    const other = await agent.post("/settings/connections/google-drive/template").send({ templateId: "1NotPickedByThisAccount" }).expect(400);
    expect(other.body.message).toMatch(/pick the template again/i);
    await agent.post("/settings/connections/google-drive/template").send({ templateId: "../etc/passwd" }).expect(400);
    await agent.post("/settings/connections/google-drive/template").send({ templateId: TEMPLATE, extra: 1 }).expect(400);
  });

  it("needs Google Drive connected, with a Google sign-in, and is for owners only", async () => {
    const { agent, id } = await owner();
    await agent.post("/settings/connections/google-drive/template").send({ templateId: TEMPLATE }).expect(404);
    await connectDrive(agent);
    const op = await operator(id);
    await op.post("/settings/connections/google-drive/template").send({ templateId: TEMPLATE }).expect(403);
  });

  it("needs Drive with a Google sign-in and a folder before a Make a document step is turned on", async () => {
    const { agent } = await owner();
    const step = { id: "make_doc", type: "google_docs", config: { templateId: TEMPLATE, templateName: "Invoice template", name: "Invoice", values: { name: "Ana" } } };
    const a = await publish(agent, [step]);
    expect([a.status, a.body.message]).toEqual([400, expect.stringMatching(/Connect Google Drive with Google/)]);
    await connectDrive(agent);
    const b = await publish(agent, [step]);
    expect([b.status, b.body.message]).toEqual([400, expect.stringMatching(/pick a folder/)]);
    await agent.post("/settings/connections/google-drive/pick").send({ folderId: FOLDER }).expect(200);
    expect((await publish(agent, [step])).status).toBe(201);
  });

  it("lets a drafted workflow with the step be saved before anything is connected", async () => {
    const { agent } = await owner();
    const wf = await agent.post("/workflows").send({ name: "Draft", slug: `d-${++seq}` }).expect(201);
    await agent
      .post(`/workflows/${wf.body.id}/versions`)
      .send({ definition: { trigger: { type: "manual", config: {} }, steps: [{ id: "make_doc", type: "google_docs", config: { templateId: TEMPLATE, name: "Invoice" } }], edges: [] }, publish: false })
      .expect(201);
  });
});
