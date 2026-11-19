import { randomBytes } from "node:crypto";
import { bookings, createApproval, encryptSecret, recordDecision, resources, retiredSecrets, runs, SCHEDULE_QUEUE, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { evaluateCondition, StepError } from "@daloy/engine";
import { asc, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import type { StepExecutor } from "./advance";
import { startWorker, type Worker } from "./worker";

// Integration tests against a real Postgres (see test/global-setup.ts).
let db: Db;
let pool: Pool;
let worker: Worker;
let dbUrl: string;
const calls: string[] = [];
// runId -> its booking, for steps that change the booking as if staff did it while the step runs (decision 0032).
const bookingOf = new Map<string, string>();
const changeBooking = (runId: string) => db.update(bookings).set({ version: sql`${bookings.version} + 1` }).where(eq(bookings.id, bookingOf.get(runId)!));
const approvalTokens = new Map<string, string>();

// Test steps behave according to their id, so each test builds the failure it needs.
const executor: StepExecutor = {
  async execute({ runId, stepRunId, step, attempt, idempotencyKey, ctx, claimSend }) {
    calls.push(idempotencyKey);
    if (step.id === "staff_changes") await changeBooking(runId);
    if (step.id === "changes_then_fails") {
      await changeBooking(runId);
      throw new StepError("receiver down", true);
    }
    if (step.id === "changes_then_sends") {
      await changeBooking(runId);
      const release = await claimSend!();
      release();
      calls.push(`${idempotencyKey}:sent`);
      return {};
    }
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
  ({ url: dbUrl, db, pool } = await freshDatabase());
  worker = await startWorker({
    connectionString: dbUrl,
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
    if (run!.state === "succeeded" || run!.state === "failed" || run!.state === "cancelled") return run!;
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

describe("schedule guard (plan minimum interval)", () => {
  // Fires the schedule queue like pg-boss's cron does, and waits until the worker has handled the job.
  async function fire(workflowId: string) {
    const boss = new PgBoss({ connectionString: dbUrl });
    await boss.start();
    try {
      const id = (await boss.send(SCHEDULE_QUEUE, { workflowId }))!;
      for (let i = 0; i < 100; i++) {
        if ((await boss.getJobById(SCHEDULE_QUEUE, id))?.state === "completed") return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("schedule job was not handled");
    } finally {
      await boss.stop({ graceful: false });
    }
  }
  const runsOf = (workflowId: string) => db.select({ id: runs.id }).from(runs).innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId)).where(eq(workflowVersions.workflowId, workflowId));

  async function scheduled(plan: string | null) {
    const [user] = await db.insert(users).values({ email: `s${++seq}@test.local`, passwordHash: "x", plan }).returning();
    const [wf] = await db.insert(workflows).values({ userId: user!.id, name: "s", slug: `s${seq}` }).returning();
    await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: flow({ id: "a" }), published: true });
    return wf!.id;
  }

  it("skips a fire inside the plan's minimum interval and runs one after it", async () => {
    const wf = await scheduled("pilot");
    await fire(wf);
    expect(await runsOf(wf)).toHaveLength(1);
    await fire(wf);
    expect(await runsOf(wf)).toHaveLength(1);
    // 59 minutes 45 seconds is an hourly cron firing a little early: within the tolerance, so it runs.
    for (const { id } of await runsOf(wf)) await db.update(runs).set({ createdAt: sql`now() - interval '3585 seconds'` }).where(eq(runs.id, id));
    await fire(wf);
    expect(await runsOf(wf)).toHaveLength(2);
  }, 30_000);

  it("does not count a test run, and puts no guard on a workspace with no plan", async () => {
    const wf = await scheduled("pilot");
    const [v] = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf));
    await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {}, test: true });
    await fire(wf);
    expect(await runsOf(wf)).toHaveLength(2);

    const free = await scheduled(null);
    await fire(free);
    await fire(free);
    expect(await runsOf(free)).toHaveLength(2);
  }, 30_000);

  it("starts no run of a paused automation, and starts them again after the resume (N11b)", async () => {
    const wf = await scheduled(null);
    await db.update(workflows).set({ pausedAt: new Date() }).where(eq(workflows.id, wf));
    await fire(wf);
    await fire(wf);
    expect(await runsOf(wf)).toHaveLength(0);
    await db.update(workflows).set({ pausedAt: null, resumedAt: new Date() }).where(eq(workflows.id, wf));
    await fire(wf);
    expect(await runsOf(wf)).toHaveLength(1);
  }, 30_000);
});

