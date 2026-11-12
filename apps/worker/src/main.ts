import { createDb, migrate } from "@daloy/db";
import { createExecutor } from "./steps";
import { smtpMailer } from "./steps/email";
import { startWorker } from "./worker";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const secretsKey = Buffer.from(process.env.SECRETS_KEY ?? "", "base64");
if (secretsKey.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64 encoded");

const { db, pool } = createDb(url);
await migrate(pool);

const worker = await startWorker({
  connectionString: url,
  db,
  executor: createExecutor({ db, secretsKey, mailer: smtpMailer(), llmModel: process.env.LLM_MODEL, publicUrl: process.env.PUBLIC_URL }),
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
