import { approvals, claimTimeout, runs, stepRuns, workflows, workflowVersions, type Db } from "@daloy/db";
import {
  assertTransition,
  decideRetry,
  DEFAULT_RETRY_POLICY,
  definitionSchema,
  entryStep,
  idempotencyKey,
  nextStep,
  StepError,
  type ExpressionContext,
  type RetryPolicy,
  type RunState,
  type TestChoice,
  type Step,
  type StepState,
} from "@daloy/engine";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

/** waitUntil parks the step and the run in "waiting" until that time (delay, and the approval timeout). */
/** input is the resolved config the attempt ran with, already redacted. On failure it travels on StepError.input. */
export type StepResult = { input?: unknown; output?: unknown; branch?: string; inputTokens?: number; outputTokens?: number; waitUntil?: Date };

/** Runs one step attempt. userId is the workflow owner, whose secrets the step may use. mock is set for builder test runs without live calls. */
export interface StepExecutor {
  execute(input: { runId: string; stepRunId: string; userId: string; step: Step; attempt: number; idempotencyKey: string; ctx: ExpressionContext; mock?: boolean; aiLive?: boolean; choice?: TestChoice }): Promise<StepResult>;
}

export type AdvanceDeps = {
  db: Db;
  executor: StepExecutor;
  owner: string;
  leaseMs: number;
  retryPolicy?: RetryPolicy;
  enqueue: (runId: string, startAfter?: Date) => Promise<void>;
};

type Run = typeof runs.$inferSelect;
type Writer = Pick<Db, "update">;

const leaseUntil = (ms: number) => sql`now() + make_interval(secs => ${ms / 1000})`;

// Each state change is a single guarded UPDATE: it only applies if the row is still in `from`.
async function moveRun(w: Writer, id: string, from: RunState, to: RunState, extra: Partial<Run> = {}) {
  assertTransition("run", from, to);
  const moved = await w.update(runs).set({ ...extra, state: to }).where(and(eq(runs.id, id), eq(runs.state, from))).returning({ id: runs.id });
  if (moved.length !== 1) throw new Error(`run ${id} was not ${from}`);
}

async function moveStep(w: Writer, id: string, from: StepState, to: StepState, extra: Partial<typeof stepRuns.$inferSelect> = {}) {
  assertTransition("step", from, to);
  const moved = await w.update(stepRuns).set({ ...extra, state: to }).where(and(eq(stepRuns.id, id), eq(stepRuns.state, from))).returning({ id: stepRuns.id });
  if (moved.length !== 1) throw new Error(`step run ${id} was not ${from}`);
}

/**
 * Does the next piece of work for one run (one step attempt, or finishing the run), then enqueues the run again.
 * The lease makes sure only one worker advances a run at a time.
 */
export async function advance(deps: AdvanceDeps, runId: string): Promise<void> {
  const { db, owner, leaseMs } = deps;
  const [run] = await db
    .update(runs)
    .set({ leaseOwner: owner, leaseExpiresAt: leaseUntil(leaseMs) })
    .where(and(eq(runs.id, runId), inArray(runs.state, ["pending", "running", "waiting"]), or(isNull(runs.leaseExpiresAt), lt(runs.leaseExpiresAt, sql`now()`))))
    .returning();
  // Another worker holds the lease, or the run has finished.
  if (!run) return;

  const heartbeat = setInterval(() => {
    db.update(runs)
      .set({ leaseExpiresAt: leaseUntil(leaseMs) })
      .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)))
      .catch((err: unknown) => console.error("lease heartbeat failed", runId, err));
  }, leaseMs / 3);
  try {
    await runNext(deps, run);
  } finally {
    clearInterval(heartbeat);
    await db.update(runs).set({ leaseOwner: null, leaseExpiresAt: null }).where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)));
  }
}

