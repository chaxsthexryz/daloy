import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runs, stepRuns, usageClaims, users, workflows, workflowVersions, type Db } from "@daloy/db";
import type { Step } from "@daloy/engine";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { createExecutor } from "./index";
import { BLOCKED_RANGES, blockListOf } from "./ssrf";

// The read_page step through the step executor (phase B1, decision 0107): previous and changed come from step_runs,
// and a mocked test run never leaves the machine. The "supplier" is a local server, allowed in this file only.
const NO_STEP_RUN = "00000000-0000-0000-0000-000000000000";
let db: Db;
let pool: Pool;
let server: Server;
let port: number;
let userId: string;
let price = "PHP 52.00";
let hits = 0;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  const [u] = await db.insert(users).values({ email: "owner@test.local", passwordHash: "x" }).returning();
  userId = u!.id;
  server = createServer((req, res) => {
    if (req.url!.startsWith("/robots.txt")) return res.writeHead(404).end();
    hits++;
    res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>Rice</title></head><body><p class="price">${price}</p></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
}, 120_000);
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  await pool?.end();
});

const executor = () =>
  createExecutor({
    db,
    secretsKey: randomBytes(32),
    mail: {} as never,
    publicUrl: "https://daloy.example.com",
    guard: {
      blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")),
      ports: ["", String(port)],
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    },
  });

const step = (config: Partial<Extract<Step, { type: "read_page" }>["config"]> = {}): Step => ({
  id: "price",
  type: "read_page",
  config: { url: `http://supplier.test:${port}/rice`, selector: ".price", maxChars: 4000, ...config },
});

async function workflow() {
  const [wf] = await db.insert(workflows).values({ userId, name: "Price watch", slug: `price-${randomUUID().slice(0, 8)}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  return { id: wf!.id, versionId: v!.id };
}
/** A run row with the step's stored result, as the engine would have left it. */
async function finishedRun(w: { versionId: string }, o: { state?: "succeeded" | "failed"; test?: boolean; output: unknown; stepId?: string }) {
  const [r] = await db.insert(runs).values({ workflowVersionId: w.versionId, test: o.test ?? false, state: "succeeded" }).returning();
  await db.insert(stepRuns).values({ runId: r!.id, stepId: o.stepId ?? "price", attempt: 1, state: o.state ?? "succeeded", output: o.output, finishedAt: new Date() });
  return r!.id;
}
async function runOnce(w: { id: string; versionId: string }, s: Step = step(), extra: { mock?: boolean } = {}) {
  const [r] = await db.insert(runs).values({ workflowVersionId: w.versionId }).returning();
  return executor().execute({ runId: r!.id, stepRunId: NO_STEP_RUN, userId, workflowId: w.id, step: s, attempt: 1, idempotencyKey: `${r!.id}:price`, ctx: { trigger: {}, steps: {} }, ...extra });
}

describe("read_page step", () => {
  it("has no previous value on the first run, and changed is false", async () => {
    const w = await workflow();
    const out = await runOnce(w);
    expect(out.output).toMatchObject({ title: "Rice", value: "PHP 52.00", previous: null, changed: false });
    expect(out.input).toEqual({ url: `http://supplier.test:${port}/rice`, selector: ".price", maxChars: 4000 });
  });

  it("returns the value of the last successful run as previous, and flags a change", async () => {
    const w = await workflow();
    await finishedRun(w, { output: { value: "PHP 50.00" } });
    price = "PHP 52.00";
    const changed = await runOnce(w);
    expect(changed.output).toMatchObject({ value: "PHP 52.00", previous: "PHP 50.00", changed: true });
    await finishedRun(w, { output: { value: "PHP 52.00" } });
    const same = await runOnce(w);
    expect(same.output).toMatchObject({ previous: "PHP 52.00", changed: false });
  });

  it("takes the newest successful run, and ignores failed runs, test runs, other steps and other workflows", async () => {
    const w = await workflow();
    const other = await workflow();
    await finishedRun(w, { output: { value: "old" } });
    await new Promise((r) => setTimeout(r, 15));
    await finishedRun(w, { output: { value: "newest good" } });
    await new Promise((r) => setTimeout(r, 15));
    await finishedRun(w, { state: "failed", output: { value: "from a failed run" } });
    await finishedRun(w, { test: true, output: { value: "from a test run" } });
    await finishedRun(w, { stepId: "another", output: { value: "from another step" } });
    await finishedRun(other, { output: { value: "from another workflow" } });
    expect((await runOnce(w)).output).toMatchObject({ previous: "newest good" });
  });

  it("does not compare a run with itself", async () => {
    const w = await workflow();
    const [r] = await db.insert(runs).values({ workflowVersionId: w.versionId }).returning();
    await db.insert(stepRuns).values({ runId: r!.id, stepId: "price", attempt: 1, state: "succeeded", output: { value: "PHP 52.00" }, finishedAt: new Date() });
    const out = await executor().execute({ runId: r!.id, stepRunId: NO_STEP_RUN, userId, workflowId: w.id, step: step(), attempt: 2, idempotencyKey: `${r!.id}:price`, ctx: { trigger: {}, steps: {} } });
    expect(out.output).toMatchObject({ previous: null, changed: false });
  });

  it("finds previous across a new published version of the workflow", async () => {
    const w = await workflow();
    await finishedRun(w, { output: { value: "PHP 49.00" } });
    const [v2] = await db.insert(workflowVersions).values({ workflowId: w.id, version: 2, definition: {} }).returning();
    expect((await runOnce({ id: w.id, versionId: v2!.id })).output).toMatchObject({ previous: "PHP 49.00", changed: true });
  });

  it("counts one web request, once, even when the step is attempted again", async () => {
    const w = await workflow();
    const [r] = await db.insert(runs).values({ workflowVersionId: w.versionId }).returning();
    const exec = (attempt: number) => executor().execute({ runId: r!.id, stepRunId: NO_STEP_RUN, userId, workflowId: w.id, step: step(), attempt, idempotencyKey: `${r!.id}:price`, ctx: { trigger: {}, steps: {} } });
    await exec(1);
    await exec(2);
    const claims = await db.select().from(usageClaims).where(eq(usageClaims.userId, userId));
    expect(claims.filter((c) => c.key === `${r!.id}:price` && c.kind === "http")).toHaveLength(1);
  });

  it("fills the address from the run's data", async () => {
    const w = await workflow();
    const [r] = await db.insert(runs).values({ workflowVersionId: w.versionId }).returning();
    const out = await executor().execute({
      runId: r!.id, stepRunId: NO_STEP_RUN, userId, workflowId: w.id, attempt: 1, idempotencyKey: `${r!.id}:price`,
      step: step({ url: `http://supplier.test:${port}/{{trigger.page}}` }), ctx: { trigger: { page: "rice" }, steps: {} },
    });
    expect(out.output).toMatchObject({ title: "Rice" });
  });

  it("returns a fixed sample page in a mocked test run, without any request", async () => {
    const w = await workflow();
    const before = hits;
    const out = await runOnce(w, step({ url: "https://not-a-real-site.invalid/rice" }), { mock: true });
    expect(hits).toBe(before);
    expect(out.output).toMatchObject({ mocked: true, previous: null, changed: false });
    expect(typeof (out.output as { title: string }).title).toBe("string");
    expect((out.output as { value: string }).value).not.toBe("");
  });

  it("returns the whole sample text as the value when the mocked step has no selector", async () => {
    const out = await runOnce(await workflow(), step({ selector: undefined }), { mock: true });
    const o = out.output as { text: string; value: string };
    expect(o.value).toBe(o.text);
  });
});
