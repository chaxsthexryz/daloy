import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { approvals, deliveries, requests, runs, stepRuns, type Db, type MailDeps } from "@daloy/db";
import * as engine from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { qa01, qa01NoInvalidEdge, qa01Unchecked } from "../../../test/scenarios/qa-01-sales-leads";
import { desired, hourDelay, qa02 } from "../../../test/scenarios/qa-02-spa-appointments";
import { qa03 } from "../../../test/scenarios/qa-03-cafe-promotions";
import { qa04 } from "../../../test/scenarios/qa-04-refunds";
import { qa05 } from "../../../test/scenarios/qa-05-purchase-requests";
import { intake, intakeKeyOnly, intakeNoKey, qa06 } from "../../../test/scenarios/qa-06-high-traffic";
import { ADVERSARIAL, qa07, secretProbe } from "../../../test/scenarios/qa-07-multi-tenant";
import { liveOrder, qa08 } from "../../../test/scenarios/qa-08-failure-recovery";
import { REJECTED, type Outcome, type RunCase, type Scenario } from "../../../test/scenarios/types";
import { advance } from "../../worker/src/advance";
import { createExecutor } from "../../worker/src/steps";
import { BLOCKED_RANGES, blockListOf, type SsrfGuard } from "../../worker/src/steps/ssrf";
import { createApp } from "./app";

// Scenario acceptance harness for QA-01 to QA-08 (see test/scenarios/types.ts). The API takes each test run or event
// as a client would; the real executor then advances the run on a disposable database. Mocked steps send nothing,
// live ones reach only the local receiver and an in-memory mail transport.
vi.setConfig({ testTimeout: 30_000 });

const key = randomBytes(32);
let app: INestApplication;
let boss: PgBoss;
let pool: Pool;
let db: Db;
let owner: ReturnType<typeof request.agent>;
let other: ReturnType<typeof request.agent>;

const mailSent: string[] = [];
const mail: MailDeps = {
  installation: {
    from: "Daloy <daloy@localhost>",
    // Records each message instead of sending it. Typed through the transport MailDeps expects.
    transport: {
      sendMail: async (msg: { subject?: string }) => {
        mailSent.push(String(msg.subject));
        return {};
      },
    } as unknown as MailDeps["installation"]["transport"],
  },
  gmail: () => {
    throw new Error("no Gmail in the scenario harness");
  },
  sharedMail: "open",
};

// The receiver answers each POST as the current test says, after reading the whole body.
type Mode = "ok" | "bad_request" | "unavailable" | "reset";
let mode: Mode = "ok";
const received: { key: string | undefined; body: string }[] = [];
let receiver: Server;
// The same local server stands in for the model (Ollama's /api/chat) in AI-only test runs.
const llmCalls: { system: string; user: string }[] = [];
let port = 0;
let closedPort = 0;
const guard = (): SsrfGuard => ({
  blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")),
  ports: ["", "80", "443", String(port), String(closedPort)],
  resolve: async (host) => {
    if (host === "public.test") return [{ address: "127.0.0.1", family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  },
});

const deps = () => ({
  db,
  executor: createExecutor({ db, secretsKey: key, mail, guard: guard(), publicUrl: "https://daloy.example.com" }),
  owner: "scenarios",
  leaseMs: 5000,
  retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  enqueue: async () => {},
});

const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => resolve(body));
});

