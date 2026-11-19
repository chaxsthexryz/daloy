import { createDb, oauthEnvProblem, migrate } from "@daloy/db";
import { PgBoss } from "pg-boss";
import { createApp } from "./app";
import { deployEnv } from "./http";

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

const app = await createApp({ db, boss, secretsKey: Buffer.from(key, "base64"), ...deploy, ask: process.env.AI_ASK === "on" });
app.enableShutdownHooks();
// The built console (apps/web/dist). Served from the API's origin so the session cookie needs no CORS. It uses hash routes, so index.html at / is enough.
if (process.env.WEB_DIST) app.useStaticAssets(process.env.WEB_DIST);
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`api listening on ${port}`);
