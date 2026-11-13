import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { runs, workflowVersions } from "./schema";

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

/** Inserts a pending run. The caller queues it; if that fails, the worker's sweep picks it up. */
export async function createRun(db: AnyDb, workflowVersionId: string, triggerPayload: unknown, opts: { test?: boolean; live?: boolean } = {}): Promise<string> {
  const [run] = await db.insert(runs).values({ workflowVersionId, triggerPayload, ...opts }).returning({ id: runs.id });
  return run!.id;
}
