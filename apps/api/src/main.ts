import { createDb, migrate } from "@daloy/db";
import { PgBoss } from "pg-boss";
import { createApp } from "./app";

const url = process.env.DATABASE_URL;
const key = process.env.SECRETS_KEY;
if (!url) throw new Error("DATABASE_URL is not set");
if (!key) throw new Error("SECRETS_KEY is not set (generate one with: openssl rand -base64 32)");

const { db, pool } = createDb(url);
await migrate(pool);
const boss = new PgBoss(url);
boss.on("error", (err) => console.error("pg-boss", err));
await boss.start();

const app = await createApp({ db, boss, secretsKey: Buffer.from(key, "base64"), secureCookies: process.env.NODE_ENV === "production" });
app.enableShutdownHooks();
// The built console (apps/web/dist). Served from the API's origin so the session cookie needs no CORS. It uses hash routes, so index.html at / is enough.
if (process.env.WEB_DIST) app.useStaticAssets(process.env.WEB_DIST);
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`api listening on ${port}`);
