import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connections, insertPayment, markPaymentPaid, paymongoEvents, payments, runs, saveConnection, triggers, users, workflows, workflowVersions, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { spyDb } from "../../../test/spy-db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";

// PayMongo connection and signed webhook. A local stub stands in for api.paymongo.com.
const SK = "sk_test_abc123";
const WHSK = "whsk_secret_one";
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let stub: Server;
let spy: ReturnType<typeof spyDb>;
let seq = 0;
const secretsKey = randomBytes(32);

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  stub = createServer((req, res) => {
    const ok = req.headers.authorization === `Basic ${Buffer.from(`${SK}:`).toString("base64")}`;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ok ? { data: [] } : { errors: [{ detail: "bad key" }] }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const paymongo = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  spy = spyDb(db);
  app = await createApp({ db: spy.db, boss, secretsKey, secureCookies: false, publicUrl: "https://daloy.test", providers: { ...fake.urls, paymongo, timeoutMs: 2000 } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  stub?.close();
  await pool?.end();
});

type Agent = ReturnType<typeof request.agent>;

async function owner() {
  const email = `pm${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id };
}

async function connect(agent: Agent, userId: string) {
  await agent.put("/settings/connections/paymongo").send({ secretKey: SK, webhookSecret: WHSK }).expect(200);
  const [c] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, "paymongo")));
  return (c!.destination as { webhookPath: string }).webhookPath;
}

async function listener(agent: Agent, events: string[]) {
  const wf = await agent.post("/workflows").send({ name: "Paid", slug: `pay-${++seq}` }).expect(201);
  const definition = { trigger: { type: "payment", config: { events } }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  return wf.body.id as string;
}

async function payment(userId: string, amountCentavos = 15000, o: { livemode?: boolean; test?: boolean; sessionId?: string } = {}) {
  const [wf] = await db.insert(workflows).values({ userId, name: "Orders", slug: `orders-${++seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {}, test: o.test ?? false }).returning();
  const sessionId = o.sessionId ?? `cs_${seq}_${randomBytes(4).toString("hex")}`;
  const p = await insertPayment(db, { userId, workflowId: wf!.id, runId: r!.id, stepId: "link", reference: `ORD-${seq}`, amountCentavos, livemode: o.livemode ?? false, providerSessionId: sessionId, url: "https://pm.test/x" });
  return { p, sessionId, runId: r!.id };
}

const runsOf = async (workflowId: string) => {
  const vs = await db.select({ id: workflowVersions.id }).from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId));
  return db.select().from(runs).where(inArray(runs.workflowVersionId, vs.map((v) => v.id)));
};
const statusOf = async (id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0]!.status;

