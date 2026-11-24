import { randomBytes } from "node:crypto";
import { connections, joinWorkspace, pollRecordTriggers, sessions, users, type Db } from "@daloy/db";
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

// G5 (decision 0134): status route, usage reporting, and publish readiness check for Airtable, Notion, and Trello triggers.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let providers: Parameters<typeof createApp>[0]["providers"];
const secretsKey = randomBytes(32);
let seq = 0;
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  fake.airtable.token = "patTESTAPI512345.0123456789abcdef0123456789abcdef";
  fake.notion.token = "ntn_TESTAPI50123456789abcdefghijkl";
  fake.trello.key = "0123456789abcdef0123456789abcdef";
  fake.trello.token = "ATTAtestapi50123456789abcdefghijklmnop";
  providers = { ...fake.urls, ...fake.recordClients(), timeoutMs: 2000 };
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000", providers });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `g5api${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}

async function connectAirtablePat(agent: Agent) {
  await agent.put("/settings/connections/airtable").send({ token: fake.airtable.token, baseId: fake.airtable.base, tableId: fake.airtable.table }).expect(200);
}

async function connectNotionOAuth(agent: Agent) {
  const { body } = await agent.post("/settings/connections/notion/oauth/start").expect(200);
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  await agent.get(back.pathname + back.search).expect(302);
  await agent.put("/settings/connections/notion/target").send({ databaseId: fake.notion.database }).expect(204);
}

const airtableDef = { trigger: { type: "airtable_record", config: { on: "created" } }, steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }], edges: [] };
const notionDef = { trigger: { type: "notion_page", config: { on: "created" } }, steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }], edges: [] };
const trelloDef = { trigger: { type: "trello_card", config: { on: "moved_to_list" } }, steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }], edges: [] };

async function automation(agent: Agent) {
  const { body } = await agent.post("/workflows").send({ name: "Record flow", slug: `rec-flow-${++seq}` }).expect(201);
  return body.id as string;
}

describe("GET /triggers/records/:type", () => {
  it("reports missing connection, OAuth scope limits for Airtable, and readiness once connected", async () => {
    const { agent } = await owner();
    expect((await agent.get("/triggers/records/airtable_record").expect(200)).body).toMatchObject({
      app: "airtable",
      problem: "Airtable is not connected. Connect it in Apps.",
      destination: null,
      watching: null,
    });
    expect((await agent.get("/triggers/records/notion_page").expect(200)).body.problem).toBe("Notion is not connected. Connect it in Apps.");
    expect((await agent.get("/triggers/records/trello_card").expect(200)).body.problem).toBe("Trello is not connected. Connect it in Apps.");

    // Airtable OAuth lacks data.records:read; PAT with read scope is ready.
    const { body: oa } = await agent.post("/settings/connections/airtable/oauth/start").expect(200);
    const back = new URL((await fetch(oa.url as string, { redirect: "manual" })).headers.get("location")!);
    await agent.get(back.pathname + back.search).expect(302);
    await agent.put("/settings/connections/airtable/target").send({ baseId: fake.airtable.base, tableId: fake.airtable.table }).expect(204);
    expect((await agent.get("/triggers/records/airtable_record").expect(200)).body.problem).toMatch(/personal access token/);

    await connectAirtablePat(agent);
    expect((await agent.get("/triggers/records/airtable_record").expect(200)).body).toMatchObject({
      app: "airtable",
      problem: null,
      destination: fake.airtable.table,
    });
  });

  it("shows watcher status only inside the owning workspace and checks permissions", async () => {
    const { agent, id } = await owner();
    await connectNotionOAuth(agent);
    const wf = await automation(agent);
    await agent.post(`/workflows/${wf}/versions`).send({ definition: notionDef, publish: true }).expect(201);
    await pollRecordTriggers({ db, secretsKey, urls: providers!, enqueue: async () => {} });

    const { body } = await agent.get(`/triggers/records/notion_page?workflowId=${wf}`).expect(200);
    expect(body.watching).toMatchObject({ problem: null, failures: 0, started: true });
    expect(body.destination).toBe(fake.notion.title);

    const other = await owner();
    expect((await other.agent.get(`/triggers/records/notion_page?workflowId=${wf}`).expect(200)).body.watching).toBeNull();

    await agent.get("/triggers/records/webhook").expect(400);
    await agent.get("/triggers/records/notion_page?workflowId=nope").expect(400);

    const [u] = await db.insert(users).values({ email: `req-g5-${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
    await joinWorkspace(db, u!.id, id, "requester");
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    await request.agent(server).set("Cookie", `daloy_session=${token}`).get("/triggers/records/notion_page").expect(403);
  });
});

describe("publishing record triggers and connection usage", () => {
  it("refuses publish until connected and ready, allows drafts, and reports usage in GET /settings/connections", async () => {
    const { agent, id } = await owner();
    const wfA = await automation(agent);
    const wfT = await automation(agent);

    const refused = await agent.post(`/workflows/${wfA}/versions`).send({ definition: airtableDef, publish: true }).expect(400);
    expect(refused.body.message).toBe("Airtable is not connected. Connect it in Apps.");
    await agent.post(`/workflows/${wfA}/versions`).send({ definition: airtableDef, publish: false }).expect(201);

    await connectAirtablePat(agent);
    await agent.post(`/workflows/${wfA}/versions`).send({ definition: airtableDef, publish: true }).expect(201);

    // Trello OAuth ready check + scope narrowing check.
    const { body: oa } = await agent.post("/settings/connections/trello/oauth/start").expect(200);
    const back = new URL((await fetch(oa.url as string, { redirect: "manual" })).headers.get("location")!);
    await agent.get(back.pathname + back.search).expect(302);
    await agent.put("/settings/connections/trello/target").send({ boardId: "5f0000000000000000000010", listId: fake.trello.list }).expect(204);
    await db.update(connections).set({ scopes: "read:member:trello" }).where(and(eq(connections.userId, id), eq(connections.provider, "trello")));
    expect((await agent.post(`/workflows/${wfT}/versions`).send({ definition: trelloDef, publish: true }).expect(400)).body.message).toMatch(/board read access/);

    await db.update(connections).set({ scopes: "offline_access read:member:trello read:board:trello write:board:trello" }).where(and(eq(connections.userId, id), eq(connections.provider, "trello")));
    await agent.post(`/workflows/${wfT}/versions`).send({ definition: trelloDef, publish: true }).expect(201);

    const { body: conns } = await agent.get("/settings/connections").expect(200);
    expect(conns.usage.airtable).toEqual([expect.objectContaining({ id: wfA })]);
    expect(conns.usage.trello).toEqual([expect.objectContaining({ id: wfT })]);
  });
});
