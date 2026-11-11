import { createDb, migrate } from "@daloy/db";
import { StepError } from "@daloy/engine";
import { startWorker } from "./worker";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const { db, pool } = createDb(url);
// shortcut: the worker applies migrations on boot; move this to a one-off job once the API also starts against the same database.
await migrate(db);

const worker = await startWorker({
  connectionString: url,
  db,
  // Real step types arrive in phase 4. Until then every step fails without a retry.
  executor: {
    async execute({ step }) {
      throw new StepError(`step type "${step.type}" is not implemented yet`, false);
    },
  },
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
