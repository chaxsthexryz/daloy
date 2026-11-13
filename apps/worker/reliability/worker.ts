import { createDb } from "@daloy/db";
import { createExecutor } from "../src/steps";
import { smtpMailer } from "../src/steps/email";
import { BLOCKED_RANGES, blockListOf, defaultGuard } from "../src/steps/ssrf";
import { startWorker } from "../src/worker";
import { RECEIVER_PORT } from "./stack";

// The worker from apps/worker/src/main.ts with one change: the SSRF guard lets the HTTP step reach the test receiver
// on 127.0.0.1:RECEIVER_PORT. Lease, sweep and polling keep their production defaults (decision 0012).
const url = process.env.DATABASE_URL!;
const { db } = createDb(url);
const guard = { ...defaultGuard(), blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")), ports: ["", "80", "443", String(RECEIVER_PORT)] };
await startWorker({ connectionString: url, db, executor: createExecutor({ db, secretsKey: Buffer.alloc(32), mailer: smtpMailer(), guard }) });
console.log(`worker ${process.pid} started`);
