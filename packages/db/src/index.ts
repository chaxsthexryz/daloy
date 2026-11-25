import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema";

export * from "./admin";
export * from "./ai-settings";
export * from "./approvals";
export * from "./assistant";
export * from "./brand";
export * from "./bookings";
export * from "./payment-review";
export * from "./privacy";
export * from "./calendar";
export * from "./connections";
export * from "./conversations";
export * from "./crypto";
export * from "./deliveries";
export * from "./discord";
export * from "./google-access";
export * from "./google-docs";
export * from "./drive-sheet";
export * from "./google-calendar";
export * from "./google-triggers";
export * from "./mailbox-triggers";
export * from "./monitor-triggers";
export * from "./chat-triggers";
export * from "./record-triggers";
export * from "./email-sources";
export * from "./knowledge";
export * from "./internal-triggers";
export * from "./language";
export * from "./mail";
export * from "./mail-senders";
export * from "./members";
export * from "./meta";
export * from "./whatsapp";
export * from "./shopify";
export * from "./telegram";
export * from "./oauth";
export * from "./paymongo";
export * from "./providers";
export * from "./retired-secrets";
export * from "./runs";
export * from "./schema";
export * from "./uploads";
export * from "./usage";
export * from "./digest";
export { schema };

/** max is the pool size; pg's default is 10. */
export function createDb(connectionString: string, max?: number) {
  const pool = new Pool({ connectionString, max });
  return { db: drizzle(pool, { schema }), pool };
}
export type Db = ReturnType<typeof createDb>["db"];

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const MIGRATION_LOCK = 72310;

/** Applies pending migrations. The API and the worker both call this on boot; an advisory lock makes the second one wait. */
export async function migrate(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await runMigrations(drizzle(client), { migrationsFolder });
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
