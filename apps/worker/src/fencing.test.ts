import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolveRun, runs, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { StepError } from "@daloy/engine";
import { asc, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { advance, type AdvanceDeps, type StepExecutor } from "./advance";
import { httpRequest } from "./steps/http";
import { BLOCKED_RANGES, blockListOf } from "./steps/ssrf";

/**
 * Failure windows of decision 0030, driven by hand: no background worker, so each test decides exactly which worker
 * acts when. A "stale" worker is one whose lease another worker took over while it was still working. Sends are real
 * POSTs to a local receiver that answers 503, so the tests count what the receiver got, not only database rows.
 */
let db: Db;
let pool: Pool;
let receiver: Server;
let port = 0;
let received = 0;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  receiver = createServer((req, res) => {
    received++;
    req.resume().on("end", () => res.writeHead(503).end());
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  port = (receiver.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  receiver?.close();
  await pool?.end();
});

const guard = () => ({
  blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")),
  ports: [String(port)],
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
});

type Call = { stepId: string; attempt: number; key: string };
type Exec = Parameters<StepExecutor["execute"]>[0];
function executor(calls: Call[], behave: (input: Exec) => Promise<{ output?: unknown }> = async () => ({ output: { ok: true } })): StepExecutor {
  return {
    async execute(input) {
      calls.push({ stepId: input.step.id, attempt: input.attempt, key: input.idempotencyKey });
      return behave(input);
    },
  };
}
/** What the real HTTP step does: claim the send, then POST to the receiver. pause runs while the claim is held. */
const realPost = async ({ idempotencyKey, claimSend }: Exec, pause?: Promise<void>) => {
  const claim = claimSend && pause ? async () => { const release = await claimSend(); await pause; return release; } : claimSend;
  return { output: await httpRequest({ method: "POST", url: `http://public.test:${port}/orders`, headers: {}, body: "{}" }, idempotencyKey, { guard: guard(), claim }) };
};

const deps = (owner: string, exec: StepExecutor): AdvanceDeps => ({ db, executor: exec, owner, leaseMs: 60_000, retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }, enqueue: async () => {} });

const post = (id: string, idempotent?: boolean) => ({ id, type: "http", config: { method: "POST", url: "https://orders.example.com/orders", headers: {}, idempotent } });
const flow = (...steps: object[]) => ({
  trigger: { type: "manual", config: {} },
  steps,
  edges: steps.slice(1).map((s, i) => ({ from: (steps[i] as { id: string }).id, to: (s as { id: string }).id })),
});
const done = { id: "done", type: "delay", config: { seconds: 1 } };

let seq = 0;
async function createRun(definition: object) {
  const [user] = await db.insert(users).values({ email: `f${++seq}@test.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: user!.id, name: "f", slug: `f${seq}` }).returning();
  const [version] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true }).returning();
  const [run] = await db.insert(runs).values({ workflowVersionId: version!.id, triggerPayload: {} }).returning();
  return { runId: run!.id, workspaceId: user!.id };
}

const runOf = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0]!;
const rowsOf = (id: string) => db.select().from(stepRuns).where(eq(stepRuns.runId, id)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));
/** What a lost lease looks like: the heartbeat stopped, so another worker may take the run. */
const loseLease = (id: string) => db.update(runs).set({ leaseOwner: "gone", leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(runs.id, id));
const until = async (check: () => boolean) => {
  while (!check()) await new Promise((r) => setTimeout(r, 10));
};

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

describe("send claims and dispatch marks (decision 0030)", () => {
  it("writes the dispatch mark when an unsafe send is claimed, and offers no claim to a safe step", async () => {
    const { runId } = await createRun(flow(post("send"), post("check", true)));
    const calls: Call[] = [];
    const marks: (Date | null)[] = [];
    const exec = executor(calls, async ({ claimSend }) => {
      const release = await claimSend?.();
      marks.push((await rowsOf(runId)).at(-1)!.dispatchedAt);
      release?.();
      return { output: { ok: true } };
    });
    await advance(deps("w", exec), runId);
    await advance(deps("w", exec), runId);
    expect(marks[0]).toBeInstanceOf(Date);
    expect(marks[1]).toBeNull();
    expect(calls.map((c) => c.key)).toEqual([`${runId}:send`, `${runId}:check`]);
  });

  it("a worker paused before its send claim sends nothing after another worker took over and the operator chose Stop", async () => {
    const { runId, workspaceId } = await createRun(flow(post("send"), done));
    const paused = gate();
    const callsA: Call[] = [];
    const a = advance(deps("A", executor(callsA, async (input) => (await paused.opened, realPost(input)))), runId);
    await until(() => callsA.length > 0);
    await loseLease(runId);

    // Nothing was dispatched, so B may run the attempt: it gets a 503 and parks the run.
    const before = received;
    await advance(deps("B", executor([], realPost)), runId);
    expect(received - before).toBe(1);
    expect((await runOf(runId)).state).toBe("needs_review");
    expect(await resolveRun(db, workspaceId, runId, "stop", "ops@test.local")).toBe(true);

    paused.open();
    await expect(a).rejects.toThrow();
    expect(received - before).toBe(1);
    expect((await runOf(runId)).state).toBe("cancelled");
  });

  it("a worker paused while it holds the send claim makes the takeover wait, and Stop cannot come before its send", async () => {
    const { runId, workspaceId } = await createRun(flow(post("send"), done));
    const paused = gate();
    const callsA: Call[] = [];
    const before = received;
    const a = advance(deps("A", executor(callsA, (input) => realPost(input, paused.opened))), runId);
    await until(() => callsA.length > 0);
    // Wait until A holds the claim: its dispatch mark is committed before the lock is taken.
    while (!(await rowsOf(runId)).at(-1)?.dispatchedAt) await new Promise((r) => setTimeout(r, 10));
    await loseLease(runId);

    const callsB: Call[] = [];
    const b = advance(deps("B", executor(callsB, realPost)), runId);
    await new Promise((r) => setTimeout(r, 200));
    // B waits on A's claim; the run is still running, so there is nothing to stop yet.
    expect(await resolveRun(db, workspaceId, runId, "stop", "ops@test.local")).toBe(false);
    expect(received - before).toBe(0);

    paused.open();
    await Promise.allSettled([a, b]);
    expect(callsB).toEqual([]);
    expect(received - before).toBe(1);
    expect((await runOf(runId)).state).toBe("needs_review");
    expect(await resolveRun(db, workspaceId, runId, "stop", "ops@test.local")).toBe(true);
    expect(received - before).toBe(1);
  });

  it("parks for review, without sending again, a POST whose worker stopped after sending", async () => {
    const { runId } = await createRun(flow(post("send"), done));
    const stuck = gate();
    const callsA: Call[] = [];
    const a = advance(deps("A", executor(callsA, async ({ claimSend }) => {
      (await claimSend!())();
      await stuck.opened;
      return { output: { late: true } };
    })), runId);
    await until(() => callsA.length > 0);
    while (!(await rowsOf(runId)).at(-1)?.dispatchedAt) await new Promise((r) => setTimeout(r, 10));
    await loseLease(runId);

    const callsB: Call[] = [];
    await advance(deps("B", executor(callsB)), runId);
    expect(callsB).toEqual([]);
    expect((await runOf(runId)).state).toBe("needs_review");
    const [row] = await rowsOf(runId);
    expect([row!.state, row!.outcome]).toEqual(["failed", "unknown"]);
    expect(row!.error).toMatch(/may have gone through/);

    // The stale worker's late answer cannot overwrite the parked attempt.
    stuck.open();
    await expect(a).rejects.toThrow();
    expect((await runOf(runId)).state).toBe("needs_review");
    expect((await rowsOf(runId)).map((r) => [r.attempt, r.state, r.output])).toEqual([[1, "failed", null]]);
  });

  it("keeps an operator's decision when the stale worker answers after it", async () => {
    const { runId, workspaceId } = await createRun(flow(post("send"), done));
    const stuck = gate();
    const callsA: Call[] = [];
    const a = advance(deps("A", executor(callsA, async ({ claimSend }) => {
      (await claimSend!())();
      await stuck.opened;
      return { output: { late: true } };
    })), runId);
    await until(() => callsA.length > 0);
    while (!(await rowsOf(runId)).at(-1)?.dispatchedAt) await new Promise((r) => setTimeout(r, 10));
    await loseLease(runId);
    await advance(deps("B", executor([])), runId);
    expect(await resolveRun(db, workspaceId, runId, "delivered", "ops@test.local")).toBe(true);

    stuck.open();
    await expect(a).rejects.toThrow();
    const rows = await rowsOf(runId);
    expect(rows.map((r) => [r.stepId, r.attempt, r.state, r.output])).toEqual([
      ["send", 1, "failed", null],
      ["send", 2, "succeeded", { reconciled: "delivered" }],
    ]);
    expect([rows[0]!.resolvedBy, rows[0]!.resolvedAt]).toEqual(["ops@test.local", expect.any(Date)]);
    expect((await runOf(runId)).state).toBe("running");
  });

  it("re-runs a safe step after a takeover under a new claim, and ignores the stale worker's answer", async () => {
    const { runId } = await createRun(flow(post("check", true), done));
    const stuck = gate();
    const callsA: Call[] = [];
    const a = advance(deps("A", executor(callsA, () => stuck.opened.then(() => ({ output: { from: "A" } })))), runId);
    await until(() => callsA.length > 0);
    await loseLease(runId);

    const callsB: Call[] = [];
    await advance(deps("B", executor(callsB, async () => ({ output: { from: "B" } }))), runId);
    // Same attempt, same row, same key: the step is safe to repeat.
    expect(callsB).toEqual([{ stepId: "check", attempt: 1, key: `${runId}:check` }]);
    stuck.open();
    await expect(a).rejects.toThrow();
    expect((await rowsOf(runId)).map((r) => [r.attempt, r.state, r.output])).toEqual([[1, "succeeded", { from: "B" }]]);
  });

  it("parks an unknown failure of a POST for review and sends nothing more on its own", async () => {
    const { runId } = await createRun(flow(post("send"), done));
    const before = received;
    const exec = executor([], realPost);
    await advance(deps("w", exec), runId);
    await advance(deps("w", exec), runId);
    expect(received - before).toBe(1);
    const run = await runOf(runId);
    expect([run.state, run.finishedAt]).toEqual(["needs_review", null]);
    expect(run.error).toMatch(/HTTP 503/);
    const [row] = await rowsOf(runId);
    expect([row!.state, row!.outcome, row!.deadLetter]).toEqual(["failed", "unknown", false]);
  });

  it("Send again runs exactly one more attempt with the same key; two concurrent actions act once", async () => {
    const { runId, workspaceId } = await createRun(flow(post("send"), done));
    const calls: Call[] = [];
    let fail = true;
    const exec = executor(calls, () => (fail ? Promise.reject(new StepError("HTTP 503", false, { outcome: "unknown" })) : Promise.resolve({ output: { ok: true } })));
    await advance(deps("w", exec), runId);
    const results = await Promise.all([resolveRun(db, workspaceId, runId, "again", "a@test.local"), resolveRun(db, workspaceId, runId, "again", "b@test.local")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // A Stop after the Send again finds the run running and does nothing.
    expect(await resolveRun(db, workspaceId, runId, "stop", "c@test.local")).toBe(false);
    fail = false;
    await advance(deps("w", exec), runId);
    expect(calls.map((c) => [c.attempt, c.key])).toEqual([
      [1, `${runId}:send`],
      [2, `${runId}:send`],
    ]);
  });

  it("refuses an action on a run of another workspace or in the wrong state", async () => {
    const { runId, workspaceId } = await createRun(flow(post("send")));
    const other = await createRun(flow(post("send")));
    expect(await resolveRun(db, workspaceId, runId, "again", "x")).toBe(false);
    expect(await resolveRun(db, other.workspaceId, runId, "retry", "x")).toBe(false);
  });

  it("Retry gives a dead-lettered run one more attempt, which can succeed", async () => {
    const { runId, workspaceId } = await createRun(flow(post("check", true)));
    const calls: Call[] = [];
    let down = true;
    const exec = executor(calls, () => (down ? Promise.reject(new StepError("HTTP 503", true, { outcome: "unknown" })) : Promise.resolve({ output: { ok: true } })));
    for (let i = 0; i < 5; i++) await advance(deps("w", exec), runId);
    expect((await runOf(runId)).state).toBe("failed");
    expect((await rowsOf(runId)).at(-1)!.deadLetter).toBe(true);
    down = false;
    const [first, second] = await Promise.all([resolveRun(db, workspaceId, runId, "retry", "ops@test.local"), resolveRun(db, workspaceId, runId, "retry", "ops@test.local")]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    await advance(deps("w", exec), runId);
    await advance(deps("w", exec), runId);
    expect((await runOf(runId)).state).toBe("succeeded");
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set([`${runId}:check`]));
    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3, 4]);
  });
});
