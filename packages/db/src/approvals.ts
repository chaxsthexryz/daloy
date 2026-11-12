import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { approvals, runs, stepRuns } from "./schema";

type AnyDb = NodePgDatabase<Record<string, unknown>>;
type Writer = Pick<AnyDb, "select" | "update">;

export type ApprovalDecision = "approved" | "rejected";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Makes the link token for a waiting approval step: 32 random bytes, base64url. Only the SHA-256 is stored,
 * so a database leak gives no working links (decision 0009). An earlier link for the same step run is deleted,
 * so a step attempt that runs again after a crash leaves exactly one live link.
 */
export async function createApproval(db: AnyDb, stepRunId: string, expiresAt: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.delete(approvals).where(eq(approvals.stepRunId, stepRunId));
    await tx.insert(approvals).values({ stepRunId, tokenHash: hashToken(token), expiresAt });
  });
  return token;
}

const live = (token: string) => and(eq(approvals.tokenHash, hashToken(token)), isNull(approvals.usedAt), gt(approvals.expiresAt, sql`now()`));

/** The waiting step's stored input (it holds the message to show), or null when the link is unknown, used or expired. */
export async function findPendingApproval(db: AnyDb, token: string): Promise<{ input: unknown } | null> {
  const [row] = await db.select({ input: stepRuns.input }).from(approvals).innerJoin(stepRuns, eq(stepRuns.id, approvals.stepRunId)).where(live(token));
  return row ?? null;
}

/**
 * Uses the link: one guarded UPDATE, so a replayed or expired link changes nothing. Then wakes the waiting run.
 * Returns the run id for the caller to enqueue, or null when the link was not live.
 */
export async function recordDecision(db: AnyDb, token: string, decision: ApprovalDecision): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [used] = await tx.update(approvals).set({ usedAt: sql`now()`, decision }).where(live(token)).returning({ stepRunId: approvals.stepRunId });
    if (!used) return null;
    const [step] = await tx.select({ runId: stepRuns.runId }).from(stepRuns).where(eq(stepRuns.id, used.stepRunId));
    await tx.update(runs).set({ nextAttemptAt: sql`now()` }).where(and(eq(runs.id, step!.runId), eq(runs.state, "waiting")));
    return step!.runId;
  });
}

/**
 * Called by the worker when the waiting approval step wakes up. If nobody answered, it uses the link up as "timeout".
 * The UPDATE takes the row lock, so it and recordDecision cannot both win. Returns the branch to take.
 */
export async function claimTimeout(w: Writer, stepRunId: string): Promise<ApprovalDecision | "timeout"> {
  const claimed = await w
    .update(approvals)
    .set({ usedAt: sql`now()`, decision: "timeout" })
    .where(and(eq(approvals.stepRunId, stepRunId), isNull(approvals.usedAt)))
    .returning({ id: approvals.id });
  if (claimed.length > 0) return "timeout";
  const [row] = await w.select({ decision: approvals.decision }).from(approvals).where(eq(approvals.stepRunId, stepRunId));
  return (row?.decision as ApprovalDecision | "timeout" | undefined) ?? "timeout";
}
