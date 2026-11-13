import { readFileSync } from "node:fs";
import { createDb, runs, users, workflows, workflowVersions } from "@daloy/db";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { setupDatabase } from "./migrate";
import { startWorker, type Worker } from "./worker";

// The compose setup (decision 0013): the owner applies docker/app-role.sql and migrates; the apps connect as daloy_app.
const sql = readFileSync(new URL("../../../docker/app-role.sql", import.meta.url), "utf8");
let ownerPool: pg.Pool;
let app: ReturnType<typeof createDb>;
let worker: Worker | undefined;
let appUrl: string;

beforeAll(async () => {
  const fresh = await freshDatabase();
  ownerPool = fresh.pool;
  await ownerPool.query(sql);
  await ownerPool.query("ALTER ROLE daloy_app PASSWORD 'app-test-pw'");
  await setupDatabase(fresh.url);
  const url = new URL(fresh.url);
  url.username = "daloy_app";
  url.password = "app-test-pw";
  appUrl = url.toString();
  app = createDb(appUrl);
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  await app?.pool.end();
  await ownerPool?.end();
});

it("lets the app role read and write rows", async () => {
  const [user] = await app.db.insert(users).values({ email: "role@test.local", passwordHash: "x" }).returning();
  await app.db.update(users).set({ passwordHash: "y" }).where(eq(users.id, user!.id));
  await app.db.delete(users).where(eq(users.id, user!.id));
});

it.each(["CREATE TABLE evil (id int)", "DROP TABLE runs", "ALTER TABLE runs ADD COLUMN x int", "TRUNCATE runs", "CREATE TABLE pgboss.evil (id int)"])(
  "refuses %s to the app role",
  async (statement) => {
    await expect(app.pool.query(statement)).rejects.toThrow(/permission denied|must be owner/);
  },
);

it("runs a workflow end to end as the app role, pg-boss included", async () => {
  worker = await startWorker({
    connectionString: appUrl,
    db: app.db,
    migrate: false,
    executor: { execute: async ({ step }) => ({ output: { ran: step.id } }) },
    pollingIntervalSeconds: 0.5,
  });
  const [user] = await app.db.insert(users).values({ email: "flow@test.local", passwordHash: "x" }).returning();
  const [wf] = await app.db.insert(workflows).values({ userId: user!.id, name: "t", slug: "t" }).returning();
  const definition = { trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
  const [version] = await app.db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true }).returning();
  const [run] = await app.db.insert(runs).values({ workflowVersionId: version!.id, triggerPayload: {} }).returning();
  await worker.enqueue(run!.id);
  let state = "";
  for (let i = 0; i < 100 && state !== "succeeded"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    [{ state }] = (await app.db.select({ state: runs.state }).from(runs).where(eq(runs.id, run!.id))) as [{ state: string }];
  }
  expect(state).toBe("succeeded");
}, 30_000);