async function runNext(deps: AdvanceDeps, run: Run): Promise<void> {
  const { db } = deps;
  // Not before the backoff delay or the wake-up time of a waiting step is over. Nothing is scheduled here: the retry or
  // delay already has a job for that time, and the sweep covers a lost one. A job scheduled here for an approval's
  // timeout would block the earlier wake-up an approver's answer needs, since the queue holds one job per run.
  if (run.nextAttemptAt && run.nextAttemptAt > new Date()) return;

  const [version] = await db
    .select({ definition: workflowVersions.definition, userId: workflows.userId })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(workflowVersions.id, run.workflowVersionId));
  const def = definitionSchema.parse(version!.definition);
  if (run.state === "pending") await moveRun(db, run.id, "pending", "running");

  const history = await db.select().from(stepRuns).where(eq(stepRuns.runId, run.id)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));
  const last = history.at(-1);

  if (run.state === "waiting") {
    // The wake-up time has passed (checked above), or an approver answered, so the waiting step is done and the run carries on.
    const waiting = def.steps.find((s) => s.id === last!.stepId)!;
    const resumed = await db.transaction(async (tx) => {
      const extra: Partial<typeof stepRuns.$inferSelect> = { finishedAt: new Date() };
      if (waiting.type === "approval") {
        // The recorded decision, or "timeout" if nobody answered by the deadline (decision 0009).
        // A named approval also keeps who decided and when (decision 0022), so later steps and the run history can show it.
        const outcome = await claimTimeout(tx, last!.id);
        if (outcome.branch === null) {
          // Woken early with nobody's answer: keep waiting until the deadline. The sweep picks it up then.
          await tx.update(runs).set({ nextAttemptAt: outcome.pendingUntil }).where(and(eq(runs.id, run.id), eq(runs.state, "waiting")));
          return false;
        }
        const { branch, decidedBy, decidedAt } = outcome;
        extra.branch = branch;
        extra.output = { ...(last!.output as object), decision: branch, ...(decidedBy ? { decidedBy, decidedAt } : {}) };
      }
      await moveStep(tx, last!.id, "waiting", "succeeded", extra);
      await moveRun(tx, run.id, "waiting", "running", { nextAttemptAt: null });
      Object.assign(last!, extra);
      return true;
    });
    if (!resumed) return;
    last!.state = "succeeded";
  }

  let step: Step;
  let attempt = 1;
  let stepRunId: string | undefined;
  if (!last) {
    step = entryStep(def);
  } else if (last.state === "succeeded") {
    const next = nextStep(def, last.stepId, last.branch ?? undefined);
    if (!next) return moveRun(db, run.id, "running", "succeeded", { finishedAt: new Date() });
    step = next;
  } else {
    step = def.steps.find((s) => s.id === last.stepId)!;
    if (last.state === "failed") {
      // The run is still running, so this failure was scheduled for a retry.
      attempt = last.attempt + 1;
    } else {
      // A worker died mid-attempt. Run the same attempt again: same row, same idempotency key.
      attempt = last.attempt;
      stepRunId = last.id;
    }
  }

  // Created straight in "running": the row only exists once a worker has started the attempt.
  stepRunId ??= (await db.insert(stepRuns).values({ runId: run.id, stepId: step.id, attempt, state: "running" }).returning({ id: stepRuns.id }))[0]!.id;

  const ctx: ExpressionContext = {
    trigger: run.triggerPayload,
    steps: Object.fromEntries(history.filter((r) => r.state === "succeeded").map((r) => [r.stepId, { output: r.output }])),
  };

  let result: StepResult;
  try {
    result = await deps.executor.execute({ runId: run.id, stepRunId, userId: version!.userId, step, attempt, idempotencyKey: idempotencyKey(run.id, step.id, attempt), ctx, mock: run.test && !run.live, aiLive: run.aiLive, choice: (run.testChoices as Record<string, TestChoice> | null)?.[step.id] });
    // A comparison on a missing or non-number value has nowhere to go without an "invalid" edge, so it fails here
    // and run history says why, instead of quietly taking "false" (decision 0027). Retrying would see the same data.
    if (step.type === "condition" && result.branch === "invalid" && !def.edges.some((e) => e.from === step.id && e.on === "invalid")) {
      const { left, op, right } = result.input as { left: unknown; op: string; right: unknown };
      throw new StepError(`"${step.id}" needs a number on both sides of ${op}, but got ${JSON.stringify(left) ?? "nothing"} and ${JSON.stringify(right) ?? "nothing"}. Add an "invalid" branch or check the field.`, false, { input: result.input });
    }
  } catch (err) {
    const decision = decideRetry(err, attempt, deps.retryPolicy ?? DEFAULT_RETRY_POLICY);
    const message = err instanceof Error ? err.message : String(err);
    // A faked test run retries within a second, like its delays, so the builder shows the outcome straight away.
    const retryAt = decision.kind === "retry" ? new Date(Date.now() + (run.test && !run.live ? Math.min(decision.delayMs, 1000) : decision.delayMs)) : undefined;
    await db.transaction(async (tx) => {
      const input = err instanceof StepError ? err.input : null;
      const usage = err instanceof StepError ? err.usage : undefined;
      await moveStep(tx, stepRunId, "running", "failed", { input, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, error: message, deadLetter: decision.kind === "dead_letter", finishedAt: new Date() });
      if (retryAt) await tx.update(runs).set({ nextAttemptAt: retryAt }).where(eq(runs.id, run.id));
      else await moveRun(tx, run.id, "running", "failed", { error: `step ${step.id}: ${message}`, finishedAt: new Date() });
    });
    if (retryAt) await deps.enqueue(run.id, retryAt);
    return;
  }

  if (result.waitUntil) {
    let wakeAt = result.waitUntil;
    await db.transaction(async (tx) => {
      // An approver can answer while the email is on its way, before the run is waiting, so recordDecision's wake-up
      // missed it. The run lock (taken first, like every approval write) waits for a decision still being written.
      // Answered already, through this link or an earlier attempt's: wake now, not at the deadline.
      if (step.type === "approval") {
        await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, run.id)).for("update");
        const [link] = await tx.select({ usedAt: approvals.usedAt }).from(approvals).where(eq(approvals.stepRunId, stepRunId));
        if (link?.usedAt) wakeAt = new Date();
      }
      await moveStep(tx, stepRunId, "running", "waiting", { input: result.input ?? null, output: result.output ?? null });
      await moveRun(tx, run.id, "running", "waiting", { nextAttemptAt: wakeAt });
    });
    // An approval can be answered early, and the queue keeps one queued job per run, so a job scheduled for the
    // timeout would swallow the early wake-up. The sweep picks up the timeout instead (decision 0009).
    if (step.type === "approval" && wakeAt === result.waitUntil) return;
    // A scheduled job, so nothing sleeps in the worker. The sweep picks the run up too if this job is lost.
    return deps.enqueue(run.id, wakeAt);
  }

  await moveStep(db, stepRunId, "running", "succeeded", {
    input: result.input ?? null,
    output: result.output ?? null,
    branch: result.branch ?? null,
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    finishedAt: new Date(),
  });
  await deps.enqueue(run.id);
}
