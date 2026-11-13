import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { claimTimeout, createApproval, findPendingApproval, hashToken, recordDecision } from "./approvals";
import { approvals, runs, stepRuns, users, workflows, workflowVersions, workspaceMembers, type Role } from "./schema";
import type { Db } from "./index";

let db: Db;
let pool: Pool;
let versionId: string;
let ownerId: string;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  const [user] = await db.insert(users).values({ email: "approver@test.local", passwordHash: "x" }).returning();
  ownerId = user!.id;
  await db.insert(workspaceMembers).values({ userId: ownerId, workspaceId: ownerId, role: "owner" });
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
    expect((await claimTimeout(db, stepRunId)).branch).toBe("timeout");
    expect(await recordDecision(db, token, "approved")).toBeNull();
  });

  it("returns the recorded decision when the approver answered first", async () => {
    const { stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, inAnHour());
    await recordDecision(db, token, "approved");
    expect((await claimTimeout(db, stepRunId)).branch).toBe("approved");
  });

  it("lets exactly one side win when the click and the timeout race", async () => {
    for (let i = 0; i < 10; i++) {
      const { stepRunId } = await waitingStep();
      const token = await createApproval(db, stepRunId, inAnHour());
      const [recorded, { branch: outcome }] = await Promise.all([recordDecision(db, token, "approved"), claimTimeout(db, stepRunId)]);
      expect(outcome).toBe(recorded ? "approved" : "timeout");
      const [row] = await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId));
      expect(row!.decision).toBe(outcome);
    }
  });
});

let seq = 0;
/** A user who is a member of `workspaceId` with `role`, or of their own workspace when no workspace is given. */
async function member(role: Role, workspaceId?: string) {
  const [u] = await db.insert(users).values({ email: `m${++seq}@test.local`, passwordHash: "x" }).returning();
  await db.insert(workspaceMembers).values({ userId: u!.id, workspaceId: workspaceId ?? u!.id, role: workspaceId ? role : "owner" });
  return { id: u!.id, email: u!.email };
}
const rowOf = async (stepRunId: string) => (await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId)))[0]!;

describe("named approvals (decision 0022)", () => {
  it("lets only the named approver decide, signed in, and records who decided and when", async () => {
    const approver = await member("approver", ownerId);
    const colleague = await member("approver", ownerId);
    const { runId, stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, inAnHour(), approver.id);
    expect((await findPendingApproval(db, token))?.approverId).toBe(approver.id);

    // A forwarded link: someone signed out, or a colleague signed in, gets nothing.
    expect(await recordDecision(db, token, "approved")).toBeNull();
    expect(await recordDecision(db, token, "approved", colleague)).toBeNull();
    expect((await rowOf(stepRunId)).usedAt).toBeNull();

    expect(await recordDecision(db, token, "approved", approver)).toBe(runId);
    const row = await rowOf(stepRunId);
    expect(row.decision).toBe("approved");
    expect(row.decidedBy).toBe(approver.id);
    expect(row.decidedByEmail).toBe(approver.email);
    expect(row.usedAt).not.toBeNull();

    // A repeated answer changes nothing.
    expect(await recordDecision(db, token, "rejected", approver)).toBeNull();
    expect((await rowOf(stepRunId)).decision).toBe("approved");
    expect(await claimTimeout(db, stepRunId)).toMatchObject({ branch: "approved", decidedBy: approver.email });
  });

  it("refuses an approver who was removed or demoted after the link went out", async () => {
    const removed = await member("approver", ownerId);
    const demoted = await member("approver", ownerId);
    const a = await waitingStep();
    const b = await waitingStep();
    const ta = await createApproval(db, a.stepRunId, inAnHour(), removed.id);
    const tb = await createApproval(db, b.stepRunId, inAnHour(), demoted.id);
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, removed.id));
    await db.update(workspaceMembers).set({ role: "requester" }).where(eq(workspaceMembers.userId, demoted.id));
    expect(await recordDecision(db, ta, "approved", removed)).toBeNull();
    expect(await recordDecision(db, tb, "approved", demoted)).toBeNull();
  });

  it("refuses the same person once they belong to another workspace", async () => {
    const moved = await member("approver", ownerId);
    const { stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, inAnHour(), moved.id);
    const other = await member("owner");
    await db.update(workspaceMembers).set({ workspaceId: other.id }).where(eq(workspaceMembers.userId, moved.id));
    expect(await recordDecision(db, token, "approved", moved)).toBeNull();
  });

  it("refuses a user from another workspace, even its owner", async () => {
    const approver = await member("approver", ownerId);
    const stranger = await member("owner");
    const { stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, inAnHour(), approver.id);
    expect(await recordDecision(db, token, "approved", stranger)).toBeNull();
  });

  it("refuses an expired named link", async () => {
    const approver = await member("approver", ownerId);
    const { stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, new Date(Date.now() - 1000), approver.id);
    expect(await recordDecision(db, token, "approved", approver)).toBeNull();
  });

  it("records exactly one of two concurrent answers", async () => {
    const approver = await member("approver", ownerId);
    for (let i = 0; i < 10; i++) {
      const { stepRunId } = await waitingStep();
      const token = await createApproval(db, stepRunId, inAnHour(), approver.id);
      const results = await Promise.all([recordDecision(db, token, "approved", approver), recordDecision(db, token, "rejected", approver)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await rowOf(stepRunId)).decision).toBe(results[0] ? "approved" : "rejected");
    }
  });

  it("keeps a link-holder approval (no approver, like links sent before phase 4) working without sign-in", async () => {
    const { runId, stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, inAnHour());
    expect((await findPendingApproval(db, token))?.approverId).toBeNull();
    expect(await recordDecision(db, token, "approved")).toBe(runId);
    expect((await rowOf(stepRunId)).decidedBy).toBeNull();
  });

  it("lets the owner answer an approval named to them", async () => {
    const owner = (await db.select().from(users).where(eq(users.id, ownerId)))[0]!;
    const { runId, stepRunId } = await waitingStep();
    const token = await createApproval(db, stepRunId, inAnHour(), ownerId);
    expect(await recordDecision(db, token, "rejected", { id: owner.id, email: owner.email })).toBe(runId);
  });
});
