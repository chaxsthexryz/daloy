import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { check, createWorkflow, spawnApp, startPostgres, startReceiver, waitForRuns } from "./stack";

// Load test: k6 sends 1,000 webhook calls to the real API; one worker runs the five-step workflow for each.
const RUNS = 1000;
const PORT = 3101;
const k6 = process.env.K6 ?? "k6";

const pg = await startPostgres(54332);
const receiver = startReceiver();
const { webhookPath } = await createWorkflow(pg.db);
const env = { DATABASE_URL: pg.url, SECRETS_KEY: randomBytes(32).toString("base64"), PORT: String(PORT) };
const api = spawnApp("api", "src/main.ts", env);
const worker = spawnApp("worker", "reliability/worker.ts", env);
try {
  for (let i = 0; !(await fetch(`http://127.0.0.1:${PORT}/auth/me`).then(() => true, () => false)); i++) {
    if (i > 120) throw new Error("api did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
  const k6Run = spawnSync(k6, ["run", "--quiet", "--local-ips", "127.0.0.2-127.0.0.41", "-e", `BASE_URL=http://127.0.0.1:${PORT}`, "-e", `HOOK=${webhookPath}`, "load.k6.js"], { cwd: import.meta.dirname, stdio: "inherit" });
  if (k6Run.status !== 0) throw new Error(`k6 exited with ${k6Run.status ?? k6Run.error}`);
  await waitForRuns(pg.db, RUNS, 30 * 60_000);
  const { ok, lines } = await check(pg.db, receiver, RUNS);
  console.log(["", `load test: ${RUNS} runs of the five-step workflow, one worker`, ...lines].join("\n"));
  process.exitCode = ok ? 0 : 1;
} finally {
  for (const child of [api, worker]) child.kill("SIGKILL");
  receiver.close();
  await pg.pool.end();
  await pg.stop();
}
