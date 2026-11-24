import { createDb, oauthEnvProblem, mailDeps, migrate, providerUrls, retireStoredUnismsKeys, retiredSecretMaxAgeDays } from "@daloy/db";
import { createErrorReporter } from "@daloy/engine";
import { createExecutor } from "./steps";
import { startWorker } from "./worker";

const reporter = createErrorReporter({ dsn: process.env.SENTRY_DSN, service: "worker", environment: process.env.SENTRY_ENVIRONMENT });
process.on("unhandledRejection", (err) => { void reporter.capture(err, { tags: { kind: "unhandledRejection" } }); });
process.on("uncaughtException", (err) => { void reporter.capture(err, { tags: { kind: "uncaughtException" } }); });

// A development OAuth client must not serve a public host, nor a production one a laptop (decision 0058).
const oauthProblem = oauthEnvProblem(process.env);
if (oauthProblem) throw new Error(oauthProblem);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const secretsKey = Buffer.from(process.env.SECRETS_KEY ?? "", "base64");
if (secretsKey.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64 encoded");
const maxRetiredAgeDays = retiredSecretMaxAgeDays();

// false in compose, where the worker connects as the DML-only role and the `migrate` service owns the schema (decision 0013).
const ownsSchema = process.env.MIGRATE_ON_BOOT !== "false";
// Twice the run batch (10): each unsafe send holds one connection while it starts (decision 0030), so heartbeats,
// completions, deliveries and the sweep always have connections left.
const { db, pool } = createDb(url, 20);
if (ownsSchema) await migrate(pool);
// SMS uses the server's UniSMS settings only (decision 0100): any key a workspace saved earlier moves to retired secrets. Safe on every start.
await retireStoredUnismsKeys(db);

const worker = await startWorker({
  connectionString: url,
  db,
  migrate: ownsSchema,
  secretsKey,
  retiredSecretMaxAgeDays: maxRetiredAgeDays,
  executor: (enqueue) => createExecutor({ db, secretsKey, mail: mailDeps(), publicUrl: process.env.PUBLIC_URL, enqueue }),
  deliveries: { secretsKey, urls: providerUrls() },
  watchdog: { secretsKey, mail: mailDeps(), publicUrl: process.env.PUBLIC_URL },
  emailIn: { secretsKey, ...(process.env.NODE_ENV === "test" && process.env.DALOY_TEST_IMAP_ENDPOINT ? { intervalMs: 500 } : {}) },
  onError: (err, tags) => { void reporter.capture(err, { tags }); },
});
console.log("worker started");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    console.log(`${signal}: finishing jobs in progress`);
    await worker.stop();
    await pool.end();
    process.exit(0);
  });
}
