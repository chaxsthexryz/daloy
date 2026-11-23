import { createHmac, randomBytes } from "node:crypto";
import { connections, conversations, runDueDeliveries, runs, users, workflowVersions, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { advance } from "../../worker/src/advance";
import { createExecutor } from "../../worker/src/steps";
import { createApp } from "./app";

// C2 (decision 0118): menu buttons. A tap comes back signed like any message, as a quick-reply payload or a postback.
const PAGE_ID = "100200300402";
const PAGE_TOKEN = "meta_c2_page_token_synthetic_001"; // gitleaks:allow
const APP_SECRET = "meta_c2_app_secret_synthetic_001"; // gitleaks:allow
const VERIFY_TOKEN = "meta_c2_verify_token_synthetic_001"; // gitleaks:allow
const MENU = [
  { title: "Rooms", choice: "rooms" },
  { title: "Rates", choice: "rates" },
  { title: "Talk to staff", choice: "staff" },
];

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let seq = 0;
const secretsKey = randomBytes(32);

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "https://daloy.test", providers: { ...fake.urls, timeoutMs: 2000 } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

beforeEach(() => {
  fake.meta.token = PAGE_TOKEN;
  fake.meta.pageId = PAGE_ID;
  fake.meta.pageName = "Bahay Kubo Resort";
  fake.meta.revoked = false;
  fake.meta.messages.length = 0;
});

const deps = () => ({ db, executor: createExecutor({ db, secretsKey, mail: {} as never, urls: fake.urls }), owner: "c2", leaseMs: 5000, retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, enqueue: async () => {} });

async function setup(menu: unknown = MENU) {
  const email = `c2-${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201); // gitleaks:allow
  const [u] = await db.select().from(users).where(eq(users.email, email));
  await agent.put("/settings/connections/meta-messenger").send({ pageId: PAGE_ID, pageAccessToken: PAGE_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN }).expect(200);
  const wf = await agent.post("/workflows").send({ name: `C2 ${seq}`, slug: `c2-${seq}` }).expect(201);
  const definition = { trigger: { type: "meta_dm", config: {} }, steps: [{ id: "reply", type: "meta_reply", config: { text: "Pili po kayo:", quickReplies: menu } }], edges: [] };
  const saved = await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true });
  const [c] = await db.select().from(connections).where(and(eq(connections.userId, u!.id), eq(connections.provider, "meta_messenger")));
  return { userId: u!.id, workflowId: wf.body.id as string, path: (c!.destination as { webhookPath: string }).webhookPath, saved };
}

const sign = (body: string) => `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
const send = (path: string, messaging: unknown[], signature?: string) => {
  const body = JSON.stringify({ object: "page", entry: [{ id: PAGE_ID, messaging }] });
  const req = request(server).post(`/hooks/meta/${path}`).set("content-type", "application/json");
  return (signature === undefined ? req.set("x-hub-signature-256", sign(body)) : signature ? req.set("x-hub-signature-256", signature) : req).send(body);
};
const quickReply = (psid: string, mid: string, title: string, payload: string) => ({ sender: { id: psid }, recipient: { id: PAGE_ID }, timestamp: Date.now(), message: { mid, text: title, quick_reply: { payload } } });
const postback = (psid: string, mid: string, title: string, payload: string) => ({ sender: { id: psid }, recipient: { id: PAGE_ID }, timestamp: Date.now(), postback: { mid, title, payload } });

const runsOf = async (workflowId: string) => {
  const vs = await db.select({ id: workflowVersions.id }).from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId));
  return db.select().from(runs).where(inArray(runs.workflowVersionId, vs.map((v) => v.id))).orderBy(asc(runs.createdAt));
};
const choiceOf = (run: { triggerPayload: unknown }) => (run.triggerPayload as { choice?: string }).choice;

