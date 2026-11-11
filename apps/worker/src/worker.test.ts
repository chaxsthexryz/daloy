import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, migrate, runs, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { evaluateCondition, StepError } from "@daloy/engine";
import { asc, eq } from "drizzle-orm";
import EmbeddedPostgres from "embedded-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StepExecutor } from "./advance";
import { startWorker, type Worker } from "./worker";

// Integration tests against a real Postgres: DATABASE_URL in CI, an embedded one locally.
let pg: EmbeddedPostgres | undefined;
let db: Db;
let pool: Pool;
let worker: Worker;
const calls: string[] = [];

// Test steps behave according to config.mode, so each test builds the failure it needs.
const executor: StepExecutor = {
  async execute({ step, attempt, idempotencyKey, ctx }) {
    calls.push(idempotencyKey);
    if (step.type === "condition") return { branch: String(evaluateCondition(step.config.condition, ctx)) };
    const mode = step.config.mode;
    if (mode === "flaky" && attempt < 2) throw new StepError("flaky", true);
    if (mode === "down") throw new StepError("service down", true);
    if (mode === "fatal") throw new StepError("bad config", false);
    return { output: { from: step.id } };
  },
};

beforeAll(async () => {
  let url = process.env.DATABASE_URL;
  if (!url) {
    pg = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), "daloy-pg-")), port: 54329, user: "daloy", password: "daloy", persistent: false, onLog: () => {} });
    await pg.initialise();
    await pg.start();
    url = "postgres://daloy:daloy@localhost:54329/postgres";
  }
  ({ db, pool } = createDb(url));
  await migrate(db);
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
  await pg?.stop();
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
  steps: steps.map((s) => ({ type: "http", config: {}, ...s })),
  edges: steps.slice(1).map((s, i) => ({ from: steps[i]!.id, to: s.id })),
});

describe("worker", () => {
  it("runs every step in order and passes outputs along", async () => {
    const runId = await createRun(flow({ id: "a" }, { id: "b", type: "email" }));
    await worker.enqueue(runId);
    expect((await waitForEnd(runId)).state).toBe("succeeded");
    const rows = await attemptsOf(runId);
    expect(rows.map((r) => [r.stepId, r.attempt, r.state])).toEqual([
      ["a", 1, "succeeded"],
      ["b", 1, "succeeded"],
    ]);
    expect(rows[0]!.output).toEqual({ from: "a" });
  });

  it("follows the branch a condition takes", async () => {
    const def = {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "check", type: "condition", config: { condition: { left: "{{trigger.vip}}", op: "eq", right: true } } },
        { id: "vip", type: "email", config: {} },
        { id: "normal", type: "email", config: {} },
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
    const runId = await createRun(flow({ id: "a", config: { mode: "flaky" } }));
    await worker.enqueue(runId);
    expect((await waitForEnd(runId)).state).toBe("succeeded");
    expect((await attemptsOf(runId)).map((r) => [r.attempt, r.state])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
  });

  it("dead-letters a step that uses up every attempt and fails the run", async () => {
    const runId = await createRun(flow({ id: "a", config: { mode: "down" } }, { id: "b" }));
    await worker.enqueue(runId);
    const run = await waitForEnd(runId);
    expect(run.state).toBe("failed");
    expect(run.error).toMatch(/service down/);
    const rows = await attemptsOf(runId);
    expect(rows.map((r) => [r.stepId, r.attempt, r.deadLetter])).toEqual([
      ["a", 1, false],
      ["a", 2, false],
      ["a", 3, true],
    ]);
  });

  it("fails at once on an error that is not retryable", async () => {
    const runId = await createRun(flow({ id: "a", config: { mode: "fatal" } }));
    await worker.enqueue(runId);
    expect((await waitForEnd(runId)).state).toBe("failed");
    expect((await attemptsOf(runId)).map((r) => [r.attempt, r.deadLetter])).toEqual([[1, false]]);
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
    expect(calls).toContain(`${runId}:a:1`);
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
});