const now = () => Math.floor(Date.now() / 1000);
const sign = (body: string, t = now(), secret = WHSK, field = "te") => `t=${t},${field}=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const event = (id: string, type: string, resource: object, livemode = false) => JSON.stringify({ data: { id, type: "event", attributes: { type, livemode, data: resource } } });
const paidEvent = (id: string, sessionId: string, amount = 15000) =>
  event(id, "checkout_session.payment.paid", {
    id: sessionId,
    attributes: { payments: [{ id: "pay_failed", attributes: { amount, currency: "PHP", status: "failed" } }, { id: "pay_1", attributes: { amount, currency: "PHP", status: "paid" } }] },
  });
const refundEvent = (id: string) => event(id, "payment.refunded", { id: "pay_1", attributes: {} });
const post = (path: string, body: string, header = sign(body)) => request(server).post(`/hooks/paymongo/${path}`).set("content-type", "application/json").set("paymongo-signature", header).send(body);

describe("PayMongo connection", () => {
  it("connects, shows the mode and webhook path, and never returns a secret", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    expect(path).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const res = await agent.get("/settings/connections").expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SK);
    expect(text).not.toContain(WHSK);
    expect(res.body.connections[0]).toMatchObject({ provider: "paymongo", status: "active", destination: { mode: "test", webhookPath: path } });
    expect(res.body.paymongoWebhookBase).toBe("https://daloy.test/hooks/paymongo");
    const [row] = await db.select().from(connections).where(eq(connections.userId, userId));
    expect(JSON.stringify(row)).not.toContain(SK);
    // Reconnecting keeps the URL already given to PayMongo.
    expect(await connect(agent, userId)).toBe(path);
  });

  it("tests the key and refuses a wrong or malformed one", async () => {
    const { agent, userId } = await owner();
    await connect(agent, userId);
    expect((await agent.post("/settings/connections/paymongo/test").expect(200)).body).toMatchObject({ ok: true, mode: "test" });
    await agent.put("/settings/connections/paymongo").send({ secretKey: "sk_test_wrong", webhookSecret: WHSK }).expect(400);
    await agent.put("/settings/connections/paymongo").send({ secretKey: "pk_test_x", webhookSecret: WHSK }).expect(400);
    await agent.put("/settings/connections/paymongo").send({ secretKey: SK, webhookSecret: "nope" }).expect(400);
  });

  it("refuses a live key unless PAYMONGO_LIVE is on", async () => {
    const { agent } = await owner();
    const res = await agent.put("/settings/connections/paymongo").send({ secretKey: "sk_live_abc123", webhookSecret: WHSK }).expect(400);
    expect(res.body.message).toMatch(/business verification/);
  });
});

describe("PayMongo webhook", () => {
  it("starts the version its listener was read with when the owner republishes in between", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    const wf = await listener(agent, ["paid"]);
    const { sessionId } = await payment(userId);
    // After the trigger read, the owner replaces the payment listener with a manual workflow.
    spy.afterFirstRead("triggers", async () => {
      const definition = { trigger: { type: "manual" }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
      await agent.post(`/workflows/${wf}/versions`).send({ definition, publish: true }).expect(201);
    });
    await post(path, paidEvent("evt_race", sessionId)).expect(200);
    const [v1] = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, wf), eq(workflowVersions.version, 1)));
    expect((await runsOf(wf)).every((r) => r.workflowVersionId === v1!.id)).toBe(true);
  });

  it("marks a payment paid and starts one run per listening workflow, once", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    const wf = await listener(agent, ["paid"]);
    const refundOnly = await listener(agent, ["refunded"]);
    const { p, sessionId, runId } = await payment(userId);
    const body = paidEvent("evt_1", sessionId);
    await post(path, body).expect(200);
    expect(await statusOf(p.id)).toBe("paid");
    const started = await runsOf(wf);
    expect(started).toHaveLength(1);
    expect(started[0]!.triggerPayload).toEqual({ status: "paid", reference: p.reference, amount: 15000, amountPesos: "150.00", livemode: false, currency: "PHP", paymentId: p.id, sourceRunId: runId, providerPaymentId: "pay_1" });
    // A sandbox payment starts its listeners as test runs, which the worker mocks (H2).
    expect(started[0]!.test).toBe(true);
    expect(await runsOf(refundOnly)).toHaveLength(0);
    expect((await post(path, body).expect(200)).body).toEqual({ duplicate: true });
    await post(path, paidEvent("evt_2", sessionId)).expect(200);
    expect(await runsOf(wf)).toHaveLength(1);
  });

  it("a crash after the payment was marked paid still starts the runs on PayMongo's retry", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    const wf = await listener(agent, ["paid"]);
    const { p, sessionId } = await payment(userId);
    // The update committed, then the API died before starting any run.
    await markPaymentPaid(db, { userId, sessionId, paymentId: "pay_1", amount: 15000, currency: "PHP", livemode: false });
    expect(await statusOf(p.id)).toBe("paid");
    expect(await runsOf(wf)).toHaveLength(0);
    const body = paidEvent("evt_crash", sessionId);
    await post(path, body).expect(200);
    expect(await runsOf(wf)).toHaveLength(1);
    await post(path, body).expect(200);
    expect(await runsOf(wf)).toHaveLength(1);
  });

  it("parks an amount mismatch in needs_review without a run", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    const wf = await listener(agent, ["paid"]);
    const { p, sessionId } = await payment(userId);
    await post(path, paidEvent("evt_m", sessionId, 99)).expect(200);
    expect(await statusOf(p.id)).toBe("needs_review");
    expect(await runsOf(wf)).toHaveLength(0);
  });

  it("refunds a paid payment for refund listeners only; a late paid event does not undo it", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    const paidWf = await listener(agent, ["paid"]);
    const refundWf = await listener(agent, ["refunded"]);
    const { p, sessionId } = await payment(userId);
    await post(path, paidEvent("evt_p", sessionId)).expect(200);
    await post(path, refundEvent("evt_r")).expect(200);
    expect(await statusOf(p.id)).toBe("refunded");
    const refunds = await runsOf(refundWf);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.triggerPayload).toMatchObject({ status: "refunded", paymentId: p.id });
    await post(path, paidEvent("evt_late", sessionId)).expect(200);
    expect(await statusOf(p.id)).toBe("refunded");
    expect(await runsOf(paidWf)).toHaveLength(1);
  });

  it("a live payment made by a builder test run starts a test run; one made by a real run starts a real run", async () => {
    const { userId } = await owner();
    const path = randomBytes(32).toString("base64url");
    await saveConnection(db, secretsKey, userId, "paymongo", { account: "Live", credential: JSON.stringify({ secretKey: "sk_live_abc123", webhookSecret: WHSK }), destination: { webhookPath: path, mode: "live" } });
    const [wf] = await db.insert(workflows).values({ userId, name: "Live paid", slug: `lp-${++seq}` }).returning();
    await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: { trigger: { type: "payment", config: { events: ["paid"] } }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] }, published: true }).returning();
    await db.insert(triggers).values({ workflowId: wf!.id, type: "payment", config: { events: ["paid"] } });
    const fromTest = await payment(userId, 15000, { livemode: true, test: true });
    const fromReal = await payment(userId, 15000, { livemode: true });
    for (const [id, sessionId] of [["evt_lt", fromTest.sessionId], ["evt_lr", fromReal.sessionId]] as const) {
      const body = paidEvent(id, sessionId).replace('"livemode":false', '"livemode":true');
      await post(path, body, sign(body, now(), WHSK, "li")).expect(200);
    }
    const started = await runsOf(wf!.id);
    const bySource = (r: string) => started.find((x) => (x.triggerPayload as { sourceRunId?: string }).sourceRunId === r)!;
    expect(bySource(fromTest.runId).test).toBe(true);
    expect(bySource(fromReal.runId).test).toBe(false);
    expect((bySource(fromReal.runId).triggerPayload as { livemode: boolean }).livemode).toBe(true);
  });

  it("a live payment is not settled by a test-mode event", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    const wf = await listener(agent, ["paid"]);
    const { p, sessionId } = await payment(userId, 15000, { livemode: true });
    await post(path, paidEvent("evt_lm", sessionId)).expect(200);
    expect(await statusOf(p.id)).toBe("pending");
    expect(await runsOf(wf)).toHaveLength(0);
  });

  it("starts no run for a paused listener", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    const wf = await listener(agent, ["paid"]);
    await db.update(workflows).set({ pausedAt: new Date() }).where(eq(workflows.id, wf));
    const { sessionId } = await payment(userId);
    await post(path, paidEvent("evt_pz", sessionId)).expect(200);
    expect(await runsOf(wf)).toHaveLength(0);
  });

  it("the same event id delivered to another workspace first does not suppress this workspace's payment (M3)", async () => {
    const a = await owner();
    const b = await owner();
    const pathA = await connect(a.agent, a.userId);
    const pathB = await connect(b.agent, b.userId);
    const { p, sessionId } = await payment(a.userId);
    const body = paidEvent("evt_shared", sessionId);
    await post(pathB, body).expect(200);
    expect((await post(pathA, body).expect(200)).body).toEqual({ ok: true });
    expect(await statusOf(p.id)).toBe("paid");
  });

  it("keeps a refund that arrives first, and a later paid event ends refunded without starting paid listeners (M5)", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    const paidWf = await listener(agent, ["paid"]);
    const refundWf = await listener(agent, ["refunded"]);
    const { p, sessionId } = await payment(userId);
    await post(path, refundEvent("evt_early_r")).expect(200);
    const [kept] = await db.select().from(paymongoEvents).where(and(eq(paymongoEvents.userId, userId), eq(paymongoEvents.eventId, "evt_early_r")));
    expect(kept).toMatchObject({ state: "kept", payload: { paymentId: "pay_1", livemode: false } });
    expect((await post(path, refundEvent("evt_early_r")).expect(200)).body).toEqual({ duplicate: true });
    await post(path, paidEvent("evt_late_p", sessionId)).expect(200);
    expect(await statusOf(p.id)).toBe("refunded");
    expect(await runsOf(paidWf)).toHaveLength(0);
    expect(await runsOf(refundWf)).toHaveLength(1);
    const rows = await db.select().from(paymongoEvents).where(eq(paymongoEvents.userId, userId));
    expect(rows.map((r) => [r.eventId, r.state]).sort()).toEqual([["evt_early_r", "done"], ["evt_late_p", "done"]]);
  });

  it("ignores a test-mode kept refund for a live-mode payment, and a live-mode kept refund for a test-mode payment (M5)", async () => {
    // Test-mode kept refund must not affect a live-mode payment.
    const live = await owner();
    const livePath = randomBytes(32).toString("base64url");
    await saveConnection(db, secretsKey, live.userId, "paymongo", { account: "Live", credential: JSON.stringify({ secretKey: "sk_live_abc123", webhookSecret: WHSK }), destination: { webhookPath: livePath, mode: "live" } });
    const livePaidWf = await listener(live.agent, ["paid"]);
    const liveRefundWf = await listener(live.agent, ["refunded"]);
    const livePay = await payment(live.userId, 15000, { livemode: true });
    await db.insert(paymongoEvents).values({ eventId: "evt_test_ref", userId: live.userId, type: "payment.refunded", state: "kept", payload: { paymentId: "pay_1", livemode: false } });
    const livePaidBody = paidEvent("evt_live_p", livePay.sessionId).replace('"livemode":false', '"livemode":true');
    await post(livePath, livePaidBody, sign(livePaidBody, now(), WHSK, "li")).expect(200);
    expect(await statusOf(livePay.p.id)).toBe("paid");
    expect(await runsOf(livePaidWf)).toHaveLength(1);
    expect(await runsOf(liveRefundWf)).toHaveLength(0);
    const [stillKeptTest] = await db.select().from(paymongoEvents).where(and(eq(paymongoEvents.userId, live.userId), eq(paymongoEvents.eventId, "evt_test_ref")));
    expect(stillKeptTest!.state).toBe("kept");

    // Live-mode kept refund must not affect a test-mode payment.
    const test = await owner();
    const testPath = await connect(test.agent, test.userId);
    const testPaidWf = await listener(test.agent, ["paid"]);
    const testRefundWf = await listener(test.agent, ["refunded"]);
    const testPay = await payment(test.userId, 15000, { livemode: false });
    await db.insert(paymongoEvents).values({ eventId: "evt_live_ref", userId: test.userId, type: "payment.refunded", state: "kept", payload: { paymentId: "pay_1", livemode: true } });
    await post(testPath, paidEvent("evt_test_p", testPay.sessionId)).expect(200);
    expect(await statusOf(testPay.p.id)).toBe("paid");
    expect(await runsOf(testPaidWf)).toHaveLength(1);
    expect(await runsOf(testRefundWf)).toHaveLength(0);
    const [stillKeptLive] = await db.select().from(paymongoEvents).where(and(eq(paymongoEvents.userId, test.userId), eq(paymongoEvents.eventId, "evt_live_ref")));
    expect(stillKeptLive!.state).toBe("kept");
  });

  it("keeps a paid event that arrives before the payment row, and storing the row settles it (M4)", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    await post(path, paidEvent("evt_early_p", "cs_early")).expect(200);
    expect((await post(path, paidEvent("evt_early_p", "cs_early")).expect(200)).body).toEqual({ duplicate: true });
    expect(await db.select().from(paymongoEvents).where(eq(paymongoEvents.eventId, "evt_early_p"))).toMatchObject([{ state: "kept" }]);
    const { p } = await payment(userId, 15000, { sessionId: "cs_early" });
    expect(await statusOf(p.id)).toBe("paid");
    expect(await db.select().from(paymongoEvents).where(eq(paymongoEvents.eventId, "evt_early_p"))).toMatchObject([{ state: "done" }]);
  });

  it("answers 200 to an event type it does not handle", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    await post(path, event("evt_x", "payment.failed", { id: "pay_9" })).expect(200);
  });

  it("rejects bad signatures, stale ones, the live signature, a wrong mode and an unknown path", async () => {
    const { agent, userId } = await owner();
    const path = await connect(agent, userId);
    const { sessionId } = await payment(userId);
    const body = paidEvent("evt_s", sessionId);
    await post(path, body, sign(body, now(), WHSK, "li")).expect(401);
    await post(path, body + " ", sign(body)).expect(401);
    await post(path, body, sign(body, now(), "whsk_other")).expect(401);
    await post(path, body, sign(body, now() - 72 * 3600 - 60)).expect(401);
    await post(path, body, "").expect(401);
    await post(path, paidEvent("evt_l", sessionId).replace('"livemode":false', '"livemode":true')).expect(400);
    await post(randomBytes(32).toString("base64url"), body).expect(404);
  });
});
