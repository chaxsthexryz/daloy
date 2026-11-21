import { createHmac, randomBytes } from "node:crypto";
import { connections, createDue, insertPayment, joinWorkspace, paymentDues, runs, sessions, users, workflows, workflowVersions, type Db, type Due } from "@daloy/db";
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

// R3 routes: the public pay page, Receipts to review, decisions, private receipt images and the PayMongo webhook for dues.
const SK = "sk_test_r3";
const WHSK = "whsk_r3";
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let server: Parameters<typeof request>[0];
let seq = 0;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, trustProxy: 1, publicUrl: "https://daloy.test", providers: { ...fake.urls, timeoutMs: 2000 } });
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
  const email = `r3-${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id };
}

async function member(workspaceId: string, role: "operator" | "approver") {
  const [u] = await db.insert(users).values({ email: `r3m-${++seq}@test.local`, passwordHash: "x" }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}

async function due(userId: string, over: Partial<Parameters<typeof createDue>[1]> = {}): Promise<Due> {
  const [wf] = await db.insert(workflows).values({ userId, name: "Deposits", slug: `d-${++seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
  return createDue(db, { userId, test: false, workflowId: wf!.id, runId: r!.id, stepId: "ask", reference: `D-${1000 + ++seq}`, kind: "deposit", amountCentavos: 35000, ...over });
}

// Each call comes from its own address unless one is given, so only the rate limit test shares one.
const send = (token: string, fields: Record<string, string>, file?: Buffer, ip = `10.0.${Math.floor(++seq / 250)}.${seq % 250}`) => {
  let r = request(server).post(`/pay/${token}`).set("accept", "text/html").set("x-forwarded-for", ip);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return file ? r.attach("receipt", file, "receipt.png") : r;
};

