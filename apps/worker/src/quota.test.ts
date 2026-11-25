import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { manilaDay, resolveRun, runs, stepRuns, usageCounts, users, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import { and, asc, eq } from "drizzle-orm";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { advance } from "./advance";
import { createExecutor } from "./steps";
import { BLOCKED_RANGES, blockListOf } from "./steps/ssrf";

// Plan quotas at the outside call (N6): counted once per step, right before the call, never for a faked run.
const key = randomBytes(32);
let db: Db;
let pool: Pool;
let server: Server;
let port: number;
const sent: string[] = [];
let loseNextAck = false;
let modelCalls = 0;
let forceModelStatus: number | null = null;
let httpCalls = 0;

const mail: MailDeps = {
  installation: {
    from: "kymavo <daloy@localhost>",
    transport: {
      sendMail: async (msg: SendMailOptions) => {
        const info = await nodemailer.createTransport({ jsonTransport: true }).sendMail(msg);
        sent.push(String(info.message));
        if (loseNextAck) {
          loseNextAck = false;
          throw Object.assign(new Error("connection reset after DATA"), { code: "ECONNRESET" });
        }
        return info;
      },
    } as unknown as Transporter,
  },
  gmail: () => {
    throw new Error("no Gmail in this test");
  },
  sharedMail: "open",
};

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  // The model and the web API both fail once per run, then answer: the first attempt of a retried step.
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url!.startsWith("/api/chat")) {
        if (forceModelStatus !== null) {
          res.writeHead(forceModelStatus, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "forced failure" }));
        }
        const first = ++modelCalls % 2 === 1;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: { role: "assistant", content: first ? '{"label":"admin"}' : '{"label":"billing"}' }, prompt_eval_count: 1, eval_count: 1 }));
      }
      const first = ++httpCalls % 2 === 1;
      res.writeHead(first ? 503 : 200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${port}`);
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  server?.closeAllConnections();
  server?.close();
  await pool?.end();
});

const deps = () => ({
  db,
  executor: createExecutor({
    db,
    secretsKey: key,
    mail,
    publicUrl: "https://daloy.example.com",
    guard: { blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")), ports: ["", String(port)], resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
  }),
  owner: "test",
  leaseMs: 5000,
  retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  enqueue: async () => {},
});

const emailStep = (id = "send", to = "a@example.com") => ({ id, type: "email", config: { to, subject: "Hi", text: "Hello" } });
const httpStep = (id = "call") => ({ id, type: "http", config: { method: "GET", url: `http://api.test:${port}/x`, headers: {} } });
const aiStep = (id = "think") => ({ id, type: "ai", config: { task: "classify", input: "x", labels: { billing: "Invoices", support: "Everything else" } } });
const approvalStep = { id: "ask", type: "approval", config: { to: "boss@example.com", subject: "Refund?", message: "Refund?", timeoutSeconds: 3600 } };
const flow = (...steps: { id: string }[]) => ({ trigger: { type: "manual", config: {} }, steps, edges: steps.slice(1).map((s, i) => ({ from: steps[i]!.id, to: s.id })) });

let seq = 0;
async function newUser(plan: "pilot" | "business" | null = "pilot") {
  return (await db.insert(users).values({ email: `u${++seq}@test.local`, passwordHash: "x", plan }).returning())[0]!.id;
}
async function newRun(userId: string, definition: object, opts: Partial<typeof runs.$inferInsert> = {}) {
  const [wf] = await db.insert(workflows).values({ userId, name: "Q", slug: `q-${++seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true }).returning();
  return (await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {}, ...opts }).returning())[0]!.id;
}
const state = async (runId: string) => (await db.select().from(runs).where(eq(runs.id, runId)))[0]!;
const attempts = (runId: string) => db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));
/** Advances until the run stops, waiting out the tiny retry backoff. */
async function drive(runId: string) {
  for (let i = 0; i < 30; i++) {
    if (["succeeded", "failed", "cancelled", "needs_review", "waiting"].includes((await state(runId)).state)) return state(runId);
    await advance(deps(), runId);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${runId} did not stop`);
}
const usedOf = async (userId: string, kind: string) => (await db.select({ used: usageCounts.used }).from(usageCounts).where(and(eq(usageCounts.userId, userId), eq(usageCounts.kind, kind)))).reduce((n, r) => n + r.used, 0);
const seed = (userId: string, kind: "email" | "http", used: number) => db.insert(usageCounts).values({ userId, kind, period: manilaDay(), used });

describe("plan quotas at the outside call", () => {
  it("fails an email at the limit with the plain message, nothing sent and nothing counted", async () => {
    const userId = await newUser();
    await seed(userId, "email", 100);
    const runId = await newRun(userId, flow(emailStep()));
    const before = sent.length;
    expect((await drive(runId)).state).toBe("failed");
    expect(sent.length).toBe(before);
    const [row] = await attempts(runId);
    expect(row).toMatchObject({ state: "failed", outcome: "not_sent", error: "This office reached today's limit of 100 email recipients. Sending starts again tomorrow, Manila time. Press Retry on this run then." });
    expect(await attempts(runId)).toHaveLength(1);
    expect(await usedOf(userId, "email")).toBe(100);
  });

  it("counts every recipient of an email", async () => {
    const userId = await newUser();
    await seed(userId, "email", 98);
    const runId = await newRun(userId, flow(emailStep("send", "a@example.com, b@example.com, c@example.com")));
    expect((await drive(runId)).state).toBe("failed");
    expect(await usedOf(userId, "email")).toBe(98);
  });

  it("lets exactly one of two runs racing for the last email unit send", async () => {
    const userId = await newUser();
    await seed(userId, "email", 99);
    const [a, b] = await Promise.all([newRun(userId, flow(emailStep())), newRun(userId, flow(emailStep()))]);
    const before = sent.length;
    const ended = await Promise.all([drive(a!), drive(b!)]);
    expect(ended.map((r) => r.state).sort()).toEqual(["failed", "succeeded"]);
    expect(sent.length - before).toBe(1);
    expect(await usedOf(userId, "email")).toBe(100);
  });

  it("counts a retried HTTP step once", async () => {
    const userId = await newUser();
    const runId = await newRun(userId, flow(httpStep()));
    expect((await drive(runId)).state).toBe("succeeded");
    expect((await attempts(runId)).map((r) => [r.attempt, r.state])).toEqual([[1, "failed"], [2, "succeeded"]]);
    expect(await usedOf(userId, "http")).toBe(1);
  });

  it("counts a retried AI step once", async () => {
    const userId = await newUser();
    const runId = await newRun(userId, flow(aiStep()));
    expect((await drive(runId)).state).toBe("succeeded");
    expect((await attempts(runId)).map((r) => [r.attempt, r.state])).toEqual([[1, "failed"], [2, "succeeded"]]);
    expect(await usedOf(userId, "ai")).toBe(1);
  });

  it("spends 0 AI quota when an answer step has no published knowledge or the model fails", async () => {
    const userId = await newUser();
    const answerFlow = flow({ id: "answer", type: "ai", config: { task: "answer", input: "Hi" } } as { id: string });
    const noKnowledgeRun = await newRun(userId, answerFlow, { test: true, aiLive: true });
    const stopped = await drive(noKnowledgeRun);
    expect(stopped.state).toBe("failed");
    expect(stopped.error).toContain("Knowledge page");
    expect(stopped.error).not.toContain("Business, Knowledge");
    expect(await usedOf(userId, "ai")).toBe(0);

    forceModelStatus = 401;
    try {
      const failedRun = await newRun(userId, flow(aiStep()), { test: true, aiLive: true });
      expect((await drive(failedRun)).state).toBe("failed");
      expect(await usedOf(userId, "ai")).toBe(0);
    } finally {
      forceModelStatus = null;
    }
  });

  it("counts a retried approval link email once, and an approval at the limit asks nobody", async () => {
    const userId = await newUser();
    const runId = await newRun(userId, { ...flow(approvalStep), edges: [] });
    const before = sent.length;
    loseNextAck = true;
    expect((await drive(runId)).state).toBe("waiting");
    expect(sent.length - before).toBe(2);
    expect(await usedOf(userId, "email")).toBe(1);

    const full = await newUser();
    await seed(full, "email", 100);
    const blocked = await newRun(full, { ...flow(approvalStep), edges: [] });
    expect((await drive(blocked)).state).toBe("failed");
    expect(sent.length - before).toBe(2);
  });

  it("counts nothing for a faked test run, and only the AI step of an AI-only test run", async () => {
    const userId = await newUser();
    const all = flow(emailStep(), httpStep(), aiStep());
    expect((await drive(await newRun(userId, all, { test: true }))).state).toBe("succeeded");
    expect(await usedOf(userId, "email") + (await usedOf(userId, "http")) + (await usedOf(userId, "ai"))).toBe(0);

    const before = sent.length;
    expect((await drive(await newRun(userId, all, { test: true, aiLive: true }))).state).toBe("succeeded");
    expect([await usedOf(userId, "email"), await usedOf(userId, "http"), await usedOf(userId, "ai")]).toEqual([0, 0, 1]);
    expect(sent.length).toBe(before);
  });

  it("sends and counts once when the operator presses Retry after the plan grew", async () => {
    const userId = await newUser();
    await seed(userId, "email", 100);
    const runId = await newRun(userId, flow(emailStep()));
    expect((await drive(runId)).state).toBe("failed");
    const before = sent.length;
    await db.update(users).set({ plan: "business" }).where(eq(users.id, userId));
    expect(await resolveRun(db, userId, runId, "retry", "ops@test.local")).toBe(true);
    expect((await drive(runId)).state).toBe("succeeded");
    expect(sent.length - before).toBe(1);
    expect(await usedOf(userId, "email")).toBe(101);
    expect((await attempts(runId)).map((r) => [r.attempt, r.state])).toEqual([[1, "failed"], [2, "succeeded"]]);
  });

  it("never limits a workspace with no plan, but still counts", async () => {
    const userId = await newUser(null);
    await seed(userId, "email", 5000);
    expect((await drive(await newRun(userId, flow(emailStep())))).state).toBe("succeeded");
    expect(await usedOf(userId, "email")).toBe(5001);
  });
});

describe("a run held because nothing was sent (N11b)", () => {
  it("cannot be marked as delivered, but can be sent again or stopped", async () => {
    const userId = await newUser();
    const runId = await newRun(userId, flow(emailStep()), { state: "needs_review", error: "step send: nothing was sent" });
    await db.insert(stepRuns).values({ runId, stepId: "send", attempt: 1, state: "failed", outcome: "not_sent", error: "nothing was sent" });
    expect(await resolveRun(db, userId, runId, "delivered", "ops@test.local")).toBe(false);
    expect((await state(runId)).state).toBe("needs_review");
    expect(await resolveRun(db, userId, runId, "again", "ops@test.local")).toBe(true);
    expect((await state(runId)).state).toBe("running");

    // A lost answer (unknown) still allows "It went through".
    const lost = await newRun(userId, flow(emailStep()), { state: "needs_review" });
    await db.insert(stepRuns).values({ runId: lost, stepId: "send", attempt: 1, state: "failed", outcome: "unknown" });
    expect(await resolveRun(db, userId, lost, "delivered", "ops@test.local")).toBe(true);
  });
});