beforeAll(async () => {
  const fresh = await freshDatabase();
  ({ db, pool } = fresh);
  boss = new PgBoss(fresh.url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: key, secureCookies: false, mail });
  await app.init();
  owner = request.agent(app.getHttpServer());
  other = request.agent(app.getHttpServer());
  await owner.post("/auth/register").send({ email: "owner@scenarios.local", password: "correct horse battery" }).expect(201);
  await other.post("/auth/register").send({ email: "other@scenarios.local", password: "correct horse battery" }).expect(201);

  receiver = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/chat") {
      const { messages } = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      llmCalls.push({ system, user: messages.find((m) => m.role === "user")?.content ?? "" });
      const reply = system.includes("Classify") ? { label: /^- (\w+)/m.exec(system)![1] } : { summary: "A real-model summary." };
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: { content: JSON.stringify(reply) }, prompt_eval_count: 10, eval_count: 5 }));
    }
    received.push({ key: req.headers["idempotency-key"] as string | undefined, body });
    if (mode === "reset") return req.socket.destroy();
    res.writeHead(mode === "ok" ? 200 : mode === "bad_request" ? 400 : 503, { "Content-Type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  port = (receiver.address() as AddressInfo).port;
  process.env.LLM_PROVIDER = "ollama";
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
  // A port nothing listens on, for a connection that is refused before any request is written.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
}, 120_000);

