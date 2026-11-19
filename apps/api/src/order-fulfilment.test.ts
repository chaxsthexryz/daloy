import { createHmac, randomBytes } from "node:crypto";
import { connections, deliveries, insertPayment, payments, recordDecision, runs, saveConnection, stepRuns, users, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import { TEMPLATES } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { advance } from "../../worker/src/advance";
import { createExecutor } from "../../worker/src/steps";
import { createApp } from "./app";

// Review, "Before release" 1: regression coverage for the three high findings, end to end with the real executor.
// H1: a buyer-typed price never reaches PayMongo before the owner has seen it. H2: a sandbox payment, or one a builder
// test made, starts a listener that only mocks. H3 has its own tests in public-intake.test.ts and paymongo.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const SK = "sk_test_abc123";
const WHSK = "whsk_secret_one";
const key = randomBytes(32);
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let server: Parameters<typeof request>[0];
let seq = 0;
let ip = 0;
const nextIp = () => `10.2.${(ip >> 8) & 255}.${++ip & 255}`;

const sent: { to: string; subject: string; text: string }[] = [];
const mail: MailDeps = {
  installation: {
    from: "Daloy <daloy@localhost>",
    transport: { sendMail: async (m: { to: string; subject: string; text: string }) => (sent.push({ to: String(m.to), subject: m.subject, text: m.text }), {}) } as unknown as MailDeps["installation"]["transport"],
  },
  gmail: () => {
    throw new Error("no Gmail here");
  },
  sharedMail: "open",
};

const deps = () => ({ db, executor: createExecutor({ db, secretsKey: key, mail, publicUrl: "https://daloy.test" }), owner: "fulfilment", leaseMs: 5000, retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }, enqueue: async () => {} });

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  vi.stubEnv("PAYMONGO_API_URL", fake.urls.paymongo);
  app = await createApp({ db, boss, secretsKey: key, secureCookies: false, trustProxy: 1, mail, publicUrl: "https://daloy.test", providers: { ...fake.urls, timeoutMs: 2000 } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

type Agent = ReturnType<typeof request.agent>;

async function owner(mode: "test" | "live" = "test") {
  const email = `fulfil${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  const path = randomBytes(32).toString("base64url");
  await saveConnection(db, key, u!.id, "paymongo", { account: mode, credential: JSON.stringify({ secretKey: mode === "live" ? "sk_live_abc123" : SK, webhookSecret: WHSK }), destination: { webhookPath: path, mode } });
  // A sheet to write to, or turning on a Sheets step is refused. Rows are only queued here, never delivered.
  await saveConnection(db, key, u!.id, "google_sheets", { account: "sheets@office.test", credential: JSON.stringify({ client_email: "sheets@office.test", private_key: "unused" }), destination: { spreadsheetId: "sheet-office", tab: "Orders", title: "Orders" } });
  return { agent, email, userId: u!.id, path };
}

async function publish(agent: Agent, name: string, definition: unknown) {
  const wf = await agent.post("/workflows").send({ name, slug: `ful-${++seq}` }).expect(201);
  const res = await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return wf.body.id as string;
}

type Definition = { steps: { id: string; type: string; config: Record<string, unknown> }[]; edges: { from: string; to: string; on?: string }[] };
const template = (slug: string) => structuredClone(TEMPLATES.find((t) => t.slug === slug)!.definition) as unknown as Definition;
const sessions = async () => ((await (await fetch(`${fake.urls.paymongo}/__control`)).json()) as { paymongoSessions: { id: string; amount: number }[] }).paymongoSessions;
const runsOf = async (workflowId: string) => db.select({ run: runs }).from(runs).innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId)).where(eq(workflowVersions.workflowId, workflowId));

/** Advances a run with the real executor until `done` holds. */
async function drive(runId: string, done: (state: string) => boolean) {
  for (let i = 0; i < 40; i++) {
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    if (done(run!.state)) return run!;
    await advance(deps(), runId);
  }
  throw new Error(`run ${runId} did not reach the wanted state`);
}
const stepsOf = (runId: string) => db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.createdAt));

describe("H1: a buyer-typed price is not turned into a payment link by itself", () => {
  async function order(o: Awaited<ReturnType<typeof owner>>, amount: string) {
    const definition = template("order-to-sheets");
    definition.steps.find((s) => s.type === "approval")!.config.to = o.email;
    const wf = await publish(o.agent, "Orders", definition);
    const formId = (await o.agent.get(`/workflows/${wf}`).expect(200)).body.trigger.id as string;
    await request(server).post(`/forms/${formId}`).set("X-Forwarded-For", nextIp()).type("form").send({ name: "Mia Cruz", email: "mia@example.com", item: "Wedding cake (P15,000)", amount }).expect(200);
    const { run } = (await runsOf(wf))[0]!;
    await drive(run.id, (s) => s === "waiting");
    return run.id;
  }
  const tokenOf = (to: string) => /([A-Za-z0-9_-]{43})/.exec(sent.filter((m) => m.to === to).at(-1)!.text)![1]!;

  it("parks at the owner's approval with no payment session, and shows the owner the typed amount", async () => {
    const o = await owner();
    const before = (await sessions()).length;
    const runId = await order(o, "1");
    expect((await sessions()).length).toBe(before);
    expect(await db.select().from(payments).where(eq(payments.runId, runId))).toEqual([]);
    expect((await stepsOf(runId)).map((s) => [s.stepId, s.state])).toEqual([["approve_price", "waiting"]]);
    const asked = sent.filter((m) => m.to === o.email).at(-1)!;
    expect(asked.text).toContain("Wedding cake (P15,000)");
    expect(asked.text).toContain("Amount entered by the buyer: 1 pesos");
  });

  it("makes no payment link when the owner says no, and tells the buyer", async () => {
    const o = await owner();
    const before = (await sessions()).length;
    const runId = await order(o, "1");
    await recordDecision(db, tokenOf(o.email), "rejected");
    await drive(runId, (s) => s === "succeeded");
    expect((await sessions()).length).toBe(before);
    expect(await db.select().from(payments).where(eq(payments.runId, runId))).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ to: "mia@example.com", subject: "About your order: Wedding cake (P15,000)" });
  });

  it("makes one payment link for exactly the amount the owner approved, and writes pesos in the pending row", async () => {
    const o = await owner();
    const before = (await sessions()).length;
    const runId = await order(o, "15000");
    await recordDecision(db, tokenOf(o.email), "approved");
    await drive(runId, (s) => s === "succeeded");
    const made = (await sessions()).slice(before);
    expect(made.map((s) => s.amount)).toEqual([1_500_000]);
    const [p] = await db.select().from(payments).where(eq(payments.runId, runId));
    expect(p).toMatchObject({ amountCentavos: 1_500_000, livemode: false });
    const [d] = await db.select().from(deliveries).where(eq(deliveries.runId, runId));
    expect((d!.payload as { row: string[] }).row).toEqual([expect.any(String), expect.any(String), p!.id, "Mia Cruz", "Wedding cake (P15,000)", "15000.00", "PHP", "pending"]);
  });
});

describe("H2: a test payment never starts live fulfilment", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const sign = (body: string, field: string, secret = WHSK) => {
    const t = now();
    // Semgrep: a fixed test signing key for the fake PayMongo webhook.
    // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    return `t=${t},${field}=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  };

  /** A published payment listener that writes a sheet row and sends an email, and a pending payment made by `source`. */
  async function setup(mode: "test" | "live", sourceTest: boolean) {
    const o = await owner(mode);
    const definition = template("order-paid");
    definition.steps.push({ id: "tell", type: "email", config: { to: o.email, subject: "Paid {{trigger.paymentId}}", text: "Paid {{trigger.amountPesos}}" } });
    definition.edges.push({ from: "log_paid", to: "tell" });
    const listener = await publish(o.agent, "Order paid", definition);
    const [wf] = await db.insert(workflows).values({ userId: o.userId, name: "Orders", slug: `src-${++seq}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {}, test: sourceTest }).returning();
    const sessionId = `cs_${++seq}_${randomBytes(4).toString("hex")}`;
    const p = await insertPayment(db, { userId: o.userId, workflowId: wf!.id, runId: r!.id, stepId: "link", reference: `ORD-${seq}`, amountCentavos: 15000, livemode: mode === "live", providerSessionId: sessionId, url: "https://pm.test/x" });
    const body = JSON.stringify({ data: { id: "event", type: "event", attributes: { type: "checkout_session.payment.paid", livemode: mode === "live", data: { id: sessionId, attributes: { payments: [{ id: "pay_1", attributes: { amount: 15000, currency: "PHP", status: "paid" } }] } } } } });
    await request(server).post(`/hooks/paymongo/${o.path}`).set("content-type", "application/json").set("X-Forwarded-For", nextIp()).set("paymongo-signature", sign(body.replace('"event"', `"evt_${seq}"`), mode === "live" ? "li" : "te")).send(body.replace('"event"', `"evt_${seq}"`)).expect(200);
    const { run } = (await runsOf(listener))[0]!;
    return { run, payment: p, email: o.email };
  }

  it("a sandbox payment starts a test run whose sheet row and email are mocked: nothing is queued or sent", async () => {
    const { run, email } = await setup("test", false);
    expect(run.test).toBe(true);
    const mailBefore = sent.length;
    await drive(run.id, (s) => s === "succeeded");
    expect(await db.select().from(deliveries).where(eq(deliveries.runId, run.id))).toEqual([]);
    expect(sent.slice(mailBefore).filter((m) => m.to === email)).toEqual([]);
    expect((await stepsOf(run.id)).map((s) => (s.output as { mocked?: boolean }).mocked)).toEqual([true, true]);
  });

  it("a live payment made by a builder test run is mocked too", async () => {
    const { run, email } = await setup("live", true);
    expect(run.test).toBe(true);
    const mailBefore = sent.length;
    await drive(run.id, (s) => s === "succeeded");
    expect(await db.select().from(deliveries).where(eq(deliveries.runId, run.id))).toEqual([]);
    expect(sent.slice(mailBefore).filter((m) => m.to === email)).toEqual([]);
  });

  it("control: a live payment made by a real run does queue the sheet row and send the email", async () => {
    const { run, email, payment } = await setup("live", false);
    expect(run.test).toBe(false);
    await drive(run.id, (s) => s === "succeeded");
    const [d] = await db.select().from(deliveries).where(eq(deliveries.runId, run.id));
    expect((d!.payload as { row: string[] }).row.slice(2)).toEqual([payment.id, "paid", "150.00", "PHP"]);
    expect(sent.filter((m) => m.to === email && m.subject === `Paid ${payment.id}`)).toHaveLength(1);
    expect(await db.select().from(connections).where(and(eq(connections.userId, payment.userId), eq(connections.provider, "paymongo")))).toHaveLength(1);
  });
});