describe("booking versions (decision 0032)", () => {
  async function linkedRun(definition: object) {
    const runId = await createRun(definition);
    const [owner] = await db.select({ userId: workflows.userId }).from(runs).innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId)).innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId)).where(eq(runs.id, runId));
    const [res] = await db.insert(resources).values({ userId: owner!.userId, name: "Ana" }).returning();
    const [b] = await db
      .insert(bookings)
      .values({ userId: owner!.userId, test: false, reference: `BK-${String(++seq).padStart(6, "0")}`, resourceId: res!.id, during: sql`tstzrange(now() + interval '1 day', now() + interval '25 hours')` as unknown as string, timezone: "UTC", runId })
      .returning();
    await db.update(runs).set({ bookingId: b!.id, bookingVersion: 1 }).where(eq(runs.id, runId));
    bookingOf.set(runId, b!.id);
    return runId;
  }
  const stopped = (step: string) => `The booking was rescheduled or cancelled, so this run stopped before step ${step}.`;

  it("stops a run at its next step once its booking changed", async () => {
    const runId = await linkedRun(flow({ id: "staff_changes" }, { id: "remind" }));
    await worker.enqueue(runId);
    expect(await waitForEnd(runId)).toMatchObject({ state: "cancelled", error: stopped("remind") });
    expect((await attemptsOf(runId)).map((r) => r.stepId)).toEqual(["staff_changes"]);
  });

  it("stops after a wait when the booking changed while it waited", async () => {
    const runId = await linkedRun(flow({ id: "pause" }, { id: "remind" }));
    await worker.enqueue(runId);
    for (let i = 0; i < 50 && (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.state !== "waiting"; i++) await new Promise((r) => setTimeout(r, 50));
    await changeBooking(runId);
    expect(await waitForEnd(runId)).toMatchObject({ state: "cancelled", error: stopped("remind") });
    expect((await attemptsOf(runId)).map((r) => [r.stepId, r.state])).toEqual([["pause", "succeeded"]]);
  });

  it("does not retry a step once the booking changed during its failed attempt", async () => {
    const runId = await linkedRun(flow({ id: "changes_then_fails" }, { id: "remind" }));
    await worker.enqueue(runId);
    expect(await waitForEnd(runId)).toMatchObject({ state: "cancelled", error: stopped("changes_then_fails") });
    expect(await attemptsOf(runId)).toHaveLength(1);
  });

  it("refuses an unsafe send when the change commits before the send claim", async () => {
    const runId = await linkedRun(flow({ id: "changes_then_sends", type: "email", config: { to: "mia@example.com", subject: "Reminder", text: "See you" } }));
    await worker.enqueue(runId);
    expect(await waitForEnd(runId)).toMatchObject({ state: "cancelled", error: stopped("changes_then_sends") });
    expect(calls.filter((c) => c.startsWith(runId) && c.endsWith(":sent"))).toEqual([]);
    expect((await attemptsOf(runId))[0]).toMatchObject({ state: "failed", outcome: "not_sent" });
  });

  it("lets a run whose own booking step moved the link carry on", async () => {
    const runId = await linkedRun(flow({ id: "own_change" }, { id: "remind" }));
    // As the booking step does: the change and the run's link move together.
    await db.update(runs).set({ bookingVersion: 2 }).where(eq(runs.id, runId));
    await changeBooking(runId);
    await worker.enqueue(runId);
    expect((await waitForEnd(runId)).state).toBe("succeeded");
  });
});