afterAll(async () => {
  receiver?.close();
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

let seq = 0;
async function workflow(definition: unknown, { publish = false, agent = owner } = {}) {
  const wf = (await agent.post("/workflows").send({ name: `Scenario ${++seq}`, slug: `scenario-${seq}` }).expect(201)).body as { id: string };
  await agent.post(`/workflows/${wf.id}/versions`).send({ definition, publish }).expect(201);
  return wf.id;
}

const runRow = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0]!;
const TERMINAL = ["succeeded", "failed", "cancelled"];

/** Advances a run with the real executor until it finishes, waiting out mocked delays and the tiny retry backoff. */
async function finish(runId: string) {
  for (let i = 0; i < 200; i++) {
    const run = await runRow(runId);
    if (TERMINAL.includes(run.state)) return run;
    await advance(deps(), runId);
    if (run.nextAttemptAt && run.nextAttemptAt > new Date()) await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not finish`);
}

async function pathOf(runId: string): Promise<string[]> {
  const run = await runRow(runId);
  const rows = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));
  const path = rows.filter((r) => r.state === "succeeded").map((r) => r.stepId);
  const last = rows.at(-1);
  if (run.state === "failed" && last?.state === "failed") path.push(`${last.stepId}:failed`);
  return path;
}

/** Starts a builder test run the way the console does and returns its outcome. */
async function testRun(workflowId: string, definition: unknown, c: Pick<RunCase, "payload" | "options">, live = false): Promise<{ outcome: Outcome; runId?: string; errors?: string[] }> {
  const res = await owner.post(`/workflows/${workflowId}/test-runs`).send({ definition, payload: c.payload, live, ...c.options });
  if (res.status === 400) return { outcome: REJECTED, errors: (res.body as { message: string[] }).message };
  expect(res.status).toBe(202);
  const runId = (res.body as { id: string }).id;
  const run = await finish(runId);
  expect(run.state, `run error: ${run.error}`).not.toBe("cancelled");
  return { outcome: await pathOf(runId), runId };
}

const gapLabel = (c: RunCase) => (c.gap ? ` [gap ${c.gap.phase}: ${c.gap.why}]` : "");

/** Every fixture case: wanted outcome when it already holds, today's exact outcome when it is a known gap. */
function runCases(s: Scenario) {
  let id: string;
  it("fixture definition is valid with today's schema", async () => {
    expect(engine.definitionSchema.safeParse(s.definition).success).toBe(true);
    id = await workflow(s.definition);
  });
  for (const c of s.cases) {
    it(`${c.name}${gapLabel(c)}`, async () => {
      const { outcome, errors } = await testRun(id, s.definition, c);
      if (c.want === REJECTED && !c.gap) expect(errors).toEqual(c.rejects);
      if (c.gap) {
        expect(c.gap.today).not.toEqual(c.want);
        expect(outcome).toEqual(c.gap.today);
      } else {
        expect(outcome).toEqual(c.want);
      }
    });
  }
}

/** The fields the public form validates against, after today's schema has parsed the fixture. */
const formFields = (s: Scenario) => {
  const def = engine.definitionSchema.parse(s.definition);
  if (def.trigger.type !== "form") throw new Error(`${s.id} has no form trigger`);
  return def.trigger.config.fields;
};
/** What the public form says about a submission: [] when it is accepted. */
const formErrors = (s: Scenario, data: Record<string, unknown>) => {
  const r = engine.parsePayload(formFields(s), data);
  return r.ok ? [] : r.errors;
};

/** Today's save error for a definition that uses a capability a later phase adds. */
async function saveErrors(definition: unknown): Promise<string[]> {
  const wf = (await owner.post("/workflows").send({ name: `Desired ${++seq}`, slug: `desired-${seq}` }).expect(201)).body as { id: string };
  const res = await owner.post(`/workflows/${wf.id}/versions`).send({ definition, publish: false });
  expect(res.status).toBe(400);
  return (res.body as { message: string[] }).message;
}

describe("QA-01 sales lead prioritization", () => {
  runCases(qa01);
  const lead = { name: "Lea", email: "lea@example.com", details: "Clinic website" };

  it("the public form refuses a missing budget", () => {
    expect(formErrors(qa01, { ...lead })).toEqual(["budget: is required"]);
  });
  it("the public form refuses '45,000'", () => {
    expect(formErrors(qa01, { ...lead, budget: "45,000" })).toEqual(["budget: must be a number"]);
  });
  it("the public form refuses Infinity", () => {
    expect(formErrors(qa01, { ...lead, budget: "Infinity" })).toEqual(["budget: must be a number"]);
  });
  it("the public form refuses a negative budget and accepts exactly 0", () => {
    expect(formFields(qa01).find((f) => f.name === "budget")).toMatchObject({ min: 0 });
    expect(formErrors(qa01, { ...lead, budget: "-5000" })).toEqual(["budget: must be at least 0"]);
    expect(formErrors(qa01, { ...lead, budget: "0" })).toEqual([]);
  });
  it("an AI-only test run asks the model and nothing else", async () => {
    const id = await workflow(qa01.definition);
    const [calls, mails, posts] = [llmCalls.length, mailSent.length, received.length];
    const { outcome, runId } = await testRun(id, qa01.definition, { payload: { ...lead, budget: 200, details: "Fix a typo" }, options: { mode: "ai" } });
    expect(outcome).toEqual(["summarize", "gate", "classify", "route", "standard"]);
    const [summary] = await db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId!), eq(stepRuns.stepId, "summarize")));
    expect(summary!.output).toEqual({ summary: "A real-model summary." });
    expect(llmCalls.length - calls).toBe(2);
    expect([mailSent.length - mails, received.length - posts]).toEqual([0, 0]);
    expect(await db.select().from(deliveries).where(eq(deliveries.runId, runId!))).toHaveLength(0);
  });
  it("a chosen label wins over the model in an AI-only run", async () => {
    const id = await workflow(qa01.definition);
    const calls = llmCalls.length;
    const { outcome } = await testRun(id, qa01.definition, { payload: { ...lead, budget: 200, details: "Odd" }, options: { mode: "ai", choices: { classify: { label: "manual_review" } } } });
    expect(outcome).toEqual(["summarize", "gate", "classify", "route", "review"]);
    expect(llmCalls.length - calls).toBe(1);
  });
  it("choices that do not fit the workflow are refused and named", async () => {
    const id = await workflow(qa01.definition);
    const payload = { ...lead, budget: 200, details: "x" };
    expect((await testRun(id, qa01.definition, { payload, options: { choices: { classify: { label: "urgent" } } } })).errors).toEqual(['choices.classify: "urgent" is not a label of this classify step']);
    expect((await testRun(id, qa01.definition, { payload, options: { mode: "live", choices: { classify: { label: "standard" } } } })).errors).toEqual(["choices: a live test run makes real calls, so its outcomes cannot be chosen"]);
  });
  it("Build with AI is told that test runs mock outside calls, so it adds no dry-run branches", () => {
    expect(engine.draftPrompt({ request: "x" }).system).toMatch(/never add dry-run/i);
  });
  it("drafts are linted for dry-run branches and unrouted outcomes [gap P7: the engine has no lintDefinition]", () => {
    expect("lintDefinition" in engine).toBe(false);
  });
});

describe("QA-01 sales lead gate without field checks", () => {
  runCases(qa01Unchecked);

  it("without an invalid edge, '45,000' fails the run at the gate and says why", async () => {
    const id = await workflow(qa01NoInvalidEdge);
    const { outcome, runId } = await testRun(id, qa01NoInvalidEdge, { payload: { budget: "45,000" } });
    expect(outcome).toEqual(["gate:failed"]);
    const run = await runRow(runId!);
    expect(run.error).toBe('step gate: "gate" needs a number on both sides of gte, but got "45,000" and 30000. Add an "invalid" branch or check the field.');
    expect(await db.select().from(stepRuns).where(eq(stepRuns.runId, runId!))).toHaveLength(1);
  });
});

describe("QA-02 spa appointments", () => {
  runCases(qa02);

  it("a zoned datetime field can be saved [gap P6a: the field type is refused]", async () => {
    expect((await saveErrors(desired.datetimeField)).join("\n")).toMatch(/^trigger\.config\.fields\.1\.type: /m);
  });
  it("a resource field can be saved [gap P6a: the field type is refused]", async () => {
    expect((await saveErrors(desired.resourceField)).join("\n")).toMatch(/^trigger\.config\.fields\.1\.type: /m);
  });
  it("a delay relative to the appointment can be saved [gap P6a: a delay needs fixed seconds]", async () => {
    expect((await saveErrors(desired.relativeDelay)).join("\n")).toMatch(/^steps\.0\.config\.seconds: /m);
  });
  it("a booking step can be saved [gap P6b: there is no booking step type]", async () => {
    expect((await saveErrors(desired.bookingStep)).join("\n")).toMatch(/^steps\.0\.type: /m);
  });
  it("a mocked delay reports the real wake-up time [gap P6a: it reports the shortened one-second wait]", async () => {
    const id = await workflow(hourDelay);
    const started = Date.now();
    const { runId } = await testRun(id, hourDelay, { payload: {} });
    const [wait] = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId!));
    expect(new Date((wait!.output as { resumeAt: string }).resumeAt).getTime() - started).toBeLessThan(60_000);
  });
  it("a second booking for the same therapist and time is refused [gap P6b: both bookings are confirmed]", async () => {
    const id = await workflow(qa02.definition);
    const booking = { payload: { name: "Mia", email: "mia@example.com", service: "Massage", therapist: "Ana", appointment_at: "2027-01-20T14:00" } };
    expect((await testRun(id, qa02.definition, booking)).outcome).toEqual(["notify", "confirm"]);
    expect((await testRun(id, qa02.definition, booking)).outcome).toEqual(["notify", "confirm"]);
  });
  it("staff can list, cancel and reschedule bookings [gap P6b: there is no bookings API]", async () => {
    await owner.get("/bookings").expect(404);
  });
});

describe("QA-03 café promotion approval", () => {
  runCases(qa03);

  it("the public form refuses 80% and -5% and accepts exactly 50%", () => {
    expect(formErrors(qa03, { title: "Too generous", discount: "80" })).toEqual(["discount: must be at most 50"]);
    expect(formErrors(qa03, { title: "Negative", discount: "-5" })).toEqual(["discount: must be at least 0"]);
    expect(formErrors(qa03, { title: "Half off", discount: "50" })).toEqual([]);
  });
  it("a mocked approval writes no approval link and sends no email", async () => {
    const id = await workflow(qa03.definition);
    const before = mailSent.length;
    const { runId } = await testRun(id, qa03.definition, { payload: { title: "Rainy day", discount: 20 } });
    const links = await db.select().from(approvals).innerJoin(stepRuns, eq(stepRuns.id, approvals.stepRunId)).where(eq(stepRuns.runId, runId!));
    expect(links).toHaveLength(0);
    expect(mailSent.length).toBe(before);
  });
});

describe("QA-04 refund management", () => {
  runCases(qa04);

  it("the public form refuses an empty order ID on its own", () => {
    expect(formErrors(qa04, { order_id: "", amount: "500" })).toEqual(["order_id: is required"]);
  });
  it("the public form refuses a missing amount on its own", () => {
    expect(formErrors(qa04, { order_id: "ORD-1" })).toEqual(["amount: is required"]);
  });
  it("the public form refuses -10 on its own", () => {
    expect(formErrors(qa04, { order_id: "ORD-1", amount: "-10" })).toEqual(["amount: must be at least 0.01"]);
  });
  it("the console Run button checks the live version's fields too", async () => {
    const id = await workflow(qa04.definition, { publish: true });
    const res = await owner.post(`/workflows/${id}/runs`).send({ payload: { order_id: "", amount: -10 } }).expect(400);
    expect((res.body as { message: string[] }).message).toEqual(["order_id: is required", "amount: must be at least 0.01"]);
  });
});

describe("QA-05 office purchase requests", () => {
  runCases(qa05);

  it("the public form refuses a missing department on its own", () => {
    expect(formErrors(qa05, { item: "Pens", amount: "100" })).toEqual(["department: is required"]);
  });
  it("the public form refuses -1", () => {
    expect(formErrors(qa05, { item: "Pens", department: "HR", amount: "-1" })).toEqual(["amount: must be at least 0.01"]);
  });
  it("two overlapping test runs get their own run ids and branches", async () => {
    const id = await workflow(qa05.definition);
    const [a, b] = await Promise.all([
      testRun(id, qa05.definition, { payload: { item: "Laptop", department: "Finance", amount: 7_800 } }),
      testRun(id, qa05.definition, { payload: { item: "Chair", department: "HR", amount: 5_000 } }),
    ]);
    expect(a.runId).not.toBe(b.runId);
    expect(a.outcome).toEqual(["gate", "ask", "order", "log"]);
    expect(b.outcome).toEqual(["gate", "routine_log", "routine_notice"]);
  });
  it("a mocked sheet write queues no delivery and records no request", async () => {
    const id = await workflow(qa05.definition);
    const { runId } = await testRun(id, qa05.definition, { payload: { item: "Chair", department: "HR", amount: 100 } });
    expect(await db.select().from(deliveries).where(eq(deliveries.runId, runId!))).toHaveLength(0);
    expect(await db.select().from(requests).where(eq(requests.runId, runId!))).toHaveLength(0);
    const [log] = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId!)).orderBy(asc(stepRuns.createdAt)).offset(1).limit(1);
    expect(log!.output).toMatchObject({ mocked: true, reference: runId, row: [runId, expect.any(String), "Chair", "HR", "100", "routine"] });
  });
});

describe("QA-06 high-traffic e-commerce events", () => {
  runCases(qa06);
  let hookPath: string;
  const post = (body: object, headers: Record<string, string> = {}) => request(app.getHttpServer()).post(`/hooks/${hookPath}`).set(headers).send(body);
  const runsOf = async (ids: string[]) => db.select({ id: runs.id, state: runs.state }).from(runs).where(inArray(runs.id, ids));

  it("the intake graph is valid and published", async () => {
    expect(engine.definitionSchema.safeParse(intake).success).toBe(true);
    const id = await workflow(intake, { publish: true });
    hookPath = ((await owner.get(`/workflows/${id}`).expect(200)).body as { trigger: { webhookPath: string } }).trigger.webhookPath;
  });
  it("the same event delivered twice starts one run", async () => {
    const event = { event_id: "evt_dup", type: "refund.requested", amount: 15_000 };
    const first = (await post(event).expect(202)).body as { runId: string; duplicate?: boolean };
    const second = (await post(event).expect(202)).body as { runId: string; duplicate?: boolean };
    expect(first.duplicate).toBeUndefined();
    expect(second).toEqual({ runId: first.runId, duplicate: true });
  });
  it("20 concurrent copies of one event start one run", async () => {
    const event = { event_id: "evt_burst", type: "order.created", amount: 500 };
    const results = await Promise.all(Array.from({ length: 20 }, () => post(event)));
    expect(results.every((r) => r.status === 202)).toBe(true);
    const bodies = results.map((r) => r.body as { runId: string; duplicate?: boolean });
    expect(new Set(bodies.map((b) => b.runId)).size).toBe(1);
    expect(bodies.filter((b) => b.duplicate).length).toBe(19);
    expect(await db.select().from(runs).where(eq(runs.id, bodies[0]!.runId))).toHaveLength(1);
  });
  it("20 concurrent distinct events each run to completion", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post({ event_id: `evt_${i}`, type: "order.created", amount: i * 10_000 })));
    const ids = results.map((r) => (r.body as { runId: string }).runId);
    expect(new Set(ids).size).toBe(20);
    await Promise.all(ids.map((rid) => finish(rid)));
    expect((await runsOf(ids)).every((r) => r.state === "succeeded")).toBe(true);
  });
  it("without an event key, an Idempotency-Key header marks a repeat and no header means a new run", async () => {
    const id = await workflow(intakeNoKey, { publish: true });
    const path = ((await owner.get(`/workflows/${id}`).expect(200)).body as { trigger: { webhookPath: string } }).trigger.webhookPath;
    const send = (headers: Record<string, string> = {}) => request(app.getHttpServer()).post(`/hooks/${path}`).set(headers).send({ event_id: "evt_hdr", type: "order.created", amount: 500 }).expect(202);
    const a = (await send({ "Idempotency-Key": "client-key-1" })).body as { runId: string };
    const b = (await send({ "Idempotency-Key": "client-key-1" })).body as { runId: string; duplicate?: boolean };
    expect(b).toEqual({ runId: a.runId, duplicate: true });
    const c = (await send()).body as { runId: string; duplicate?: boolean };
    const d = (await send()).body as { runId: string; duplicate?: boolean };
    expect(new Set([a.runId, c.runId, d.runId]).size).toBe(3);
  });
  it("the same event id in another workflow is another event", async () => {
    const id = await workflow(intake, { publish: true });
    const path = ((await owner.get(`/workflows/${id}`).expect(200)).body as { trigger: { webhookPath: string } }).trigger.webhookPath;
    const res = await request(app.getHttpServer()).post(`/hooks/${path}`).send({ event_id: "evt_dup", type: "refund.requested", amount: 15_000 }).expect(202);
    expect((res.body as { duplicate?: boolean }).duplicate).toBeUndefined();
  });
  it("test runs have their own key scope: a live event never swallows a test, and a repeated test is a repeat", async () => {
    const id = await workflow(intake);
    const payload = { event_id: "evt_dup", type: "refund.requested", amount: 15_000 };
    const first = (await owner.post(`/workflows/${id}/test-runs`).send({ definition: intake, payload }).expect(202)).body as { id: string; duplicate?: boolean };
    const again = (await owner.post(`/workflows/${id}/test-runs`).send({ definition: intake, payload }).expect(202)).body as { id: string; duplicate?: boolean };
    expect(first.duplicate).toBeUndefined();
    expect(again).toMatchObject({ id: first.id, duplicate: true });
  });
  it("a repeated test event after a draft change reports the version and mode that actually ran", async () => {
    const id = await workflow(intake);
    const payload = { event_id: "evt_replay", type: "order.created", amount: 500 };
    const first = (await owner.post(`/workflows/${id}/test-runs`).send({ definition: intake, payload, mode: "live" }).expect(202)).body as { id: string; versionId: string };
    const changed = { ...intake, steps: intake.steps.map((s) => (s.id === "high" ? { ...s, config: { condition: { left: "{{trigger.amount}}", op: "gte", right: 20_000 } } } : s)) };
    const again = (await owner.post(`/workflows/${id}/test-runs`).send({ definition: changed, payload, mode: "mock" }).expect(202)).body as Record<string, unknown>;
    expect(again).toEqual({ id: first.id, versionId: first.versionId, mode: "live", duplicate: true });
  });
  it("the console Run button applies the event key too", async () => {
    const id = await workflow(intake, { publish: true });
    const payload = { event_id: "evt_console", type: "order.created", amount: 500 };
    const a = (await owner.post(`/workflows/${id}/runs`).send({ payload }).expect(202)).body as { id: string };
    const b = (await owner.post(`/workflows/${id}/runs`).send({ payload }).expect(202)).body as { id: string; duplicate?: boolean };
    expect(b).toEqual({ id: a.id, duplicate: true });
  });
  it("an event whose key comes out empty is refused and says so", async () => {
    const id = await workflow(intakeKeyOnly, { publish: true });
    const path = ((await owner.get(`/workflows/${id}`).expect(200)).body as { trigger: { webhookPath: string } }).trigger.webhookPath;
    const res = await request(app.getHttpServer()).post(`/hooks/${path}`).send({ type: "order.created", amount: 500 }).expect(400);
    expect((res.body as { message: string[] }).message).toEqual(["eventKey: {{trigger.event_id}} is empty for this event"]);
  });
  it("an event without event_id is refused and says which field", async () => {
    const res = await post({ type: "order.created", amount: 500 }).expect(400);
    expect((res.body as { message: string[] }).message).toEqual(["event_id: is required"]);
  });
  it("an event keeps its extra keys and gets its numbers read", async () => {
    const res = await post({ event_id: "evt_extra", type: "order.created", amount: "15000", shop: "north" }).expect(202);
    expect((await runRow((res.body as { runId: string }).runId)).triggerPayload).toEqual({ event_id: "evt_extra", type: "order.created", amount: 15_000, shop: "north" });
  });
  it("an unsigned call to a signed webhook is refused", async () => {
    const id = await workflow({ ...intake, trigger: { type: "webhook", config: { hmacSecret: "shop_signing_key" } } }, { publish: true });
    const path = ((await owner.get(`/workflows/${id}`).expect(200)).body as { trigger: { webhookPath: string } }).trigger.webhookPath;
    await request(app.getHttpServer()).post(`/hooks/${path}`).send({ event_id: "evt_x" }).expect(401);
  });
});

describe("QA-07 multi-tenant security", () => {
  runCases(qa07);
  let id: string;
  let runId: string;

  it("the adversarial run belongs to the owner's workspace", async () => {
    id = await workflow(qa07.definition);
    ({ runId } = (await testRun(id, qa07.definition, { payload: { request: ADVERSARIAL } })) as { runId: string });
    await owner.get(`/runs/${runId}`).expect(200);
  });
  it("another workspace cannot read the run", async () => {
    await other.get(`/runs/${runId}`).expect(404);
  });
  it("another workspace cannot read the workflow or start a test run on it", async () => {
    await other.get(`/workflows/${id}`).expect(404);
    await other.post(`/workflows/${id}/test-runs`).send({ definition: qa07.definition, payload: { request: "x" } }).expect(404);
  });
  it("another workspace's run list leaves the owner's runs out", async () => {
    const listed = (await other.get("/runs").expect(200)).body as { id: string }[];
    expect(listed.map((r) => r.id)).not.toContain(runId);
  });
  it("an AI step that names a stored secret cannot be saved", async () => {
    await owner.put("/secrets/api_key").send({ value: "sk-scenario-not-for-ai" }).expect(204);
    const errors = (await saveErrors(secretProbe)).join(" ");
    expect(errors).toMatch(/secret/i);
    expect(errors).not.toContain("sk-scenario-not-for-ai");
  });
  it("an AI-only test run sends the adversarial text to the model as data, and approves nothing for real", async () => {
    const [calls, mails] = [llmCalls.length, mailSent.length];
    const { outcome, runId: rid } = await testRun(id, qa07.definition, { payload: { request: ADVERSARIAL }, options: { mode: "ai" } });
    expect(outcome).toEqual(["summarize", "ask", "review"]);
    expect(llmCalls.length - calls).toBe(1);
    const call = llmCalls.at(-1)!;
    expect(call.user).toBe(`<data>\n${ADVERSARIAL}\n</data>`);
    expect(call.system).not.toContain("administrator");
    expect(mailSent.length).toBe(mails);
    const links = await db.select().from(approvals).innerJoin(stepRuns, eq(stepRuns.id, approvals.stepRunId)).where(eq(stepRuns.runId, rid!));
    expect(links).toHaveLength(0);
  });
});

describe("QA-08 failure recovery", () => {
  runCases(qa08);
  const live = async (m: Mode, url = `http://public.test:${port}/orders`) => {
    mode = m;
    received.length = 0;
    const def = liveOrder(url);
    const id = await workflow(def);
    const mailBefore = mailSent.length;
    const { outcome, runId } = await testRun(id, def, { payload: { order: "A-1" } }, true);
    const rows = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId!));
    return { outcome, runId: runId!, attempts: rows.filter((r) => r.stepId === "post").length, mails: mailSent.length - mailBefore, run: await runRow(runId!) };
  };

  it("a mocked run through approval, HTTP, Sheets and email sends nothing and stores no approval or delivery", async () => {
    const id = await workflow(qa08.definition);
    const [mails, posts] = [mailSent.length, received.length];
    const { outcome, runId } = await testRun(id, qa08.definition, { payload: { item: "Printer", amount: 8_000 } });
    expect(outcome).toEqual(["check", "ask", "post", "log", "notify"]);
    expect([mailSent.length - mails, received.length - posts]).toEqual([0, 0]);
    expect(await db.select().from(deliveries).where(eq(deliveries.runId, runId!))).toHaveLength(0);
    expect(await db.select().from(approvals).innerJoin(stepRuns, eq(stepRuns.id, approvals.stepRunId)).where(eq(stepRuns.runId, runId!))).toHaveLength(0);
  });
  it("a mocked step set to fail retryably is retried, then the run dead-letters", async () => {
    const id = await workflow(qa08.definition);
    const { outcome, runId } = await testRun(id, qa08.definition, { payload: { item: "Printer", amount: 8_000 }, options: { choices: { post: { fail: "retryable" } } } });
    expect(outcome).toEqual(["check", "ask", "post:failed"]);
    const posts = await db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId!), eq(stepRuns.stepId, "post")));
    expect(posts.map((r) => r.attempt).sort()).toEqual([1, 2, 3]);
    expect(posts.find((r) => r.attempt === 3)!.deadLetter).toBe(true);
  });
  it("a live POST that succeeds is sent once and the notification goes", async () => {
    const r = await live("ok");
    expect(r.outcome).toEqual(["post", "notify"]);
    expect(received).toHaveLength(1);
    expect(r.mails).toBe(1);
  });
  it("a 400 is not retried and the run fails", async () => {
    const r = await live("bad_request");
    expect(r.outcome).toEqual(["post:failed"]);
    expect(received).toHaveLength(1);
  });
  it("a refused connection is retried, since nothing was sent", async () => {
    const r = await live("ok", `http://public.test:${closedPort}/orders`);
    expect(r.outcome).toEqual(["post:failed"]);
    expect(r.attempts).toBe(3);
    expect(received).toHaveLength(0);
  });
  it("a 503 on a POST is sent once and parks for review [gap P5: it is resent automatically, three times]", async () => {
    const r = await live("unavailable");
    expect(r.run.state).toBe("failed");
    expect(received).toHaveLength(3);
  });
  it("every attempt of one step carries the same Idempotency-Key [gap P5: each attempt sends a new key]", async () => {
    await live("unavailable");
    expect(new Set(received.map((x) => x.key)).size).toBe(3);
  });
  it("a POST whose connection resets after the body was read parks for review [gap P5: it is resent automatically]", async () => {
    const r = await live("reset");
    expect(r.run.state).toBe("failed");
    expect(received).toHaveLength(3);
  });
  it("an operator can retry a failed run from the failed step [gap P5: there is no retry endpoint]", async () => {
    const r = await live("bad_request");
    await owner.post(`/runs/${r.runId}/retry`).send({}).expect(404);
  });
});
