import { assertTransition } from "@daloy/engine";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { approvals, runKeys, runs, stepRuns, workflows, workflowVersions } from "./schema";
import { saveUploads, type NewUpload } from "./uploads";
import { claimUsageInTx } from "./usage";

/** pg-boss queue the worker takes runs from. Jobs carry { runId } and use the run id as singletonKey. */
export const RUN_QUEUE = "advance-run";
// "short" keeps at most one queued job per run (singletonKey), so re-sending a run never piles up duplicates.
// No pg-boss retries: a failed job leaves the run without a lease, and the worker's sweep picks it up again.
// notify wakes a listening worker as soon as a job is sent, instead of at its next poll (2 s): each step is its own job.
export const RUN_QUEUE_OPTIONS = { policy: "short", retryLimit: 0, notify: true } as const;
/** pg-boss schedules for schedule triggers send { workflowId } here, keyed by workflow id. */
export const SCHEDULE_QUEUE = "schedule-trigger";

type AnyDb = NodePgDatabase<Record<string, unknown>>;

/** The live version of a workflow: the newest published one. */
export async function publishedVersion(db: AnyDb, workflowId: string) {
  const [version] = await db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.published, true)))
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  return version;
}

class Duplicate extends Error {}

/** A paused workflow starts no new run, from any trigger (decision 0054). The API answers 409; a schedule, email-in or PayMongo event just skips. */
export class WorkflowPausedError extends Error {
  override name = "WorkflowPausedError";
  constructor() {
    super("This automation is paused, so it starts no new runs. Resume it to start runs again.");
  }
}

/**
 * Pauses or resumes a workflow of this workspace. False for another workspace's or an unknown workflow. Pausing a paused
 * workflow keeps its first time; resuming a running one changes nothing. Runs already started are not touched.
 */
export async function setPaused(db: AnyDb, workspaceId: string, workflowId: string, paused: boolean): Promise<boolean> {
  const mine = and(eq(workflows.id, workflowId), eq(workflows.userId, workspaceId));
  const [found] = await db.select({ id: workflows.id }).from(workflows).where(mine);
  if (!found) return false;
  if (paused) await db.update(workflows).set({ pausedAt: new Date() }).where(and(mine, isNull(workflows.pausedAt)));
  else await db.update(workflows).set({ pausedAt: null, resumedAt: new Date() }).where(and(mine, isNotNull(workflows.pausedAt)));
  return true;
}

/**
 * Inserts a pending run unless this workflow already ran for the key (decision 0029). The key row and the run commit
 * together. A concurrent call with the same key waits on the primary key until the first commits, then rolls back its
 * own run and answers with the first one; if the first rolled back instead, the second goes ahead.
 */
export async function createKeyedRun(db: AnyDb, workflowId: string, workflowVersionId: string, triggerPayload: unknown, key: string | undefined, opts: RunOpts = {}): Promise<{ runId: string; duplicate?: true }> {
  if (key === undefined) return { runId: await createRun(db, workflowVersionId, triggerPayload, opts) };
  const test = opts.test ?? false;
  try {
    return await db.transaction(async (tx) => {
      const { uploads, ...runOpts } = opts;
      const runId = await createRun(tx, workflowVersionId, triggerPayload, runOpts);
      const claimed = await tx.insert(runKeys).values({ workflowId, test, key, runId }).onConflictDoNothing().returning({ runId: runKeys.runId });
      if (claimed.length === 0) throw new Duplicate();
      if (uploads) {
        if (uploads.claimKey && uploads.files.length > 0) {
          await claimUsageInTx(tx, uploads.userId, "upload", { n: uploads.files.length, key: uploads.claimKey });
        }
        await saveUploads(tx, { userId: uploads.userId, runId, files: uploads.files });
      }
      return { runId };
    });
  } catch (err) {
    if (!(err instanceof Duplicate)) throw err;
    return { runId: (await keyedRun(db, workflowId, key, test))!, duplicate: true };
  }
}

/** The run an event key already started, if any (decision 0029). */
export async function keyedRun(db: AnyDb, workflowId: string, key: string, test = false): Promise<string | undefined> {
  const [first] = await db.select({ runId: runKeys.runId }).from(runKeys).where(and(eq(runKeys.workflowId, workflowId), eq(runKeys.test, test), eq(runKeys.key, key)));
  return first?.runId;
}

/** uploads: the files of a hosted form submission, stored in the same transaction as the run. */
type RunOpts = { test?: boolean; live?: boolean; aiLive?: boolean; testChoices?: unknown; uploads?: { userId: string; files: NewUpload[]; claimKey?: string } };

/**
 * Throws WorkflowPausedError when the workflow that owns this version is paused. Call it in the transaction that inserts
 * the run: the workflow row is read under a share lock, so a pause waits for the runs being created and none starts
 * after it commits. Every place that inserts a run of a live workflow calls it (decision 0054).
 */
export async function assertNotPaused(tx: Pick<AnyDb, "select">, workflowVersionId: string) {
  const [wf] = await tx
    .select({ pausedAt: workflows.pausedAt })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(workflowVersions.id, workflowVersionId))
    .for("share", { of: workflows });
  if (wf?.pausedAt) throw new WorkflowPausedError();
}

