import { randomBytes } from "node:crypto";
import { connections, joinWorkspace, pollGoogleTriggers, sessions, users, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";
import { sha256 } from "./http";

// G2 (decision 0127): the editor's status route and the publish check for Google triggers, with Google faked.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let providers: Parameters<typeof createApp>[0]["providers"];
const secretsKey = randomBytes(32);
const ANA = { id: "google-ana-g2api", email: "ana-g2api@clinic.example" };
let seq = 0;
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  const g = fake.addOAuthApp("google", { rotation: "none" });
  g.user = ANA;
  providers = { ...fake.urls, timeoutMs: 2000, googleOAuth: { clientId: g.clientId, clientSecret: g.clientSecret, ...fake.oauthUrls("google") } };
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
  const res = await agent.post("/auth/register").send({ email: `g2api${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}
async function connectSheets(agent: Agent) {
  const { body } = await agent.post("/settings/connections/google-sheets/oauth/start").expect(200);
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  await agent.get(back.pathname + back.search).expect(302);
  const id = `g2api-sheet-${String(++seq).padStart(6, "0")}`;
  fake.addSheet(id, "Orders log", "Orders", [ANA.email]).tabs.set("Walk-ins", [["Name"]]);
  await agent.post("/settings/connections/google-sheets/pick").send({ spreadsheetId: id, tab: "Orders" }).expect(200);
  return id;
}
const sheetsRow = (tab: string) => ({ trigger: { type: "sheets_row", config: { tab } }, steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }], edges: [] });
async function automation(agent: Agent) {
  const { body } = await agent.post("/workflows").send({ name: "New orders", slug: `orders-${++seq}` }).expect(201);
  return body.id as string;
}

describe("GET /triggers/google/:type", () => {
  it("says which app to connect, then is ready with the sheet's tabs once connected", async () => {
    const { agent } = await owner();
    expect((await agent.get("/triggers/google/sheets_row").expect(200)).body).toMatchObject({ app: "google_sheets", problem: "Google Sheets is not connected. Connect it in Apps.", destination: null, watching: null });
    await connectSheets(agent);
    const ready = await agent.get("/triggers/google/sheets_row?tabs=1").expect(200);
    expect(ready.body).toMatchObject({ problem: null, destination: "Orders log", tabs: ["Orders", "Walk-ins"] });
    expect((await agent.get("/triggers/google/calendar_event").expect(200)).body.problem).toBe("Google Calendar is not connected. Connect it in Apps.");
  });

  it("names the permission to leave ticked when the stored grant is narrower", async () => {
    const { agent, id } = await owner();
    await connectSheets(agent);
    await db.update(connections).set({ scopes: "openid email" }).where(eq(connections.userId, id));
    const { body } = await agent.get("/triggers/google/sheets_row?tabs=1").expect(200);
    expect(body.problem).toMatch(/^Reconnect Google Sheets in Apps and leave this permission ticked/);
    expect(body.tabs).toBeUndefined();
  });

  it("shows the watcher of a saved automation in the same workspace only", async () => {
    const { agent } = await owner();
    await connectSheets(agent);
    const wf = await automation(agent);
    await agent.post(`/workflows/${wf}/versions`).send({ definition: sheetsRow("Walk-ins"), publish: true }).expect(201);
    await pollGoogleTriggers({ db, secretsKey, urls: providers!, enqueue: async () => {} });
    const { body } = await agent.get(`/triggers/google/sheets_row?workflowId=${wf}`).expect(200);
    expect(body.watching).toMatchObject({ problem: null, failures: 0, started: true });
    const other = await owner();
    expect((await other.agent.get(`/triggers/google/sheets_row?workflowId=${wf}`).expect(200)).body.watching).toBeNull();
  });

  it("refuses unknown trigger types and bad queries, and people who cannot build", async () => {
    const { agent, id } = await owner();
    await agent.get("/triggers/google/webhook").expect(400);
    await agent.get("/triggers/google/sheets_row?workflowId=nope").expect(400);
    const [u] = await db.insert(users).values({ email: `req${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
    await joinWorkspace(db, u!.id, id, "requester");
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    await request.agent(server).set("Cookie", `daloy_session=${token}`).get("/triggers/google/sheets_row").expect(403);
  });
});

describe("publishing a Google trigger", () => {
  it("is refused until the app is connected with a destination, then accepted", async () => {
    const { agent } = await owner();
    const wf = await automation(agent);
    const refused = await agent.post(`/workflows/${wf}/versions`).send({ definition: sheetsRow("Orders"), publish: true }).expect(400);
    expect(refused.body.message).toBe("Google Sheets is not connected. Connect it in Apps.");
    // A draft saves without a connection.
    await agent.post(`/workflows/${wf}/versions`).send({ definition: sheetsRow("Orders"), publish: false }).expect(201);
    await connectSheets(agent);
    await agent.post(`/workflows/${wf}/versions`).send({ definition: sheetsRow("Orders"), publish: true }).expect(201);
  });
});
