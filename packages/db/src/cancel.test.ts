import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApproval, findPendingApproval, recordDecision } from "./approvals";
import { cancelRun, resolveRun } from "./runs";
import { runs, stepRuns, users, workflows, workflowVersions } from "./schema";
import type { Db } from "./index";

let db: Db;
let pool: Pool;
let seq = 0;

beforeAll(async () => ({ db, pool } = await freshDatabase()), 120_000);
afterAll(() => pool?.end());

async function setup(state: typeof runs.$inferInsert.state, step?: "waiting" | "succeeded") {
  const [u] = await db.insert(users).values({ email: `c${++seq}@test.local`, passwordHash: "x" }).returning();
  const [w] = await db.insert(workflows).values({ userId: u!.id, name: "W", slug: `w${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: w!.id, version: 1, definition: {}, published: true }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {}, state, nextAttemptAt: state === "waiting" ? new Date(Date.now() + 3_600_000) : null }).returning();
  const [s] = step ? await db.insert(stepRuns).values({ runId: r!.id, stepId: "wait", attempt: 1, state: step }).returning() : [];
  return { userId: u!.id, runId: r!.id, stepRunId: s?.id };
}
const run = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0]!;
const steps = (runId: string) => db.select().from(stepRuns).where(eq(stepRuns.runId, runId));

describe("cancel a pending run (N11b)", () => {
  it("cancels a pending run that no worker has started", async () => {
    const a = await setup("pending");
    expect(await cancelRun(db, a.userId, a.runId, "ana@test.local")).toBe(true);
    expect(await run(a.runId)).toMatchObject({ state: "cancelled", error: "Cancelled by ana@test.local." });
    expect((await run(a.runId)).finishedAt).toBeInstanceOf(Date);
  });

  it("cancels a run waiting on a delay, closes its waiting step and says who", async () => {
    const a = await setup("waiting", "waiting");
    expect(await cancelRun(db, a.userId, a.runId, "ana@test.local")).toBe(true);
    expect((await run(a.runId)).state).toBe("cancelled");
    const [step] = await steps(a.runId);
    expect(step).toMatchObject({ state: "failed", outcome: "not_sent", error: "Cancelled by ana@test.local.", resolvedBy: "ana@test.local" });
    expect(step!.finishedAt).toBeInstanceOf(Date);
  });

  it("makes an open approval link useless, so the answer cannot resume or confirm anything", async () => {
    const a = await setup("waiting", "waiting");
    const link = (await createApproval(db, a.stepRunId!, new Date(Date.now() + 3_600_000)))!;
    expect(await findPendingApproval(db, link.token)).not.toBeNull();
    await cancelRun(db, a.userId, a.runId, "ana@test.local");
    expect(await findPendingApproval(db, link.token)).toBeNull();
    expect(await recordDecision(db, link.token, "approved")).toBeNull();
    expect((await run(a.runId)).state).toBe("cancelled");
  });

  it("refuses a running, review, failed, finished or already cancelled run, and changes nothing", async () => {
    for (const state of ["running", "needs_review", "failed", "succeeded"] as const) {
      const a = await setup(state, state === "needs_review" ? "succeeded" : undefined);
      expect(await cancelRun(db, a.userId, a.runId, "ana@test.local")).toBe(false);
      expect((await run(a.runId)).state).toBe(state);
    }
    const done = await setup("waiting", "waiting");
    expect(await cancelRun(db, done.userId, done.runId, "ana@test.local")).toBe(true);
    expect(await cancelRun(db, done.userId, done.runId, "ana@test.local")).toBe(false);
  });

  it("answers false for another workspace's run and for an unknown id", async () => {
    const a = await setup("pending");
    const b = await setup("pending");
    expect(await cancelRun(db, b.userId, a.runId, "bo@test.local")).toBe(false);
    expect(await cancelRun(db, a.userId, "00000000-0000-4000-8000-000000000000", "ana@test.local")).toBe(false);
    expect((await run(a.runId)).state).toBe("pending");
  });

  it("lets exactly one of two concurrent cancels win", async () => {
    const a = await setup("waiting", "waiting");
    const results = await Promise.all([cancelRun(db, a.userId, a.runId, "x@test.local"), cancelRun(db, a.userId, a.runId, "y@test.local")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("leaves a cancelled run with no way out: Retry and Send again find nothing to do", async () => {
    const a = await setup("pending");
    await cancelRun(db, a.userId, a.runId, "ana@test.local");
    for (const action of ["retry", "again", "stop", "delivered"] as const) expect(await resolveRun(db, a.userId, a.runId, action, "ana@test.local")).toBe(false);
  });
});
