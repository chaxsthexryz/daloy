import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createRun, publishedVersion, RUN_QUEUE, RUN_QUEUE_OPTIONS, runs, SCHEDULE_QUEUE, type Db } from "@daloy/db";
import type { RetryPolicy } from "@daloy/engine";
import { and, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { advance, type AdvanceDeps, type StepExecutor } from "./advance";

export type WorkerOptions = {
  connectionString: string;
  db: Db;
  executor: StepExecutor;
  leaseMs?: number;
  sweepMs?: number;
  pollingIntervalSeconds?: number;
  retryPolicy?: RetryPolicy;
};
export type Worker = Awaited<ReturnType<typeof startWorker>>;

export async function startWorker(opts: WorkerOptions) {
  const { db, leaseMs = 30_000, sweepMs = 15_000 } = opts;
  const boss = new PgBoss(opts.connectionString);
  boss.on("error", (err) => console.error("pg-boss", err));
  await boss.start();
  await boss.createQueue(RUN_QUEUE, RUN_QUEUE_OPTIONS);
  await boss.createQueue(SCHEDULE_QUEUE);

  const deps: AdvanceDeps = {
    db,
    executor: opts.executor,
    owner: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    leaseMs,
    retryPolicy: opts.retryPolicy,
    enqueue: async (runId, startAfter) => {
      await boss.send(RUN_QUEUE, { runId }, { singletonKey: runId, startAfter });
    },
  };

  await boss.work<{ runId: string }>(RUN_QUEUE, { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 }, async (jobs) => {
    for (const job of jobs) await advance(deps, job.data.runId);
  });

  // A schedule trigger fired: start a run of the workflow's live version, with the fire time as the payload.
  await boss.work<{ workflowId: string }>(SCHEDULE_QUEUE, { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 }, async (jobs) => {
    for (const job of jobs) {
      const version = await publishedVersion(db, job.data.workflowId);
      if (version) await deps.enqueue(await createRun(db, version.id, { firedAt: new Date().toISOString() }));
    }
  });

  // Resumes runs nobody is working on: lost jobs, crashed workers (expired lease), retries and waits whose time is up.
  // shortcut: re-sends every idle unfinished run each sweep and relies on singletonKey to drop duplicates; page through ids if runs reach the tens of thousands.
  const sweep = async () => {
    const idle = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          inArray(runs.state, ["pending", "running", "waiting"]),
          or(isNull(runs.leaseExpiresAt), lt(runs.leaseExpiresAt, sql`now()`)),
          or(isNull(runs.nextAttemptAt), lte(runs.nextAttemptAt, sql`now()`)),
        ),
      );
    for (const { id } of idle) await deps.enqueue(id);
  };
  const sweepTimer = setInterval(() => sweep().catch((err: unknown) => console.error("sweep failed", err)), sweepMs);
  await sweep();

  return {
    enqueue: deps.enqueue,
    /** Stops taking jobs and waits for the ones in progress, so their leases are released cleanly. */
    async stop() {
      clearInterval(sweepTimer);
      await boss.stop({ graceful: true, timeout: 30_000 });
    },
  };
}
