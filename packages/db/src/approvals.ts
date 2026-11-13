import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { approvals, runs, stepRuns, workflows, workflowVersions } from "./schema";

type AnyDb = NodePgDatabase<Record<string, unknown>>;
type Writer = Pick<AnyDb, "select" | "update">;

export type ApprovalDecision = "approved" | "rejected";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Makes the link token for a waiting approval step: 32 random bytes, base64url. Only the SHA-256 is stored,
 * so a database leak gives no working links (decision 0009). An earlier link for the same step run is deleted,
 * so a step attempt that runs again after a crash leaves exactly one live link.
 */
export async function createApproval(db: AnyDb, stepRunId: string, expiresAt: Date, approverId?: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.delete(approvals).where(eq(approvals.stepRunId, stepRunId));
    await tx.insert(approvals).values({ stepRunId, tokenHash: hashToken(token), expiresAt, approverId });
  });
  return token;
}

const live = (token: string) => and(eq(approvals.tokenHash, hashToken(token)), isNull(approvals.usedAt), gt(approvals.expiresAt, sql`now()`));

/**
 * The waiting step's stored input (it holds the message to show) and the named approver (null for a link-holder
 * approval), or null when the link is unknown, used or expired.
 */
export async function findPendingApproval(db: AnyDb, token: string): Promise<{ input: unknown; approverId: string | null; workspaceId: string } | null> {
  const [row] = await db
    .select({ input: stepRuns.input, approverId: approvals.approverId, workspaceId: workflows.userId })
    .from(approvals)
    .innerJoin(stepRuns, eq(stepRuns.id, approvals.stepRunId))
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(live(token));
  return row ?? null;
}

export type Actor = { id: string; email: string };

/**
 * Who may use the link. A link-holder approval (no approver_id): anyone. A named one: only the approver, signed in, who
 * at this moment is still a member of the run's workspace with a role that may approve (decision 0022). It sits in
 * the same UPDATE as the use itself, so removal, demotion, a move to another workspace, replay and concurrent clicks
 * are all settled by one statement under the row lock.
 */
function allowed(by: Actor | undefined): SQL {
  if (!by) return isNull(approvals.approverId);
  const named = and(
    eq(approvals.approverId, by.id),
    sql`exists (
      select 1 from step_runs s
      join runs r on r.id = s.run_id
      join workflow_versions v on v.id = r.workflow_version_id
      join workflows w on w.id = v.workflow_id
      join workspace_members m on m.workspace_id = w.user_id
      where s.id = "approvals"."step_run_id" and m.user_id = ${by.id} and m.role in ('owner', 'approver'))`,
  );
  return or(isNull(approvals.approverId), named)!;
}

/**
 * Uses the link: one guarded UPDATE, so a replayed, expired or (for a named approval) wrong-person answer changes
 * nothing. Then wakes the waiting run. Returns the run id for the caller to enqueue, or null when nothing was recorded.
 * `by` is the signed-in user; a named approval records them as the decider.
 */
export async function recordDecision(db: AnyDb, token: string, decision: ApprovalDecision, by?: Actor): Promise<string | null> {
  return db.transaction(async (tx) => {
    const decidedBy = by ? sql`case when ${approvals.approverId} is null then null else ${by.id}::uuid end` : null;
    const decidedByEmail = by ? sql`case when ${approvals.approverId} is null then null else ${by.email} end` : null;
    const [used] = await tx
      .update(approvals)
      .set({ usedAt: sql`now()`, decision, decidedBy, decidedByEmail })
      .where(and(live(token), allowed(by)))
      .returning({ stepRunId: approvals.stepRunId });
    if (!used) return null;
    const [step] = await tx.select({ runId: stepRuns.runId }).from(stepRuns).where(eq(stepRuns.id, used.stepRunId));
    await tx.update(runs).set({ nextAttemptAt: sql`now()` }).where(and(eq(runs.id, step!.runId), eq(runs.state, "waiting")));
    return step!.runId;
  });
}

export type ApprovalOutcome = { branch: ApprovalDecision | "timeout"; decidedBy: string | null; decidedAt: string | null };

/**
 * Called by the worker when the waiting approval step wakes up. If nobody answered, it uses the link up as "timeout".
 * The UPDATE takes the row lock, so it and recordDecision cannot both win. Returns the branch to take and, for a
 * named approval, who decided and when, which the step keeps as its output.
 */
export async function claimTimeout(w: Writer, stepRunId: string): Promise<ApprovalOutcome> {
  await w
    .update(approvals)
    .set({ usedAt: sql`now()`, decision: "timeout" })
    .where(and(eq(approvals.stepRunId, stepRunId), isNull(approvals.usedAt)));
  const [row] = await w
    .select({ decision: approvals.decision, decidedBy: approvals.decidedByEmail, usedAt: approvals.usedAt })
    .from(approvals)
    .where(eq(approvals.stepRunId, stepRunId));
  return {
    branch: (row?.decision as ApprovalDecision | "timeout" | undefined) ?? "timeout",
    decidedBy: row?.decidedBy ?? null,
    decidedAt: row?.decidedBy ? row.usedAt!.toISOString() : null,
  };
}