describe("Meta menu taps", () => {
  it("starts one run with trigger.choice for a quick-reply tap, and none for the replayed tap", async () => {
    const s = await setup();
    const tap = quickReply("psid-tap", "m_tap_1", "Rates", "rates");
    expect((await send(s.path, [tap])).status).toBe(200);
    expect((await send(s.path, [tap])).status).toBe(200);
    const list = await runsOf(s.workflowId);
    expect(list).toHaveLength(1);
    expect(choiceOf(list[0]!)).toBe("rates");
    expect(list[0]!.triggerPayload).toMatchObject({ text: "Rates", senderId: "psid-tap" });
  });

  it("starts one run for a postback, with its title as the text, and none for the replayed postback", async () => {
    const s = await setup();
    const tap = postback("psid-pb", "m_pb_1", "Talk to staff", "staff");
    await send(s.path, [tap]).expect(200);
    await send(s.path, [tap]).expect(200);
    const list = await runsOf(s.workflowId);
    expect(list).toHaveLength(1);
    expect(list[0]!.triggerPayload).toMatchObject({ text: "Talk to staff", choice: "staff", messageId: "m_pb_1" });
    const [c] = await db.select().from(conversations).where(and(eq(conversations.userId, s.userId), eq(conversations.externalId, "psid-pb")));
    expect(c).toMatchObject({ version: 1 });
  });

  it("drops an unknown payload: a postback starts nothing, a quick reply is plain text", async () => {
    const s = await setup();
    await send(s.path, [postback("psid-unknown", "m_unknown_1", "Free room", "admin:free_room")]).expect(200);
    // In the fixed list, but this workflow's menu does not offer it.
    await send(s.path, [postback("psid-unknown", "m_unknown_2", "Book", "book")]).expect(200);
    expect(await runsOf(s.workflowId)).toHaveLength(0);
    expect(await db.select().from(conversations).where(and(eq(conversations.userId, s.userId), eq(conversations.externalId, "psid-unknown")))).toHaveLength(0);

    await send(s.path, [quickReply("psid-unknown", "m_unknown_3", "Rates", "{{secrets.x}}")]).expect(200);
    await send(s.path, [quickReply("psid-unknown", "m_unknown_4", "Book", "book")]).expect(200);
    const list = await runsOf(s.workflowId);
    expect(list).toHaveLength(2);
    expect(list.map(choiceOf)).toEqual([undefined, undefined]);
  });

  it("still requires the signature for a postback", async () => {
    const s = await setup();
    const tap = postback("psid-unsigned", "m_unsigned_1", "Rates", "rates");
    expect((await send(s.path, [tap], "")).status).toBe(401);
    expect((await send(s.path, [tap], `sha256=${"0".repeat(64)}`)).status).toBe(401);
    expect(await runsOf(s.workflowId)).toHaveLength(0);
  });

  it("sends the menu as quick replies whose payload is the choice", async () => {
    const s = await setup();
    await send(s.path, [{ sender: { id: "psid-send" }, recipient: { id: PAGE_ID }, timestamp: Date.now(), message: { mid: "m_send_1", text: "Hello" } }]).expect(200);
    const [run] = await runsOf(s.workflowId);
    for (let i = 0; i < 10 && ["pending", "running"].includes((await db.select().from(runs).where(eq(runs.id, run!.id)))[0]!.state); i++) await advance(deps(), run!.id);
    await runDueDeliveries(db, secretsKey, fake.urls);
    expect(fake.meta.messages).toHaveLength(1);
    expect(fake.meta.messages[0]!.quickReplies).toEqual(MENU.map((m) => ({ content_type: "text", title: m.title, payload: m.choice })));
  });

  it("refuses to save a menu with 14 buttons or a title over 20 characters", async () => {
    expect((await setup(Array.from({ length: 14 }, () => ({ title: "Rooms", choice: "rooms" })))).saved.status).toBe(400);
    expect((await setup([{ title: "Rooms with a sea view", choice: "rooms" }])).saved.status).toBe(400);
  });
});
