import { execSync, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { startFakeProviders } from "../test/fake-providers";
import { startFakeImap } from "../test/fake-imap";
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
const PROVIDERS_PORT = 2528;
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
  const inboxFile = join(mkdtempSync(join(tmpdir(), "daloy-imap-")), "messages.jsonl");
  writeFileSync(inboxFile, "");
  process.env.E2E_IMAP_MAIL_FILE = inboxFile;
  const inbox = await startFakeImap(inboxFile);
  const llm = startLlmFake(LLM_PORT);
  // Fake Google Sheets, Slack and Microsoft. Tests read the key file and token from these env vars and the fake's /__control.
  const providers = await startFakeProviders(PROVIDERS_PORT);
  const saEmail = "daloy-e2e@office-demo.iam.gserviceaccount.com";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  providers.addServiceAccount(saEmail, publicKey.export({ type: "spki", format: "pem" }).toString());
  providers.addSheet("e2e-sheet-0000000001", "Office requests", "Requests", [saEmail]);
  providers.slack.token = "xoxb-e2e-0000000000-abcdefabcdef";
  providers.telegram.token = "100000001:E2E-telegram-token-aaaaaaaaaaaaaaaaaa";
  process.env.E2E_TELEGRAM_TOKEN = providers.telegram.token;
  providers.notion.token = "ntn_e2eNotionToken0123456789abcdef";
  process.env.E2E_NOTION_TOKEN = providers.notion.token;
  process.env.E2E_NOTION_DATABASE = providers.notion.database;
  process.env.E2E_SHEETS_KEY = JSON.stringify({ type: "service_account", client_email: saEmail, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  process.env.E2E_SLACK_TOKEN = providers.slack.token;
  process.env.E2E_PROVIDERS_URL = providers.urls.slack;
  // Fake Microsoft sign-in, Graph and Teams Workflows (roadmap phase 5). The flow URL is what Teams would show.
  process.env.E2E_TEAMS_URL = providers.teamsUrl("flow-purchasing");

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
    GOOGLE_TOKEN_URL: providers.urls.googleToken,
    GOOGLE_SHEETS_URL: providers.urls.sheets,
    SLACK_API_URL: providers.urls.slack,
    TELEGRAM_API_URL: providers.urls.telegram,
    AIRTABLE_API_URL: providers.urls.airtable,
    NOTION_API_URL: providers.urls.notion,
    TRELLO_API_URL: providers.urls.trello,
    MICROSOFT_CLIENT_ID: providers.microsoft.clientId,
    MICROSOFT_CLIENT_SECRET: providers.microsoft.clientSecret,
    MICROSOFT_LOGIN_URL: providers.urls.microsoftLogin,
    MICROSOFT_GRAPH_URL: providers.urls.graph,
    TEAMS_WEBHOOK_HOSTS: "127.0.0.1",
    // Every spec signs up from 127.0.0.1.
    REGISTER_LIMIT_PER_HOUR: "1000",
    AI_ASK: "on",
  };
  const api = start("api", env);
  await waitFor(`http://localhost:${E2E_PORT}/auth/me`, 60_000);
  // The worker starts after the API has run the migrations.
  const worker = start("worker", { ...env, NODE_ENV: "test", DALOY_TEST_IMAP_ENDPOINT: inbox.url });

  return async () => {
    stop(worker);
    stop(api);
    smtp.close();
    await inbox.close();
    llm.close();
    await providers.close();
    await pg?.stop();
  };
}
