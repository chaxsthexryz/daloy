import { resolve } from "node:path";
import { createDb, migrate, RUN_QUEUE, RUN_QUEUE_OPTIONS, SCHEDULE_QUEUE } from "@daloy/db";
import { PgBoss } from "pg-boss";

/**
 * Everything that changes the schema: Drizzle migrations, the pg-boss install and its queues. Runs as the owner role.
 * In compose this is the one-shot `migrate` service, so the API and the worker can connect as the DML-only role (decision 0013).
 */
export async function setupDatabase(url: string) {
  const { pool } = createDb(url);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  const boss = new PgBoss(url);
  await boss.start();
  await boss.createQueue(RUN_QUEUE, RUN_QUEUE_OPTIONS);
  await boss.createQueue(SCHEDULE_QUEUE);
  await boss.stop({ graceful: false });
}

// Run directly (compose `migrate` service), not when a test imports it.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  await setupDatabase(url);
  console.log("database ready");
}
