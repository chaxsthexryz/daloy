import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb, runs, stepRuns, triggers, users, workflows, workflowVersions, type Db } from "@daloy/db";
import EmbeddedPostgres from "embedded-postgres";
import { inArray, sql } from "drizzle-orm";
import { setupDatabase } from "../src/migrate";

/** Shared pieces of the load and chaos tests (docs/reliability.md). Everything runs locally, no Docker. */
export const RECEIVER_PORT = 4400;
const root = resolve(import.meta.dirname, "../../..");

export async function startPostgres(port: number) {
  const pg = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), "daloy-rel-")), port, user: "daloy", password: "daloy", persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  const url = `postgres://daloy:daloy@localhost:${port}/postgres`;
  await setupDatabase(url);
  return { url, ...createDb(url), stop: () => pg.stop() };
}

/**
 * Stands in for an external API that honours Idempotency-Key: the first call with a key does the work,
 * a repeat gets the stored reply. deliveries counts every call, so redeliveries after a crash show up.
 */
export function startReceiver() {
  const deliveries = new Map<string, number>();
  let executions = 0;
  const server = createServer((req, res) => {
    const key = String(req.headers["idempotency-key"] ?? "");
    const seen = deliveries.get(key) ?? 0;
    deliveries.set(key, seen + 1);
    if (seen === 0) executions++;
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", key }));
  });
  server.listen(RECEIVER_PORT, "127.0.0.1");
  return { deliveries, executions: () => executions, close: () => server.close() };
}

const target = (path: string) => ({ method: "POST", url: `http://127.0.0.1:${RECEIVER_PORT}/${path}`, headers: {}, body: '{"run":"{{trigger.n}}"}' });

/** Five steps: http, condition, http, a one second delay, http. Three idempotency keys per run. */
export const FIVE_STEPS = {
  trigger: { type: "webhook", config: {} },
  steps: [
    { id: "fetch", type: "http", config: target("fetch") },
    { id: "is_ok", type: "condition", config: { condition: { left: "{{steps.fetch.output.body.status}}", op: "eq", right: "ok" } } },
    { id: "update", type: "http", config: target("update") },
    { id: "pause", type: "delay", config: { seconds: 1 } },
    { id: "notify", type: "http", config: target("notify") },
  ],
  edges: [
    { from: "fetch", to: "is_ok" },
    { from: "is_ok", to: "update", on: "true" },
    { from: "update", to: "pause" },
    { from: "pause", to: "notify" },
  ],
};
const HTTP_STEPS = ["fetch", "update", "notify"];

/** Inserts a user and the published five-step workflow with a webhook trigger. */
export async function createWorkflow(db: Db) {
  const [user] = await db.insert(users).values({ email: "reliability@test.local", passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: user!.id, name: "Five steps", slug: "five-steps" }).returning();
  const [version] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: FIVE_STEPS, published: true }).returning();
  const webhookPath = randomBytes(32).toString("base64url");
  await db.insert(triggers).values({ workflowId: wf!.id, type: "webhook", webhookPath });
  return { versionId: version!.id, webhookPath };
}

/** Starts an app as a plain node process (tsx loaded in-process), so child.pid is the app itself and nothing else. */
export function spawnApp(app: "api" | "worker", script: string, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", script], { cwd: join(root, "apps", app), env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
}

/** Waits until `count` runs exist and none is unfinished. */
export async function waitForRuns(db: Db, count: number, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db.select({ total: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where ${runs.state} in ('pending', 'running', 'waiting'))::int` }).from(runs);
    if (row!.total >= count && row!.open === 0) return;
    if (Date.now() > until) throw new Error(`timed out: ${row!.total} runs, ${row!.open} unfinished`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

/** The pass/fail checks both tests share. Returns the report lines and whether everything held. */
export async function check(db: Db, receiver: ReturnType<typeof startReceiver>, expectedRuns: number) {
  const all = await db.select().from(runs);
  const ids = all.map((r) => r.id);
  const steps = ids.length ? await db.select().from(stepRuns).where(inArray(stepRuns.runId, ids)) : [];
  const byState = (rows: { state: string }[]) => Object.fromEntries([...new Set(rows.map((r) => r.state))].sort().map((s) => [s, rows.filter((r) => r.state === s).length]));

  // Exactly one succeeded attempt per run and step: none lost, none doubled.
  const succeeded = new Map<string, number>();
  for (const s of steps) if (s.state === "succeeded") succeeded.set(`${s.runId}:${s.stepId}`, (succeeded.get(`${s.runId}:${s.stepId}`) ?? 0) + 1);
  const missing = ids.flatMap((id) => FIVE_STEPS.steps.filter((s) => !succeeded.has(`${id}:${s.id}`)).map((s) => `${id}:${s.id}`));
  const doubled = [...succeeded].filter(([, n]) => n > 1).length;

  // The keys the receiver executed must be exactly the keys of the succeeded HTTP attempts.
  const expectedKeys = new Set(steps.filter((s) => s.state === "succeeded" && HTTP_STEPS.includes(s.stepId)).map((s) => `${s.runId}:${s.stepId}:${s.attempt}`));
  const executed = [...receiver.deliveries.keys()];
  const unexpected = executed.filter((k) => !expectedKeys.has(k)).length;
  const notExecuted = [...expectedKeys].filter((k) => !receiver.deliveries.has(k)).length;
  const redelivered = [...receiver.deliveries.values()].filter((n) => n > 1).length;

  const ms = all.filter((r) => r.finishedAt).map((r) => r.finishedAt!.getTime() - r.createdAt.getTime()).sort((a, b) => a - b);
  const first = Math.min(...all.map((r) => r.createdAt.getTime()));
  const last = Math.max(...all.map((r) => r.finishedAt?.getTime() ?? 0));

  const ok =
    all.length === expectedRuns && all.every((r) => r.state === "succeeded") && missing.length === 0 && doubled === 0 && steps.every((s) => s.state === "succeeded" || s.state === "failed") && unexpected === 0 && notExecuted === 0 && receiver.executions() === expectedKeys.size;
  const lines = [
    `runs: ${all.length} (expected ${expectedRuns}), by state ${JSON.stringify(byState(all))}`,
    `step_runs: ${steps.length}, by state ${JSON.stringify(byState(steps))}`,
    `run/step pairs without a succeeded attempt: ${missing.length}; with more than one: ${doubled}`,
    `idempotency keys: ${expectedKeys.size} expected, ${receiver.executions()} executed by the receiver, ${unexpected} unexpected, ${notExecuted} never received`,
    `deliveries: ${[...receiver.deliveries.values()].reduce((a, b) => a + b, 0)} calls, ${redelivered} keys delivered more than once (executed once)`,
    `run time (created to finished): p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${ms.at(-1)} ms`,
    `first run created to last run finished: ${((last - first) / 1000).toFixed(1)} s`,
    `result: ${ok ? "PASS" : "FAIL"}`,
  ];
  return { ok, lines };
}
