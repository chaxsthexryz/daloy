import { createDb, oauthEnvProblem, migrate } from "@daloy/db";
import { createErrorReporter } from "@daloy/engine";
import { PgBoss } from "pg-boss";
import { createApp } from "./app";
import { deployEnv } from "./http";

const reporter = createErrorReporter({ dsn: process.env.SENTRY_DSN, service: "api", environment: process.env.SENTRY_ENVIRONMENT });
process.on("unhandledRejection", (err) => { void reporter.capture(err, { tags: { kind: "unhandledRejection" } }); });
process.on("uncaughtException", (err) => { void reporter.capture(err, { tags: { kind: "uncaughtException" } }); });

// A development OAuth client must not serve a public host, nor a production one a laptop (decision 0058).
const oauthProblem = oauthEnvProblem(process.env);
if (oauthProblem) throw new Error(oauthProblem);
const url = process.env.DATABASE_URL;
const key = process.env.SECRETS_KEY;
if (!url) throw new Error("DATABASE_URL is not set");
if (!key) throw new Error("SECRETS_KEY is not set (generate one with: openssl rand -base64 32)");
const deploy = deployEnv(process.env);

// false in compose, where the apps connect as the DML-only role and the `migrate` service owns the schema (decision 0013).
const ownsSchema = process.env.MIGRATE_ON_BOOT !== "false";
const { db, pool } = createDb(url);
if (ownsSchema) await migrate(pool);
const boss = new PgBoss({ connectionString: url, migrate: ownsSchema });
boss.on("error", (err) => console.error("pg-boss", err));
await boss.start();

const app = await createApp({ db, boss, secretsKey: Buffer.from(key, "base64"), ...deploy, ask: process.env.AI_ASK === "on", platformAdmins: process.env.PLATFORM_ADMINS, sentryDsn: process.env.SENTRY_DSN, sentryEnvironment: process.env.SENTRY_ENVIRONMENT, webSentryDsn: process.env.VITE_SENTRY_DSN, webDist: process.env.WEB_DIST, adminHost: process.env.ADMIN_HOST?.trim().toLowerCase() || undefined });
app.enableShutdownHooks();
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`api listening on ${port}`);
