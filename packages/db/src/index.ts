import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema";

export * from "./schema";
export { schema };

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}
export type Db = ReturnType<typeof createDb>["db"];

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
export const migrate = (db: Db) => runMigrations(db, { migrationsFolder });
