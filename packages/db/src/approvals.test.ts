import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { claimTimeout, createApproval, decideApprovalById, findPendingApproval, hashToken, listPendingApprovals, recordDecision } from "./approvals";
import { approvals, runs, stepRuns, users, workflows, workflowVersions, workspaceMembers, type Role } from "./schema";
import { createDb, type Db } from "./index";

let db: Db;
let pool: Pool;
let url: string;
let versionId: string;
let ownerId: string;

beforeAll(async () => {
  ({ db, pool, url } = await freshDatabase());
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
// The worker always claims inside a transaction, which holds the run lock for the whole claim.
const claim = (stepRunId: string) => db.transaction((tx) => claimTimeout(tx, stepRunId));

describe("createApproval", () => {
  it("returns a 32-byte url-safe token and stores only its SHA-256", async () => {
    const { stepRunId } = await waitingStep();
    const token = (await createApproval(db, stepRunId, inAnHour()))!.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId));
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(row!.tokenHash).not.toContain(token);
  });

  it("keeps both links of a re-run attempt usable until the first answer", async () => {
    const { stepRunId } = await waitingStep();
    const first = (await createApproval(db, stepRunId, inAnHour()))!.token;
    const second = (await createApproval(db, stepRunId, inAnHour()))!.token;
    expect(await findPendingApproval(db, first)).not.toBeNull();
    expect(await findPendingApproval(db, second)).not.toBeNull();
    expect(await recordDecision(db, second, "approved")).not.toBeNull();
    expect(await findPendingApproval(db, first)).toBeNull();
  });
});

/** Another attempt of the same approval step in the same run, as a retry after a failed send leaves it. */
async function retryOf(runId: string, attempt = 2) {
  const [step] = await db.insert(stepRuns).values({ runId, stepId: "ask", attempt, state: "running" }).returning();
  return step!.id;
}
const decisionsOf = async (runId: string) =>
  (await db.select({ decision: approvals.decision }).from(approvals).innerJoin(stepRuns, eq(stepRuns.id, approvals.stepRunId)).where(eq(stepRuns.runId, runId))).map((r) => r.decision);

