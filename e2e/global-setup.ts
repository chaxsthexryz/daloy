import { execSync, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
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
    pg = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), "daloy-e2e-")), port: 54330, user: "daloy", password: "daloy", persistent: false, initdbFlags: ["-E", "UTF8", "--no-locale"], onLog: () => {} });
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
  process.env.E2E_LLM_URL = `http://127.0.0.1:${LLM_PORT}`;
  // Fake Google Sheets, Slack and Microsoft. Tests read the key file and token from these env vars and the fake's /__control.
  const providers = await startFakeProviders(PROVIDERS_PORT);
  const saEmail = "daloy-e2e@office-demo.iam.gserviceaccount.com";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  providers.addServiceAccount(saEmail, publicKey.export({ type: "spki", format: "pem" }).toString());
  providers.addSheet("e2e-sheet-0000000001", "Office requests", "Requests", [saEmail]);
  providers.addCalendar("e2e-clinic@group.calendar.google.com", "Clinic bookings", [saEmail]);
  process.env.E2E_CALENDAR_ID = "e2e-clinic@group.calendar.google.com";
  // A folder inside a shared drive, as Drive needs (a service account has no storage of its own).
  providers.addDriveFolder("e2e-drive-folder-0001", "Patient files", [saEmail], "0Ae2eSharedDrive");
  process.env.E2E_DRIVE_FOLDER = "e2e-drive-folder-0001";
  // Connect with Google (decision 0060): the fake Google OAuth app, a sheet and a My Drive folder this user can pick.
  const google = providers.addOAuthApp("google", { rotation: "none" });
  google.user = { id: "e2e-google-user", email: "owner@clinic-e2e.example" };
  providers.addSheet("e2e-picked-sheet-0001", "Front desk log", "Requests", [google.user.email]).tabs.set("Walk-ins", []);
  providers.addSheet("e2e-unpicked-sheet-01", "Someone else's sheet", "Data", ["someone@else.example"]);
  providers.addDriveFolder("e2e-picked-folder-001", "Clinic scans", [google.user.email], null);
  providers.slack.token = "xoxb-e2e-0000000000-abcdefabcdef";
  providers.meta.token = "meta_e2e_page_token_0000000000001"; // gitleaks:allow
  process.env.E2E_META_TOKEN = providers.meta.token;
  process.env.E2E_META_PAGE_ID = providers.meta.pageId;
  providers.telegram.token = "100000001:E2E-telegram-token-aaaaaaaaaaaaaaaaaa";
  process.env.E2E_TELEGRAM_TOKEN = providers.telegram.token;
  process.env.E2E_PAYMONGO_KEY = "sk_test_e2e0000000000000000";
  process.env.E2E_PAYMONGO_WEBHOOK_SECRET = "whsk_e2e000000000000";
  process.env.E2E_SHOPIFY_SHOP = providers.shopify.shopDomain;
  // A Dev Dashboard app: its client ID and secret get tokens from the fake's client credentials endpoint.
  process.env.E2E_SHOPIFY_CLIENT_ID = providers.shopify.clientId;
  process.env.E2E_SHOPIFY_SECRET = providers.shopify.clientSecret;
  // UniSMS is the server's own (decision 0100): the fake accepts this key only, and the API and worker get it as env below.
  providers.unisms.secretKey = "unisms_e2e_key_0000000001";
  providers.notion.token = "ntn_e2eNotionToken0123456789abcdef";
  process.env.E2E_NOTION_TOKEN = providers.notion.token;
  process.env.E2E_NOTION_DATABASE = providers.notion.database;
  process.env.E2E_SHEETS_KEY = JSON.stringify({ type: "service_account", client_email: saEmail, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  process.env.E2E_SLACK_TOKEN = providers.slack.token;
  process.env.E2E_PROVIDERS_URL = providers.urls.slack;
  // Fake Microsoft sign-in, Graph and Teams Workflows (roadmap phase 5). The flow URL is what Teams would show.
  process.env.E2E_TEAMS_URL = providers.teamsUrl("flow-purchasing");

  const clients = providers.recordClients();
  const env = {
    DATABASE_URL: url,
    SECRETS_KEY: randomBytes(32).toString("base64"),
    PORT: String(E2E_PORT),
    WEB_DIST: join(root, "apps/web/dist"),
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(SMTP_PORT),
    PUBLIC_URL: `http://localhost:${E2E_PORT}`,
    OAUTH_ENV: "development",
    // The fake model, so AI drafts work without Ollama. AI steps in e2e test runs are mocked anyway.
    LLM_PROVIDER: "ollama",
    // The fake model accepts images, so an AI step may be given form files.
    LLM_VISION: "on",
    LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}`,
    GOOGLE_TOKEN_URL: providers.urls.googleToken,
    GOOGLE_SHEETS_URL: providers.urls.sheets,
    GOOGLE_CALENDAR_URL: providers.urls.calendar,
    GOOGLE_DRIVE_URL: providers.urls.drive,
    SLACK_API_URL: providers.urls.slack,
    TELEGRAM_API_URL: providers.urls.telegram,
    UNISMS_API_URL: providers.urls.unisms,
    UNISMS_SECRET_KEY: providers.unisms.secretKey,
    UNISMS_SENDER_ID: "DaloyE2E",
    PAYMONGO_API_URL: providers.urls.paymongo,
    SHOPIFY_API_URL: providers.urls.shopify,
    META_GRAPH_URL: providers.urls.meta,
    META_CDN_URL: providers.urls.metaCdn,
    AIRTABLE_API_URL: providers.urls.airtable,
    AIRTABLE_LOGIN_URL: providers.urls.airtableLogin,
    AIRTABLE_CLIENT_ID: clients.airtableClient.clientId,
    AIRTABLE_CLIENT_SECRET: clients.airtableClient.clientSecret,
    NOTION_API_URL: providers.urls.notion,
    NOTION_CLIENT_ID: clients.notionClient.clientId,
    NOTION_CLIENT_SECRET: clients.notionClient.clientSecret,
    TRELLO_API_URL: providers.urls.trello,
    TRELLO_LOGIN_URL: providers.urls.trelloLogin,
    TRELLO_CLIENT_ID: clients.trelloClient.clientId,
    TRELLO_CLIENT_SECRET: clients.trelloClient.clientSecret,
    MICROSOFT_CLIENT_ID: providers.microsoft.clientId,
    MICROSOFT_CLIENT_SECRET: providers.microsoft.clientSecret,
    MICROSOFT_LOGIN_URL: providers.urls.microsoftLogin,
    MICROSOFT_GRAPH_URL: providers.urls.graph,
    // "Connect Slack" against the fake install (decision 0061). OAUTH_ENV (set above) is required once a managed client is set.
    SLACK_CLIENT_ID: providers.oauth.v2!.clientId,
    SLACK_CLIENT_SECRET: providers.oauth.v2!.clientSecret,
    TEAMS_WEBHOOK_HOSTS: "127.0.0.1",
    // Synthetic values for the fake Google OAuth app; nothing here reaches Google.
    GOOGLE_OAUTH_CLIENT_ID: google.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: google.clientSecret,
    GOOGLE_AUTHORIZE_URL: providers.oauthUrls("google").authorize,
    GOOGLE_OAUTH_TOKEN_URL: providers.oauthUrls("google").token,
    GOOGLE_REVOKE_URL: providers.oauthUrls("google").revoke,
    GOOGLE_USERINFO_URL: providers.oauthUrls("google").userinfo,
    GMAIL_API_URL: providers.urls.gmail,
    GOOGLE_PICKER_API_KEY: "e2e-picker-key",
    GOOGLE_PROJECT_NUMBER: "000000000000",
    // Every spec signs up and polls from 127.0.0.1.
    REGISTER_LIMIT_PER_HOUR: "1000",
    INVITE_ACCEPT_LIMIT_PER_MINUTE: "1000",
    GLOBAL_RATE_LIMIT_PER_MINUTE: "1000",
    // Specs publish several automations on one account.
    SIGNUP_PLAN: "none",
    AI_ASK: "on",
    // Dedicated E2E platform admin accounts seeded into Postgres below (decision 0137 S2 prevents /auth/register from claiming PLATFORM_ADMINS).
    PLATFORM_ADMINS: "platform-admin@e2e.test,e2e-admin-settings@test.local,e2e-admin-mcp@test.local,e2e-admin-tokens@test.local,e2e-admin-advanced@test.local,e2e-admin-account@test.local,e2e-admin-ai@test.local",
  };
  const api = start("api", env);
  await waitFor(`http://localhost:${E2E_PORT}/auth/me`, 60_000);
  const adminEmails = env.PLATFORM_ADMINS.split(",");
  const passwordHash = execSync(
    "pnpm -s --filter @daloy/api exec node --input-type=module -e \"import('@node-rs/argon2').then(async m => process.stdout.write(await m.hash('e2e test password 1')))\"",
    { cwd: root, encoding: "utf8" },
  ).trim().split(/\r?\n/).pop()!;
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    for (const email of adminEmails) {
      const inserted = await pool.query<{ id: string }>(
        "insert into users (email, password_hash) values ($1, $2) on conflict (email) do nothing returning id",
        [email, passwordHash],
      );
      const id = inserted.rows[0]?.id;
      if (id) {
        await pool.query(
          "insert into workspace_members (user_id, workspace_id, role) values ($1, $1, 'owner') on conflict do nothing",
          [id],
        );
      }
    }
    // Own AI keys need a Business plan (decision 0156); the AI model page test saves one.
    await pool.query("update users set plan = 'business', plan_started_on = current_date where email = 'e2e-admin-ai@test.local'");
  } finally {
    await pool.end();
  }
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
