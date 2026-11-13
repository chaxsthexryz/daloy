import type { ChildProcess } from "node:child_process";
import { createRun } from "@daloy/db";
import { check, createWorkflow, spawnApp, startPostgres, startReceiver, waitForRuns } from "./stack";

// Chaos test: 200 runs, the worker SIGKILLed again and again while it works, restarted after each kill.
// Each kill waits for 20 to 60 newly executed keys, so the ten kills land while the worker is busy.
const RUNS = 200;
const KILLS = Number(process.env.KILLS ?? 10);

const pg = await startPostgres(54331);
const receiver = startReceiver();
const { versionId } = await createWorkflow(pg.db);
for (let n = 1; n <= RUNS; n++) await createRun(pg.db, versionId, { n });

const startWorker = () => spawnApp("worker", "reliability/worker.ts", { DATABASE_URL: pg.url });
let worker: ChildProcess = startWorker();
const started = Date.now();
try {
  for (let k = 1; k <= KILLS; k++) {
    // Kill mid-work: once the new worker has executed 20 to 60 more keys, or after 10 s without that much progress.
    const target = receiver.executions() + 20 + Math.floor(Math.random() * 41);
    for (const until = Date.now() + 10_000; receiver.executions() < target && Date.now() < until; ) await new Promise((r) => setTimeout(r, 20));
    const executed = receiver.executions();
    // Only the PID this script spawned. On Windows, SIGKILL is TerminateProcess: no cleanup, no graceful shutdown.
    process.kill(worker.pid!, "SIGKILL");
    await new Promise((r) => worker.once("exit", r));
    console.log(`kill ${k}: worker ${worker.pid} killed after ${executed} executed keys`);
    worker = startWorker();
  }
  await waitForRuns(pg.db, RUNS, 15 * 60_000);
  const { ok, lines } = await check(pg.db, receiver, RUNS);
  console.log(["", `chaos test: ${RUNS} runs, ${KILLS} SIGKILLs, ${((Date.now() - started) / 1000).toFixed(1)} s from first worker start to last check`, ...lines].join("\n"));
  process.exitCode = ok ? 0 : 1;
} finally {
  worker.kill("SIGKILL");
  receiver.close();
  await pg.pool.end();
  await pg.stop();
}
