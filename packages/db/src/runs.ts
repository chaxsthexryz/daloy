import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { runKeys, runs, workflowVersions } from "./schema";

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
      const runId = await createRun(tx, workflowVersionId, triggerPayload, opts);
      const claimed = await tx.insert(runKeys).values({ workflowId, test, key, runId }).onConflictDoNothing().returning({ runId: runKeys.runId });
      if (claimed.length === 0) throw new Duplicate();
      return { runId };
    });
  } catch (err) {
    if (!(err instanceof Duplicate)) throw err;
    const [first] = await db.select({ runId: runKeys.runId }).from(runKeys).where(and(eq(runKeys.workflowId, workflowId), eq(runKeys.test, test), eq(runKeys.key, key)));
    return { runId: first!.runId, duplicate: true };
  }
}

type RunOpts = { test?: boolean; live?: boolean; aiLive?: boolean; testChoices?: unknown };

/** Inserts a pending run. The caller queues it; if that fails, the worker's sweep picks it up. */
export async function createRun(db: AnyDb, workflowVersionId: string, triggerPayload: unknown, opts: RunOpts = {}): Promise<string> {
  const [run] = await db.insert(runs).values({ workflowVersionId, triggerPayload, ...opts }).returning({ id: runs.id });
  return run!.id;
}
