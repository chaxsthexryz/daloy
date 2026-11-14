import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { clearSheetWriteKeys, createRun, publishedVersion, runDueDeliveries, RUN_QUEUE, RUN_QUEUE_OPTIONS, runs, SCHEDULE_QUEUE, type Db, type ProviderUrls } from "@daloy/db";
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
  /** false when connecting as the DML-only role: pg-boss then expects its schema installed already (migrate.ts). */
  migrate?: boolean;
  /** Delivers queued Sheets rows and Slack messages. Left out, deliveries wait in the table. */
  deliveries?: { secretsKey: Buffer; urls: ProviderUrls };
};
export type Worker = Awaited<ReturnType<typeof startWorker>>;

export async function startWorker(opts: WorkerOptions) {
  const { db, leaseMs = 30_000, sweepMs = 15_000 } = opts;
  const boss = new PgBoss({ connectionString: opts.connectionString, migrate: opts.migrate ?? true, useListenNotify: true });
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

  // NOTIFY (RUN_QUEUE_OPTIONS) wakes the worker when a job is sent. A job sent with a later startAfter (retry, delay)
  // sends no NOTIFY when it becomes due, so the poll keeps its normal interval instead of pg-boss's 30 s notify backstop.
  const polling = { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2, notifyPollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 };
  // Batches of 10, fetched back to back while they come back full (pg-boss otherwise waits a poll interval after every fetch).
  // A batch never holds the same run twice (policy "short": one queued job per run), and each run has its own lease, so they run in parallel.
  await boss.work<{ runId: string }>(RUN_QUEUE, { ...polling, batchSize: 10, burstWhenBatchFull: true }, async (jobs) => {
    await Promise.all(jobs.map((job) => advance(deps, job.data.runId)));
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
  // The same timer removes Sheets write markers once their retention has passed (decision 0021).
  const clearMarkers = () => (opts.deliveries ? clearSheetWriteKeys(db, opts.deliveries.secretsKey, opts.deliveries.urls) : Promise.resolve(0));
  const sweepTimer = setInterval(() => {
    sweep().catch((err: unknown) => console.error("sweep failed", err));
    clearMarkers().catch((err: unknown) => console.error("sheet marker sweep failed", err));
  }, sweepMs);
  await sweep();

  // Deliveries are rows, not jobs: each poll claims the due ones with SKIP LOCKED (packages/db/src/deliveries.ts).
  // One poll at a time per worker; several workers share the work through the claim.
  let delivering: Promise<unknown> = Promise.resolve();
  let busy = false;
  const deliveryTimer = opts.deliveries
    ? setInterval(() => {
        if (busy) return;
        busy = true;
        delivering = runDueDeliveries(db, opts.deliveries!.secretsKey, opts.deliveries!.urls)
          .catch((err: unknown) => console.error("deliveries failed", err))
          .finally(() => (busy = false));
      }, (opts.pollingIntervalSeconds ?? 2) * 1000)
    : undefined;

  return {
    enqueue: deps.enqueue,
    /** Stops taking jobs and waits for the ones in progress, so their leases are released cleanly. */
    async stop() {
      clearInterval(sweepTimer);
      clearInterval(deliveryTimer);
      await boss.stop({ graceful: true, timeout: 30_000 });
      await delivering;
    },
  };
}
