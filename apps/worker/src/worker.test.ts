import { createApproval, recordDecision, runs, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { evaluateCondition, StepError } from "@daloy/engine";
import { asc, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import type { StepExecutor } from "./advance";
import { startWorker, type Worker } from "./worker";

// Integration tests against a real Postgres (see test/global-setup.ts).
let db: Db;
let pool: Pool;
let worker: Worker;
const calls: string[] = [];
const approvalTokens = new Map<string, string>();

// Test steps behave according to their id, so each test builds the failure it needs.
const executor: StepExecutor = {
  async execute({ runId, stepRunId, step, attempt, idempotencyKey, ctx }) {
    calls.push(idempotencyKey);
    if (step.type === "approval") {
      // Like the real step, minus the email. "quick" times out after half a second.
      const waitUntil = new Date(Date.now() + (step.id === "quick" ? 500 : 60_000));
      approvalTokens.set(runId, (await createApproval(db, stepRunId, waitUntil))!.token);
      // "early": the approver answers while the email is still on its way, before the run is parked.
      if (step.id === "early") await recordDecision(db, approvalTokens.get(runId)!, "rejected");
      return { output: { expiresAt: waitUntil.toISOString() }, waitUntil };
    }
    if (step.id === "costly") throw new StepError("bad reply", false, { usage: { inputTokens: 90, outputTokens: 7 } });
    if (step.id === "model") return { output: { label: "billing" }, inputTokens: 50, outputTokens: 3 };
    if (step.type === "condition") return { branch: String(evaluateCondition(step.config.condition, ctx)) };
    if (step.id === "flaky" && attempt < 2) throw new StepError("flaky", true);
    if (step.id === "down") throw new StepError("service down", true);
    if (step.id === "fatal") throw new StepError("bad config", false, { input: { sent: "bad" } });
    if (step.id === "pause") return { waitUntil: new Date(Date.now() + 500) };
    return { input: { to: step.id }, output: { from: step.id } };
  },
};

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  worker = await startWorker({
    connectionString: url,
    db,
    executor,
    leaseMs: 2000,
    sweepMs: 200,
    pollingIntervalSeconds: 0.5,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
  });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  await pool?.end();
});

let seq = 0;
async function createRun(definition: object, triggerPayload: object = {}, extra: Partial<typeof runs.$inferInsert> = {}) {
  const [user] = await db.insert(users).values({ email: `u${++seq}@test.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: user!.id, name: "t", slug: `t${seq}` }).returning();
  const [version] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true }).returning();
  const [run] = await db.insert(runs).values({ workflowVersionId: version!.id, triggerPayload, ...extra }).returning();
  return run!.id;
}

async function waitForEnd(runId: string) {
  for (let i = 0; i < 150; i++) {
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    if (run!.state === "succeeded" || run!.state === "failed") return run!;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${runId} did not finish`);
}

const attemptsOf = (runId: string) =>
  db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));

const flow = (...steps: { id: string; type?: string; config?: object }[]) => ({
  trigger: { type: "manual", config: {} },
  steps: steps.map((s) => ({ type: "delay", config: { seconds: 1 }, ...s })),
  edges: steps.slice(1).map((s, i) => ({ from: steps[i]!.id, to: s.id })),
});