describe("one decision per approval step, across attempts (QA regression, fec03cc)", () => {
  it("keeps link A usable after a retry sends link B, and the first answer decides for both", async () => {
    for (const decision of ["approved", "rejected"] as const) {
      const { runId, stepRunId } = await waitingStep();
      const a = (await createApproval(db, stepRunId, inAnHour()))!;
      const b = (await createApproval(db, await retryOf(runId), inAnHour()))!;
      expect(await findPendingApproval(db, a.token)).not.toBeNull();
      expect(await recordDecision(db, a.token, decision)).toBe(runId);
      expect(await recordDecision(db, b.token, decision === "approved" ? "rejected" : "approved")).toBeNull();
      expect(await decisionsOf(runId)).toEqual([decision, decision]);
    }
  });

  it("also takes the answer given through the newer link", async () => {
    const { runId, stepRunId } = await waitingStep();
    const a = (await createApproval(db, stepRunId, inAnHour()))!;
    const retry = await retryOf(runId);
    const b = (await createApproval(db, retry, inAnHour()))!;
    expect(await recordDecision(db, b.token, "rejected")).toBe(runId);
    expect(await recordDecision(db, a.token, "approved")).toBeNull();
    expect(await claim(retry)).toMatchObject({ branch: "rejected" });
  });

  it("carries a decision made before the retry over to it, without a new link", async () => {
    const { runId, stepRunId } = await waitingStep();
    const a = (await createApproval(db, stepRunId, inAnHour()))!;
    await recordDecision(db, a.token, "rejected");
    const retry = await retryOf(runId);
    expect(await createApproval(db, retry, inAnHour())).toBeNull();
    expect(await claim(retry)).toMatchObject({ branch: "rejected" });
    expect(await decisionsOf(runId)).toEqual(["rejected"]);
  });

  it("keeps the first deadline for every later link", async () => {
    const { runId, stepRunId } = await waitingStep();
    const first = new Date(Date.now() + 3_600_000);
    const a = (await createApproval(db, stepRunId, first))!;
    const b = (await createApproval(db, await retryOf(runId), new Date(Date.now() + 7_200_000)))!;
    expect(a.expiresAt.getTime()).toBe(first.getTime());
    expect(b.expiresAt.getTime()).toBe(first.getTime());
  });

  it("records exactly one of two answers given at once through different links", async () => {
    const others = [createDb(url), createDb(url)];
    try {
      for (let i = 0; i < 10; i++) {
        const { runId, stepRunId } = await waitingStep();
        const a = (await createApproval(db, stepRunId, inAnHour()))!;
        const b = (await createApproval(db, await retryOf(runId), inAnHour()))!;
        const results = await Promise.all([recordDecision(others[0]!.db, a.token, "approved"), recordDecision(others[1]!.db, b.token, "rejected")]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = results[0] ? "approved" : "rejected";
        expect(await decisionsOf(runId)).toEqual([winner, winner]);
      }
    } finally {
      await Promise.all(others.map((o) => o.pool.end()));
    }
  });

  it("does not take a branch when woken before the deadline with no answer", async () => {
    const { stepRunId } = await waitingStep();
    const deadline = inAnHour();
    const a = (await createApproval(db, stepRunId, deadline))!;
    expect(await claim(stepRunId)).toMatchObject({ branch: null, pendingUntil: deadline });
    expect(await findPendingApproval(db, a.token)).not.toBeNull();
  });
});

describe("findPendingApproval", () => {
  it("returns the step input for a live link and null for unknown, used or expired ones", async () => {
    const { stepRunId } = await waitingStep("Pay invoice 17?");
    const token = (await createApproval(db, stepRunId, inAnHour()))!.token;
    expect((await findPendingApproval(db, token))?.input).toEqual({ message: "Pay invoice 17?" });
    expect(await findPendingApproval(db, "x".repeat(43))).toBeNull();

    const expired = (await createApproval(db, (await waitingStep()).stepRunId, new Date(Date.now() - 1000)))!.token;
    expect(await findPendingApproval(db, expired)).toBeNull();

    await recordDecision(db, token, "approved");
    expect(await findPendingApproval(db, token)).toBeNull();
  });
});

describe("recordDecision", () => {
  it("records the decision once and wakes the waiting run", async () => {
    const { runId, stepRunId } = await waitingStep();
    const token = (await createApproval(db, stepRunId, inAnHour()))!.token;

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
    const token = (await createApproval(db, stepRunId, new Date(Date.now() - 1000)))!.token;
    expect(await recordDecision(db, token, "approved")).toBeNull();
    expect(await recordDecision(db, "y".repeat(43), "approved")).toBeNull();
  });
});

describe("claimTimeout", () => {
  it("marks an unanswered approval as timed out once its deadline has passed, which kills the link", async () => {
    const { stepRunId } = await waitingStep();
    const token = (await createApproval(db, stepRunId, new Date(Date.now() - 1000)))!.token;
    expect((await claim(stepRunId)).branch).toBe("timeout");
    expect(await recordDecision(db, token, "approved")).toBeNull();
  });

  it("returns the recorded decision when the approver answered first", async () => {
    const { stepRunId } = await waitingStep();
    const token = (await createApproval(db, stepRunId, inAnHour()))!.token;
    await recordDecision(db, token, "approved");
    expect((await claim(stepRunId)).branch).toBe("approved");
  });

  it("lets at most one side win when the click and the timeout race at the deadline", async () => {
    for (let i = 0; i < 10; i++) {
      const { stepRunId } = await waitingStep();
      const token = (await createApproval(db, stepRunId, new Date(Date.now() + 50)))!.token;
      await new Promise((r) => setTimeout(r, 45));
      const [recorded, claimed] = await Promise.all([recordDecision(db, token, "approved"), claim(stepRunId)]);
      const [row] = await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId));
      expect(row!.decision === "approved").toBe(recorded !== null);
      if (claimed.branch !== null) expect(row!.decision).toBe(claimed.branch);
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
    const token = (await createApproval(db, stepRunId, inAnHour(), approver.id))!.token;
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
    expect(await claim(stepRunId)).toMatchObject({ branch: "approved", decidedBy: approver.email });
  });

  it("refuses an approver who was removed or demoted after the link went out", async () => {
    const removed = await member("approver", ownerId);
    const demoted = await member("approver", ownerId);
    const a = await waitingStep();
    const b = await waitingStep();
    const ta = (await createApproval(db, a.stepRunId, inAnHour(), removed.id))!.token;
    const tb = (await createApproval(db, b.stepRunId, inAnHour(), demoted.id))!.token;
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, removed.id));
    await db.update(workspaceMembers).set({ role: "requester" }).where(eq(workspaceMembers.userId, demoted.id));
    expect(await recordDecision(db, ta, "approved", removed)).toBeNull();
    expect(await recordDecision(db, tb, "approved", demoted)).toBeNull();
  });

  it("refuses the same person once they belong to another workspace", async () => {
    const moved = await member("approver", ownerId);
    const { stepRunId } = await waitingStep();
    const token = (await createApproval(db, stepRunId, inAnHour(), moved.id))!.token;
    const other = await member("owner");
    await db.update(workspaceMembers).set({ workspaceId: other.id }).where(eq(workspaceMembers.userId, moved.id));
    expect(await recordDecision(db, token, "approved", moved)).toBeNull();
  });

  it("refuses a user from another workspace, even its owner", async () => {
    const approver = await member("approver", ownerId);
    const stranger = await member("owner");
    const { stepRunId } = await waitingStep();
    const token = (await createApproval(db, stepRunId, inAnHour(), approver.id))!.token;
    expect(await recordDecision(db, token, "approved", stranger)).toBeNull();
  });

  it("refuses an expired named link", async () => {
    const approver = await member("approver", ownerId);
    const { stepRunId } = await waitingStep();
    const token = (await createApproval(db, stepRunId, new Date(Date.now() - 1000), approver.id))!.token;
    expect(await recordDecision(db, token, "approved", approver)).toBeNull();
  });

  it("records exactly one of two concurrent answers", async () => {
    const approver = await member("approver", ownerId);
    for (let i = 0; i < 10; i++) {
      const { stepRunId } = await waitingStep();
      const token = (await createApproval(db, stepRunId, inAnHour(), approver.id))!.token;
      const results = await Promise.all([recordDecision(db, token, "approved", approver), recordDecision(db, token, "rejected", approver)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await rowOf(stepRunId)).decision).toBe(results[0] ? "approved" : "rejected");
    }
  });

  it("keeps a link-holder approval (no approver, like links sent before phase 4) working without sign-in", async () => {
    const { runId, stepRunId } = await waitingStep();
    const token = (await createApproval(db, stepRunId, inAnHour()))!.token;
    expect((await findPendingApproval(db, token))?.approverId).toBeNull();
    expect(await recordDecision(db, token, "approved")).toBe(runId);
    expect((await rowOf(stepRunId)).decidedBy).toBeNull();
  });

  it("lets the owner answer an approval named to them", async () => {
    const owner = (await db.select().from(users).where(eq(users.id, ownerId)))[0]!;
    const { runId, stepRunId } = await waitingStep();
    const token = (await createApproval(db, stepRunId, inAnHour(), ownerId))!.token;
    expect(await recordDecision(db, token, "rejected", { id: owner.id, email: owner.email })).toBe(runId);
  });

  it("lists pending non-test approvals once per step and enforces named-approver rules in decideApprovalById", async () => {
    const owner = (await db.select().from(users).where(eq(users.id, ownerId)))[0]!;
    const approver = await member("approver", ownerId);
    const operator = await member("operator", ownerId);
    const otherOwner = await member("owner");

    const { runId, stepRunId } = await waitingStep();
    await createApproval(db, stepRunId, inAnHour(), approver.id);
    // Second link on the same waiting step must still appear once in the Inbox list.
    await createApproval(db, stepRunId, inAnHour(), approver.id);

    const list = await listPendingApprovals(db, ownerId);
    const matches = list.filter((item) => item.runId === runId);
    expect(matches).toHaveLength(1);
    const item = matches[0]!;
    expect(item.approverId).toBe(approver.id);
    expect(item.approverEmail).toBe(approver.email);

    // Other workspace cannot see or decide it.
    expect(await listPendingApprovals(db, otherOwner.id)).toHaveLength(0);
    expect(await decideApprovalById(db, { workspaceId: otherOwner.id, approvalId: item.id, decision: "approved", actor: otherOwner })).toEqual({
      ok: false,
      reason: "not_found",
    });

    // Wrong member (even owner or operator when named to a specific approver) is forbidden.
    expect(await decideApprovalById(db, { workspaceId: ownerId, approvalId: item.id, decision: "approved", actor: { id: owner.id, email: owner.email } })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await decideApprovalById(db, { workspaceId: ownerId, approvalId: item.id, decision: "approved", actor: operator })).toEqual({
      ok: false,
      reason: "forbidden",
    });

    // Concurrent clicks by the named approver settle exactly once.
    const results = await Promise.all([
      decideApprovalById(db, { workspaceId: ownerId, approvalId: item.id, decision: "approved", actor: approver }),
      decideApprovalById(db, { workspaceId: ownerId, approvalId: item.id, decision: "rejected", actor: approver }),
    ]);
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, runId }]);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "gone" }]);

    // Once decided, neither sibling nor step remains pending.
    expect((await listPendingApprovals(db, ownerId)).some((x) => x.runId === runId)).toBe(false);
  });
});