describe("schedule watchdog in a running worker (N17)", () => {
  it("flags a schedule that stopped, emails once, and clears the flag after the next fired run", async () => {
    const [user] = await db.insert(users).values({ email: `dog${++seq}@test.local`, passwordHash: "x" }).returning();
    const [wf] = await db.insert(workflows).values({ userId: user!.id, name: "Morning report", slug: `dog${seq}` }).returning();
    const definition = { trigger: { type: "schedule", config: { cron: "* * * * *" } }, steps: [{ id: "a", type: "condition", config: { condition: "true" } }] };
    await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true, createdAt: new Date(Date.now() - 3_600_000) });
    const outbox: string[][] = [];
    const transport = { sendMail: async (m: { to: string[] }) => { outbox.push(m.to); return {}; } };
    const watched = await startWorker({
      connectionString: dbUrl, db, executor, pollingIntervalSeconds: 0.5, sweepMs: 60_000,
      watchdog: { secretsKey: Buffer.alloc(32), mail: { installation: { transport: transport as never, from: "Daloy <daloy@localhost>" }, gmail: () => { throw new Error("unused"); }, sharedMail: "open" }, intervalMs: 100 },
    });
    const flagged = async () => (await db.select({ at: workflows.scheduleMissedAt }).from(workflows).where(eq(workflows.id, wf!.id)))[0]!.at;
    const until = async (done: () => Promise<boolean>) => { for (let i = 0; i < 100 && !(await done()); i++) await new Promise((r) => setTimeout(r, 100)); };
    try {
      // Nothing fires the schedule, as if the worker had been down: it is flagged, and the owner gets one email.
      await until(async () => (await flagged()) !== null);
      expect(await flagged()).not.toBeNull();
      await new Promise((r) => setTimeout(r, 500));
      expect(outbox).toEqual([[user!.email]]);
      // The schedule fires again: a run with firedAt is created and the flag goes.
      const boss = new PgBoss({ connectionString: dbUrl });
      await boss.start();
      try { await boss.send(SCHEDULE_QUEUE, { workflowId: wf!.id }); } finally { await boss.stop({ graceful: false }); }
      await until(async () => (await flagged()) === null);
      expect(await flagged()).toBeNull();
      expect(outbox).toHaveLength(1);
    } finally {
      await watched.stop();
    }
  });
});

describe("retired secret purge in a running worker (decision 0067)", () => {
  it("scrubs and deletes expired retired secrets on startup even when deliveries are omitted", async () => {
    const secretsKey = randomBytes(32);
    const [user] = await db.insert(users).values({ email: `purge-w${++seq}@test.local`, passwordHash: "x" }).returning();
    const [wf] = await db.insert(workflows).values({ userId: user!.id, name: "Purge", slug: `purge-w${seq}` }).returning();
    const [version] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: flow({ id: "a" }), published: true }).returning();
    const oldVal = `worker-old-${randomBytes(4).toString("hex")}`;
    const recentVal = `worker-new-${randomBytes(4).toString("hex")}`;
    const [run] = await db.insert(runs).values({ workflowVersionId: version!.id, state: "failed", triggerPayload: { oldVal, recentVal }, error: `failed ${oldVal}` }).returning();
    await db.insert(retiredSecrets).values([
      { userId: user!.id, name: "api_key", ...encryptSecret(secretsKey, user!.id, "api_key", oldVal), retiredAt: new Date(Date.now() - 95 * 86_400_000) },
      { userId: user!.id, name: "api_key", ...encryptSecret(secretsKey, user!.id, "api_key", recentVal), retiredAt: new Date(Date.now() - 10 * 86_400_000) },
    ]);

    const maintenance = await startWorker({ connectionString: dbUrl, db, executor, secretsKey, pollingIntervalSeconds: 0.5, sweepMs: 60_000 });
    try {
      for (let i = 0; i < 100; i++) {
        const left = await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, user!.id));
        if (left.length === 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const left = await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, user!.id));
      expect(left).toHaveLength(1);
      const [afterRun] = await db.select().from(runs).where(eq(runs.id, run!.id));
      expect(afterRun!.error).toBe("failed [secret]");
      expect(afterRun!.triggerPayload).toEqual({ oldVal: "[secret]", recentVal });
    } finally {
      await maintenance.stop();
    }
  });
});