describe("pay page", () => {
  it("shows the amount, the order and the seller's payment details, and nothing for a bad token", async () => {
    const o = await owner();
    await o.agent.put("/payments/settings").send({ gcashNumber: "0917 555 0101", accountName: "Lia's Nails", qr: PNG.toString("base64") }).expect(200);
    const d = await due(o.userId);
    const res = await request(server).get(`/pay/${d.token}`).expect(200);
    expect(res.text).toContain(d.reference);
    expect(res.text).toContain("PHP 350.00");
    expect(res.text).toContain("0917 555 0101");
    expect(res.text).toContain("Lia&#39;s Nails");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await request(server).get(`/pay/${d.token}/qr`).expect(200)).headers["content-type"]).toBe("image/png");
    await request(server).get(`/pay/${"x".repeat(43)}`).expect(404);
    await request(server).get("/pay/short").expect(404);
  });

  it("takes a reference and a receipt, puts the order in review and leaves it pending", async () => {
    const o = await owner();
    const d = await due(o.userId);
    const res = await send(d.token, { transfer_ref: "5012 3456 7890", amount: "350" }, PNG).expect(200);
    expect(res.text).toContain("Reference received");
    expect((await db.select().from(paymentDues).where(eq(paymentDues.id, d.id)))[0]!.status).toBe("pending");
    const [row] = (await o.agent.get("/payments/review").expect(200)).body;
    expect(row).toMatchObject({ type: "claim", reference: d.reference, amountDue: 35000, submitted: 35000, transferRef: "5012 3456 7890", channel: "transfer", flags: [], hasImage: true });
    expect((await o.agent.get(`/payments/claims/${row.claimId}/image`).expect(200)).headers["content-type"]).toBe("image/png");
    await send(d.token, { transfer_ref: "x" }).expect(400);
    await send(d.token, { transfer_ref: "ABCD12345", amount: "3,50" }).expect(400);
  });

  it("limits uploads per IP", async () => {
    const o = await owner();
    const d = await due(o.userId);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await send(d.token, { transfer_ref: `RATE${i}LIMIT` }, undefined, "10.9.9.9")).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe("who may review", () => {
  it("only owners and operators of the workspace see receipts and images, and only the owner sets payment details", async () => {
    const o = await owner();
    const d = await due(o.userId);
    await send(d.token, { transfer_ref: "PRIVATE001" }, PNG).expect(200);
    const [row] = (await o.agent.get("/payments/review").expect(200)).body;
    const approver = await member(o.userId, "approver");
    await approver.get("/payments/review").expect(403);
    await approver.get(`/payments/claims/${row.claimId}/image`).expect(403);
    const stranger = await owner();
    await stranger.agent.get(`/payments/claims/${row.claimId}/image`).expect(404);
    expect((await stranger.agent.get("/payments/review").expect(200)).body).toEqual([]);
    const operator = await member(o.userId, "operator");
    await operator.get(`/payments/claims/${row.claimId}/image`).expect(200);
    await operator.put("/payments/settings").send({ gcashNumber: "09170000000", accountName: "Mallory" }).expect(403);
    await o.agent.put("/payments/settings").send({ gcashNumber: null, accountName: null, qr: Buffer.from("not an image").toString("base64") }).expect(400);
  });
});

describe("decisions", () => {
  it("confirms once, refuses a stale second decision, and a reject needs a reason", async () => {
    const o = await owner();
    const d = await due(o.userId);
    await send(d.token, { transfer_ref: "DECIDE0001" }).expect(200);
    await send(d.token, { transfer_ref: "DECIDE0002" }).expect(200);
    const [a, b] = (await o.agent.get("/payments/review").expect(200)).body;
    await o.agent.post(`/payments/claims/${b.claimId}/decide`).send({ version: b.version, decision: "reject" }).expect(400);
    expect((await o.agent.post(`/payments/claims/${a.claimId}/decide`).send({ version: a.version, decision: "confirm" }).expect(200)).body).toMatchObject({ status: "confirmed", dueStatus: "confirmed", checkoutOpen: false });
    await o.agent.post(`/payments/claims/${a.claimId}/decide`).send({ version: a.version, decision: "confirm" }).expect(409);
    // The other receipt is flagged and kept for a decision; it cannot confirm a second time.
    const [left] = (await o.agent.get("/payments/review").expect(200)).body;
    expect(left).toMatchObject({ claimId: b.claimId, flags: ["already_confirmed"] });
    await o.agent.post(`/payments/claims/${b.claimId}/decide`).send({ version: left.version, decision: "confirm" }).expect(409);
    await o.agent.post(`/payments/claims/${b.claimId}/decide`).send({ version: left.version, decision: "reject", reason: "Paid twice, refunded by GCash" }).expect(200);
    const page = await request(server).get(`/pay/${d.token}`).expect(200);
    expect(page.text).toContain("Paid");
    const [view] = (await o.agent.get(`/payments/dues?reference=${d.reference}`).expect(200)).body;
    expect(view).toMatchObject({ status: "confirmed", confirmedSource: "transfer", outstanding: 0 });
  });
});

describe("PayMongo webhook for a due", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const sign = (body: string) => `t=${now()},te=${createHmac("sha256", WHSK).update(`${now()}.${body}`).digest("hex")}`;
  const paidEvent = (id: string, sessionId: string, amount: number) =>
    JSON.stringify({ data: { id, type: "event", attributes: { type: "checkout_session.payment.paid", livemode: false, data: { id: sessionId, attributes: { payments: [{ id: `pay_${id}`, attributes: { amount, currency: "PHP", status: "paid" } }] } } } } });

  async function setup(amount = 35000) {
    const o = await owner();
    await o.agent.put("/settings/connections/paymongo").send({ secretKey: SK, webhookSecret: WHSK }).expect(200);
    const [c] = await db.select().from(connections).where(and(eq(connections.userId, o.userId), eq(connections.provider, "paymongo")));
    const path = (c!.destination as { webhookPath: string }).webhookPath;
    const d = await due(o.userId);
    const sessionId = `cs_r3_${++seq}`;
    await insertPayment(db, { userId: o.userId, workflowId: d.workflowId!, runId: d.runId, stepId: d.stepId, reference: d.reference, amountCentavos: amount, livemode: false, providerSessionId: sessionId, url: "https://pm.test/x", dueId: d.id });
    const post = (body: string) => request(server).post(`/hooks/paymongo/${path}`).set("content-type", "application/json").set("paymongo-signature", sign(body)).send(body);
    return { o, d, sessionId, post };
  }

  it("a verified matching event confirms the due, and a replay changes nothing", async () => {
    const { o, d, sessionId, post } = await setup();
    await post(paidEvent(`evt_ok_${seq}`, sessionId, 35000)).expect(200);
    expect((await post(paidEvent(`evt_ok_${seq}`, sessionId, 35000)).expect(200)).body).toEqual({ duplicate: true });
    expect((await db.select().from(paymentDues).where(eq(paymentDues.id, d.id)))[0]).toMatchObject({ status: "confirmed", confirmedSource: "checkout" });
    expect((await o.agent.get("/payments/review").expect(200)).body).toEqual([]);
  });

  it("an unsigned event confirms nothing, and a wrong amount goes to review", async () => {
    const { o, d, sessionId, post } = await setup();
    const body = paidEvent(`evt_bad_${seq}`, sessionId, 35000);
    await request(server).post("/hooks/paymongo/whatever").set("content-type", "application/json").set("paymongo-signature", "t=1,te=00").send(body).expect(404);
    await post(paidEvent(`evt_low_${seq}`, sessionId, 30000)).expect(200);
    expect((await db.select().from(paymentDues).where(eq(paymentDues.id, d.id)))[0]!.status).toBe("pending");
    const [row] = (await o.agent.get("/payments/review").expect(200)).body;
    expect(row).toMatchObject({ channel: "checkout", amountDue: 35000, submitted: 30000, flags: ["amount_mismatch"] });
  });
});
