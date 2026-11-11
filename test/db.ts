import { randomUUID } from "node:crypto";
import { createDb, migrate } from "@daloy/db";
import pg from "pg";
import { inject } from "vitest";

/** A new, migrated database per test file, so files running in parallel never see each other's runs or queues. */
export async function freshDatabase() {
  const adminUrl = inject("adminDatabaseUrl");
  const name = `t_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const { db, pool } = createDb(url.toString());
  await migrate(pool);
  return { url: url.toString(), db, pool };
}
