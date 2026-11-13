import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { startLlmFake } from "./llm-fake";
import { startSmtpSink } from "./smtp-sink";

/**
 * Starts the whole stack without Docker: embedded Postgres, the API serving the built console, the worker, and an
 * SMTP sink whose messages tests read from E2E_MAIL_FILE.
 * DATABASE_URL (CI) replaces the embedded server. Returns the teardown.
 */
export const E2E_PORT = 3100;
const SMTP_PORT = 2526;
const LLM_PORT = 2527;
const root = resolve(import.meta.dirname, "..");
const win = process.platform === "win32";

function start(app: string, env: Record<string, string>): ChildProcess {
  // Fixed command; the shell resolves pnpm.cmd on Windows.
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
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

  // Test workers inherit env vars set here.
  const mailFile = join(mkdtempSync(join(tmpdir(), "daloy-mail-")), "messages.jsonl");
  writeFileSync(mailFile, "");
  process.env.E2E_MAIL_FILE = mailFile;
  const smtp = await startSmtpSink(SMTP_PORT, mailFile);
  const llm = startLlmFake(LLM_PORT);

  const env = {
    DATABASE_URL: url,
    SECRETS_KEY: randomBytes(32).toString("base64"),
    PORT: String(E2E_PORT),
    WEB_DIST: join(root, "apps/web/dist"),
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(SMTP_PORT),
    PUBLIC_URL: `http://localhost:${E2E_PORT}`,
    // The fake model, so AI drafts work without Ollama. AI steps in e2e test runs are mocked anyway.
    LLM_PROVIDER: "ollama",
    LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}`,
  };
  const api = start("api", env);
  await waitFor(`http://localhost:${E2E_PORT}/auth/me`, 60_000);
  // The worker starts after the API has run the migrations.
  const worker = start("worker", env);

  return async () => {
    stop(worker);
    stop(api);
    smtp.close();
    llm.close();
    await pg?.stop();
  };
}
