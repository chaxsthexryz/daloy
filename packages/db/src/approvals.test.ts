import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { claimTimeout, createApproval, findPendingApproval, hashToken, recordDecision } from "./approvals";
import { approvals, runs, stepRuns, users, workflows, workflowVersions } from "./schema";
import type { Db } from "./index";

let db: Db;
let pool: Pool;
let versionId: string;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  const [user] = await db.insert(users).values({ email: "approver@test.local", passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: user!.id, name: "Refunds", slug: "refunds" }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  versionId = v!.id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
});

/** A run parked on a waiting approval step, as the worker leaves it. */
async function waitingStep(message = "Refund 40 EUR?") {
  const later = new Date(Date.now() + 3_600_000);
  const [run] = await db.insert(runs).values({ workflowVersionId: versionId, state: "waiting", nextAttemptAt: later }).returning();
  const [step] = await db.insert(stepRuns).values({ runId: run!.id, stepId: "ask", attempt: 1, state: "waiting", input: { message } }).returning();
  return { runId: run!.id, stepRunId: step!.id };
}
const inAnHour = () => new Date(Date.now() + 3_600_000);

describe("createApproval", () => {
  it("returns a 32-byte url-safe token and stores only its SHA-256", async () => {
    const { stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, inAnHour());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId));
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(row!.tokenHash).not.toContain(token);
  });

  it("replaces the link of an earlier try of the same step run", async () => {
    const { stepRunId } = await waitingStep();
    const first = await createApproval(db, stepRunId, inAnHour());
    const second = await createApproval(db, stepRunId, inAnHour());
    expect(await findPendingApproval(db, first)).toBeNull();
    expect(await findPendingApproval(db, second)).not.toBeNull();
  });
});

describe("findPendingApproval", () => {
  it("returns the step input for a live link and null for unknown, used or expired ones", async () => {
    const { stepRunId } = await waitingStep("Pay invoice 17?");
    const token = await createApproval(db, stepRunId, inAnHour());
    expect((await findPendingApproval(db, token))?.input).toEqual({ message: "Pay invoice 17?" });
    expect(await findPendingApproval(db, "x".repeat(43))).toBeNull();

    const expired = await createApproval(db, (await waitingStep()).stepRunId, new Date(Date.now() - 1000));
    expect(await findPendingApproval(db, expired)).toBeNull();

    await recordDecision(db, token, "approved");
    expect(await findPendingApproval(db, token)).toBeNull();
  });
});

describe("recordDecision", () => {
  it("records the decision once and wakes the waiting run", async () => {
    const { runId, stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, inAnHour());

    expect(await recordDecision(db, token, "rejected")).toBe(runId);
    const [row] = await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId));
    expect(row!.decision).toBe("rejected");
    expect(row!.usedAt).not.toBeNull();
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // Replay: the same link a second time changes nothing.
    expect(await recordDecision(db, token, "approved")).toBeNull();
    const [after] = await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId));
    expect(after!.decision).toBe("rejected");
  });

  it("refuses expired and unknown links", async () => {
    const { stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, new Date(Date.now() - 1000));
    expect(await recordDecision(db, token, "approved")).toBeNull();
    expect(await recordDecision(db, "y".repeat(43), "approved")).toBeNull();
  });
});

describe("claimTimeout", () => {
  it("marks an unanswered approval as timed out, which kills the link", async () => {
    const { stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, inAnHour());
    expect(await claimTimeout(db, stepRunId)).toBe("timeout");
    expect(await recordDecision(db, token, "approved")).toBeNull();
  });

  it("returns the recorded decision when the approver answered first", async () => {
    const { stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, inAnHour());
    await recordDecision(db, token, "approved");
    expect(await claimTimeout(db, stepRunId)).toBe("approved");
  });

  it("lets exactly one side win when the click and the timeout race", async () => {
    for (let i = 0; i < 10; i++) {
      const { stepRunId } = await waitingStep();
      const token = await createApproval(db, stepRunId, inAnHour());
      const [recorded, outcome] = await Promise.all([recordDecision(db, token, "approved"), claimTimeout(db, stepRunId)]);
      expect(outcome).toBe(recorded ? "approved" : "timeout");
      const [row] = await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId));
      expect(row!.decision).toBe(outcome);
    }
  });
});
