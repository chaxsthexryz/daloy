import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { approvals, runs, stepRuns, workflows, workflowVersions } from "./schema";

type AnyDb = NodePgDatabase<Record<string, unknown>>;
type Writer = Pick<AnyDb, "select" | "update">;

export type ApprovalDecision = "approved" | "rejected";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/*
 * One approval step of one run is one decision, however many links it sent (decision 0009). A retry after a failed
 * send, or a re-run after a crash, is a new step run with its own link, and every earlier link stays usable: the
 * first answer through any of them decides for all, and they all stop working together. Every write here takes the
 * run's row lock first, so link creation, answers and the timeout are serialised per run, always in the same order.
 */
async function stepOf(w: Writer, stepRunId: string) {
  const [row] = await w.select({ runId: stepRuns.runId, stepId: stepRuns.stepId }).from(stepRuns).where(eq(stepRuns.id, stepRunId));
  if (!row) throw new Error(`step run ${stepRunId} not found`);
  return row;
}
const lockRun = (w: Writer, runId: string) => w.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for("update");
/** Every link of the same approval step in the same run, whichever attempt sent it. */
const sameStep = (runId: string, stepId: string) => sql`${approvals.stepRunId} in (select id from step_runs where run_id = ${runId} and step_id = ${stepId})`;

/**
 * Makes the link token for a waiting approval step: 32 random bytes, base64url. Only the SHA-256 is stored, so a
 * database leak gives no working links. Returns null when an earlier link of this step was already answered: the
 * caller takes that decision and asks nobody again. A later link keeps the first link's deadline, so a retry never
 * extends the time the approver has.
 */
export async function createApproval(db: AnyDb, stepRunId: string, expiresAt: Date, approverId?: string): Promise<{ token: string; expiresAt: Date } | null> {
  const token = randomBytes(32).toString("base64url");
  return db.transaction(async (tx) => {
    const { runId, stepId } = await stepOf(tx, stepRunId);
    await lockRun(tx, runId);
    const links = await tx.select({ usedAt: approvals.usedAt, expiresAt: approvals.expiresAt }).from(approvals).where(sameStep(runId, stepId));
    if (links.some((l) => l.usedAt)) return null;
    const deadline = links.reduce((d, l) => (l.expiresAt < d ? l.expiresAt : d), expiresAt);
    await tx.insert(approvals).values({ stepRunId, tokenHash: hashToken(token), expiresAt: deadline, approverId });
    return { token, expiresAt: deadline };
  });
}

const live = (token: string) => and(eq(approvals.tokenHash, hashToken(token)), isNull(approvals.usedAt), gt(approvals.expiresAt, sql`now()`));

/**
 * The waiting step's stored input (it holds the message to show) and the named approver (null for a link-holder
 * approval), or null when the link is unknown, used or expired.
 */
export async function findPendingApproval(db: Pick<AnyDb, "select">, token: string): Promise<{ input: unknown; approverId: string | null; workspaceId: string } | null> {
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
    const [link] = await tx
      .select({ runId: stepRuns.runId, stepId: stepRuns.stepId })
      .from(approvals)
      .innerJoin(stepRuns, eq(stepRuns.id, approvals.stepRunId))
      .where(eq(approvals.tokenHash, hashToken(token)));
    if (!link) return null;
    await lockRun(tx, link.runId);
    const decidedBy = by ? sql`case when ${approvals.approverId} is null then null else ${by.id}::uuid end` : null;
    const decidedByEmail = by ? sql`case when ${approvals.approverId} is null then null else ${by.email} end` : null;
    // Siblings are always answered together, so an unused clicked link means nobody has decided this step yet.
    const [used] = await tx
      .update(approvals)
      .set({ usedAt: sql`now()`, decision, decidedBy, decidedByEmail })
      .where(and(live(token), allowed(by)))
      .returning({ usedAt: approvals.usedAt, decidedBy: approvals.decidedBy, decidedByEmail: approvals.decidedByEmail });
    if (!used) return null;
    await tx
      .update(approvals)
      .set({ usedAt: used.usedAt, decision, decidedBy: used.decidedBy, decidedByEmail: used.decidedByEmail })
      .where(and(sameStep(link.runId, link.stepId), isNull(approvals.usedAt)));
    await tx.update(runs).set({ nextAttemptAt: sql`now()` }).where(and(eq(runs.id, link.runId), eq(runs.state, "waiting")));
    return link.runId;
  });
}

export type ApprovalOutcome = { branch: ApprovalDecision | "timeout"; decidedBy: string | null; decidedAt: string | null };
/** Nobody answered and the deadline has not passed: the step keeps waiting until pendingUntil. */
export type ApprovalPending = { branch: null; pendingUntil: Date; decidedBy: null; decidedAt: null };

/**
 * Called by the worker when the waiting approval step wakes up. Returns the recorded decision if anyone answered any
 * link of this step. Otherwise, once the deadline has passed, it uses every link up as "timeout"; before that it
 * returns pending, so an early wake-up never takes a branch. Call it inside a transaction: the run lock it takes must
 * last until its update, so it and recordDecision cannot both win.
 */
export async function claimTimeout(w: Writer, stepRunId: string): Promise<ApprovalOutcome | ApprovalPending> {
  const { runId, stepId } = await stepOf(w, stepRunId);
  await lockRun(w, runId);
  const links = await w
    .select({ decision: approvals.decision, decidedBy: approvals.decidedByEmail, usedAt: approvals.usedAt, expiresAt: approvals.expiresAt, expired: sql<boolean>`${approvals.expiresAt} <= now()` })
    .from(approvals)
    .where(sameStep(runId, stepId));
  const answered = links.find((l) => l.usedAt);
  if (answered) {
    return { branch: answered.decision as ApprovalDecision | "timeout", decidedBy: answered.decidedBy, decidedAt: answered.decidedBy ? answered.usedAt!.toISOString() : null };
  }
  const first = links.reduce<(typeof links)[number] | undefined>((a, l) => (!a || l.expiresAt < a.expiresAt ? l : a), undefined);
  if (first && !first.expired) return { branch: null, pendingUntil: first.expiresAt, decidedBy: null, decidedAt: null };
  await w.update(approvals).set({ usedAt: sql`now()`, decision: "timeout" }).where(and(sameStep(runId, stepId), isNull(approvals.usedAt)));
  return { branch: "timeout", decidedBy: null, decidedAt: null };
}
