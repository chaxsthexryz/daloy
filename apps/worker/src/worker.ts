import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { clearSheetWriteKeys, createRun, planOf, PLANS, publishedVersion, runDueDeliveries, RUN_QUEUE, RUN_QUEUE_OPTIONS, runs, SCHEDULE_QUEUE, workflows, workflowVersions, type Db, type ProviderUrls } from "@daloy/db";
import type { RetryPolicy } from "@daloy/engine";
import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { advance, type AdvanceDeps, type StepExecutor } from "./advance";
import { pollEmailSources, type ImapAdapter } from "./email-in";
import { connectImap } from "./imap";

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
  emailIn?: { secretsKey: Buffer; adapter?: ImapAdapter; intervalMs?: number };
};
export type Worker = Awaited<ReturnType<typeof startWorker>>;

/** The owner's plan sets a minimum time between scheduled runs. 30 s of slack, so an exact hourly cron is not skipped. */
async function tooSoon(db: Db, workflowId: string) {
  const [wf] = await db.select({ userId: workflows.userId }).from(workflows).where(eq(workflows.id, workflowId));
  const { plan } = wf ? await planOf(db, wf.userId) : { plan: null };
  if (!plan) return false;
  const since = sql`now() - make_interval(secs => ${PLANS[plan].minScheduleMinutes * 60 - 30})`;
  const recent = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(and(eq(workflowVersions.workflowId, workflowId), eq(runs.test, false), gt(runs.createdAt, since)))
    .limit(1);
  return recent.length > 0;
}

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
      if (await tooSoon(db, job.data.workflowId)) {
        console.log(`schedule: skipped ${job.data.workflowId}, the plan's minimum interval has not passed`);
        continue;
      }
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

  let readingMail: Promise<void> | undefined;
  const emailStop = new AbortController();
  const emailTimer = opts.emailIn ? setInterval(() => {
    if (readingMail) return;
    readingMail = pollEmailSources({ db, ...opts.emailIn!, adapter: opts.emailIn!.adapter ?? connectImap, enqueue: deps.enqueue, signal: emailStop.signal })
      .catch(() => console.error("email intake poll failed"))
      .finally(() => { readingMail = undefined; });
  }, Math.min(2_000, opts.emailIn.intervalMs ?? 2_000)) : undefined;

  return {
    enqueue: deps.enqueue,
    /** Stops taking jobs and waits for the ones in progress, so their leases are released cleanly. */
    async stop() {
      clearInterval(sweepTimer);
      clearInterval(deliveryTimer);
      clearInterval(emailTimer);
      emailStop.abort();
      await boss.stop({ graceful: true, timeout: 30_000 });
      await delivering;
      await readingMail;
    },
  };
}