describe("worker", () => {
  it("runs every step in order and passes outputs along", async () => {
    const runId = await createRun(flow({ id: "a" }, { id: "b" }));
    await worker.enqueue(runId);
    expect((await waitForEnd(runId)).state).toBe("succeeded");
    const rows = await attemptsOf(runId);
    expect(rows.map((r) => [r.stepId, r.attempt, r.state])).toEqual([
      ["a", 1, "succeeded"],
      ["b", 1, "succeeded"],
    ]);
    expect(rows[0]!.output).toEqual({ from: "a" });
    expect(rows[0]!.input).toEqual({ to: "a" });
  });

  it("follows the branch a condition takes", async () => {
    const def = {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "check", type: "condition", config: { condition: { left: "{{trigger.vip}}", op: "eq", right: true } } },
        { id: "vip", type: "delay", config: { seconds: 1 } },
        { id: "normal", type: "delay", config: { seconds: 1 } },
      ],
      edges: [
        { from: "check", to: "vip", on: "true" },
        { from: "check", to: "normal", on: "false" },
      ],
    };
    const runId = await createRun(def, { vip: true });
    await worker.enqueue(runId);
    expect((await waitForEnd(runId)).state).toBe("succeeded");
    expect((await attemptsOf(runId)).map((r) => r.stepId)).toEqual(["check", "vip"]);
  });

  it("retries a retryable error and then succeeds", async () => {
    const runId = await createRun(flow({ id: "flaky" }));
    await worker.enqueue(runId);
    expect((await waitForEnd(runId)).state).toBe("succeeded");
    expect((await attemptsOf(runId)).map((r) => [r.attempt, r.state])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
  });

  it("dead-letters a step that uses up every attempt and fails the run", async () => {
    const runId = await createRun(flow({ id: "down" }, { id: "b" }));
    await worker.enqueue(runId);
    const run = await waitForEnd(runId);
    expect(run.state).toBe("failed");
    expect(run.error).toMatch(/service down/);
    const rows = await attemptsOf(runId);
    expect(rows.map((r) => [r.stepId, r.attempt, r.deadLetter])).toEqual([
      ["down", 1, false],
      ["down", 2, false],
      ["down", 3, true],
    ]);
  });

  it("fails at once on an error that is not retryable", async () => {
    const runId = await createRun(flow({ id: "fatal" }));
    await worker.enqueue(runId);
    expect((await waitForEnd(runId)).state).toBe("failed");
    expect((await attemptsOf(runId)).map((r) => [r.attempt, r.deadLetter, r.input])).toEqual([[1, false, { sent: "bad" }]]);
  });

  it("parks a run in waiting until the step's wake-up time, then carries on", async () => {
    const runId = await createRun(flow({ id: "pause" }, { id: "b" }));
    await worker.enqueue(runId);
    let sawWaiting = false;
    for (let i = 0; i < 50 && !sawWaiting; i++) {
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      sawWaiting = run!.state === "waiting";
      if (!sawWaiting) await new Promise((r) => setTimeout(r, 20));
    }
    expect(sawWaiting).toBe(true);
    expect((await waitForEnd(runId)).state).toBe("succeeded");
    expect((await attemptsOf(runId)).map((r) => [r.stepId, r.attempt, r.state])).toEqual([
      ["pause", 1, "succeeded"],
      ["b", 1, "succeeded"],
    ]);
    // The wait is one attempt: the executor ran once, and resuming did not call it again.
    expect(calls.filter((c) => c === `${runId}:pause`)).toHaveLength(1);
  });

  it("resumes a run whose worker died mid-step, with the same idempotency key", async () => {
    // State a crashed worker leaves behind: run and step running, lease expired, no job queued.
    const runId = await createRun(flow({ id: "a" }, { id: "b" }), {}, {
      state: "running",
      leaseOwner: "dead-worker",
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    await db.insert(stepRuns).values({ runId, stepId: "a", attempt: 1, state: "running" });

    expect((await waitForEnd(runId)).state).toBe("succeeded");
    expect(calls).toContain(`${runId}:a`);
    expect((await attemptsOf(runId)).map((r) => [r.stepId, r.attempt, r.state])).toEqual([
      ["a", 1, "succeeded"],
      ["b", 1, "succeeded"],
    ]);
  });

  it("leaves a run alone while another worker holds a live lease", async () => {
    const runId = await createRun(flow({ id: "a" }), {}, { leaseOwner: "other", leaseExpiresAt: new Date(Date.now() + 60_000) });
    await worker.enqueue(runId);
    await new Promise((r) => setTimeout(r, 1500));
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.state).toBe("pending");
    expect(await attemptsOf(runId)).toEqual([]);
  });

  describe("approval steps", () => {
    const approvalFlow = (id: string) => ({
      trigger: { type: "manual", config: {} },
      steps: [
        { id, type: "approval", config: { to: "boss@example.com", subject: "s", message: "m", timeoutSeconds: 60 } },
        { id: "yes", type: "delay", config: { seconds: 1 } },
        { id: "no", type: "delay", config: { seconds: 1 } },
        { id: "late", type: "delay", config: { seconds: 1 } },
      ],
      edges: [
        { from: id, to: "yes", on: "approved" },
        { from: id, to: "no", on: "rejected" },
        { from: id, to: "late", on: "timeout" },
      ],
    });

    async function waitForState(runId: string, state: string) {
      for (let i = 0; i < 100; i++) {
        const [run] = await db.select().from(runs).where(eq(runs.id, runId));
        if (run!.state === state) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`run ${runId} never reached ${state}`);
    }

    it("waits for the approver, then takes the branch they chose", async () => {
      const runId = await createRun(approvalFlow("ask"));
      await worker.enqueue(runId);
      await waitForState(runId, "waiting");

      expect(await recordDecision(db, approvalTokens.get(runId)!, "rejected")).toBe(runId);
      expect((await waitForEnd(runId)).state).toBe("succeeded");
      const rows = await attemptsOf(runId);
      expect(rows.map((r) => r.stepId)).toEqual(["ask", "no"]);
      expect(rows[0]).toMatchObject({ branch: "rejected", output: { decision: "rejected" } });
    });

    it("is not held up by a second job that arrives while it waits for the approver", async () => {
      const runId = await createRun(approvalFlow("ask"));
      await worker.enqueue(runId);
      await waitForState(runId, "waiting");
      // The sweep can queue a run again just before the first job takes the lease. That second job finds the run
      // waiting; if it scheduled the run for the approval timeout (60 s), the queue's one job per run would block the answer.
      for (let i = 0; i < 50 && (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.leaseOwner; i++) await new Promise((r) => setTimeout(r, 50));
      await worker.enqueue(runId);
      await new Promise((r) => setTimeout(r, 1500));

      expect(await recordDecision(db, approvalTokens.get(runId)!, "approved")).toBe(runId);
      expect((await waitForEnd(runId)).state).toBe("succeeded");
    }, 15_000);

    it("wakes at once for a decision made before the run was parked, not at the timeout", async () => {
      const runId = await createRun(approvalFlow("early"));
      await worker.enqueue(runId);
      expect((await waitForEnd(runId)).state).toBe("succeeded");
      const rows = await attemptsOf(runId);
      expect(rows.map((r) => r.stepId)).toEqual(["early", "no"]);
      expect(rows[0]!.branch).toBe("rejected");
    });

    it("takes the timeout branch when nobody answers, and the link stops working", async () => {
      const runId = await createRun(approvalFlow("quick"));
      await worker.enqueue(runId);
      expect((await waitForEnd(runId)).state).toBe("succeeded");
      const rows = await attemptsOf(runId);
      expect(rows.map((r) => r.stepId)).toEqual(["quick", "late"]);
      expect(rows[0]!.branch).toBe("timeout");
      expect(await recordDecision(db, approvalTokens.get(runId)!, "approved")).toBeNull();
    });
  });

  it("stores token counts for AI attempts, failed ones included", async () => {
    const ok = await createRun(flow({ id: "model" }));
    await worker.enqueue(ok);
    await waitForEnd(ok);
    expect((await attemptsOf(ok))[0]).toMatchObject({ inputTokens: 50, outputTokens: 3 });

    const bad = await createRun(flow({ id: "costly" }));
    await worker.enqueue(bad);
    expect((await waitForEnd(bad)).state).toBe("failed");
    expect((await attemptsOf(bad))[0]).toMatchObject({ state: "failed", inputTokens: 90, outputTokens: 7 });
  });
});
