import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

/**
 * Starts the whole stack without Docker: embedded Postgres, the API serving the built console, and the worker.
 * DATABASE_URL (CI) replaces the embedded server. Returns the teardown.
 */
export const E2E_PORT = 3100;
const root = resolve(import.meta.dirname, "..");
const win = process.platform === "win32";

function start(app: string, env: Record<string, string>): ChildProcess {
  const child = spawn(`pnpm --filter @daloy/${app} start`, {
    cwd: root,
    env: { ...process.env, ...env },
    shell: true,
    detached: !win, // own process group, so stop() can end pnpm and tsx together
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code) => code && console.error(`${app} exited with ${code}`));
  return child;
}

function stop(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  child.removeAllListeners("exit"); // a forced kill exits with 1, which is expected here
  if (win) execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
  else process.kill(-child.pid, "SIGTERM");
}

async function waitFor(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fetch(url).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not answer within ${ms} ms`);
}

export default async function setup() {
  execSync("pnpm --filter @daloy/web build", { cwd: root, stdio: "ignore" });

  let url = process.env.DATABASE_URL;
  let pg: EmbeddedPostgres | undefined;
  if (!url) {
    pg = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), "daloy-e2e-")), port: 54330, user: "daloy", password: "daloy", persistent: false, onLog: () => {} });
    await pg.initialise();
    await pg.start();
    url = "postgres://daloy:daloy@localhost:54330/postgres";
  }

  const env = { DATABASE_URL: url, SECRETS_KEY: randomBytes(32).toString("base64"), PORT: String(E2E_PORT), WEB_DIST: join(root, "apps/web/dist") };
  const api = start("api", env);
  await waitFor(`http://localhost:${E2E_PORT}/auth/me`, 60_000);
  // The worker starts after the API has run the migrations.
  const worker = start("worker", env);

  return async () => {
    stop(worker);
    stop(api);
    await pg?.stop();
  };
}