/**
 * Inserts a pending run. The caller queues it; if that fails, the worker's sweep picks it up.
 * A paused workflow refuses it (WorkflowPausedError), except for a builder test run.
 */
export async function createRun(db: AnyDb, workflowVersionId: string, triggerPayload: unknown, opts: RunOpts = {}): Promise<string> {
  const { uploads, ...runOpts } = opts;
  return db.transaction(async (tx) => {
    if (!opts.test) await assertNotPaused(tx, workflowVersionId);
    const [run] = await tx.insert(runs).values({ workflowVersionId, triggerPayload, ...runOpts }).returning({ id: runs.id });
    if (uploads) await saveUploads(tx, { userId: uploads.userId, runId: run!.id, files: uploads.files });
    return run!.id;
  });
}

/**
 * An operator's answer to a run in review (decision 0030): "delivered" (It went through), "again" (Send again),
 * "stop", or "retry" for a failed run. One guarded UPDATE moves the run, so of two people clicking at once only one
 * acts; the other gets false, like a run of another workspace. The attempt it answers keeps who acted and when.
 * The caller queues the run unless it stopped.
 */
/**
 * Cancels a run that is pending or waiting on a delay or an approval (N11b). One guarded UPDATE moves the run, so of a
 * cancel and the worker's wake-up exactly one wins; a run that is running or in review is refused (review has Stop).
 * The waiting step is closed as not sent, and open approval links of the run stop working. False for another
 * workspace's run, an unknown id or a run in another state.
 */
export async function cancelRun(db: AnyDb, workspaceId: string, runId: string, actor: string): Promise<boolean> {
  assertTransition("run", "pending", "cancelled");
  assertTransition("run", "waiting", "cancelled");
  assertTransition("step", "waiting", "failed");
  const owned = sql`exists (select 1 from ${workflowVersions} join ${workflows} on ${workflows.id} = ${workflowVersions.workflowId} where ${workflowVersions.id} = ${runs.workflowVersionId} and ${workflows.userId} = ${workspaceId})`;
  return db.transaction(async (tx) => {
    const note = `Cancelled by ${actor}.`;
    const moved = await tx
      .update(runs)
      .set({ state: "cancelled", error: note, finishedAt: new Date() })
      .where(and(eq(runs.id, runId), inArray(runs.state, ["pending", "waiting"]), owned))
      .returning({ id: runs.id });
    if (moved.length === 0) return false;
    await tx.update(stepRuns).set({ state: "failed", outcome: "not_sent", error: note, resolvedBy: actor, resolvedAt: new Date(), finishedAt: new Date() }).where(and(eq(stepRuns.runId, runId), eq(stepRuns.state, "waiting")));
    await tx.update(approvals).set({ expiresAt: sql`now()` }).where(and(isNull(approvals.usedAt), sql`${approvals.stepRunId} in (select id from step_runs where run_id = ${runId})`));
    return true;
  });
}

export type RunAction = "delivered" | "again" | "stop" | "retry";
export async function resolveRun(db: AnyDb, workspaceId: string, runId: string, action: RunAction, actor: string): Promise<boolean> {
  const from = action === "retry" ? "failed" : "needs_review";
  const to = action === "stop" ? "cancelled" : "running";
  assertTransition("run", from, to);
  const owned = sql`exists (select 1 from ${workflowVersions} join ${workflows} on ${workflows.id} = ${workflowVersions.workflowId} where ${workflowVersions.id} = ${runs.workflowVersionId} and ${workflows.userId} = ${workspaceId})`;
  return db.transaction(async (tx) => {
    if (action === "delivered") {
      // Held because nothing was sent (a daily send cap): there is nothing to confirm, only Send again or Stop.
      const [prior] = await tx.select({ outcome: stepRuns.outcome }).from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(desc(stepRuns.createdAt), desc(stepRuns.attempt)).limit(1);
      if (prior?.outcome === "not_sent") return false;
    }
    const moved = await tx
      .update(runs)
      .set(to === "cancelled" ? { state: to, finishedAt: new Date() } : { state: to, error: null, finishedAt: null, nextAttemptAt: null })
      .where(and(eq(runs.id, runId), eq(runs.state, from), owned))
      .returning({ id: runs.id });
    if (moved.length === 0) return false;
    const [last] = await tx.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(desc(stepRuns.createdAt), desc(stepRuns.attempt)).limit(1);
    if (!last) return true;
    await tx.update(stepRuns).set({ resolvedBy: actor, resolvedAt: new Date() }).where(eq(stepRuns.id, last.id));
    // "again" and "retry" leave the failed attempt as it is: the worker runs the next one, with the same step key.
    if (action === "delivered") {
      await tx.insert(stepRuns).values({ runId, stepId: last.stepId, attempt: last.attempt + 1, state: "succeeded", input: last.input, output: { reconciled: "delivered" }, resolvedBy: actor, resolvedAt: new Date(), finishedAt: new Date() });
    }
    return true;
  });
}
