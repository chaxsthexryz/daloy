import { sendAs, users, workflows, workflowVersions, workspaceLanguage, type Db, type MailDeps } from "@daloy/db";
import { missedScheduleEmail } from "@daloy/engine";
import { CronExpressionParser } from "cron-parser";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

/** A fire is only overdue once this long has passed: pg-boss checks cron about once a minute and the run takes a moment to be created. */
export const GRACE_MS = 15 * 60_000;

/** The latest cron time (UTC, as pg-boss schedules it) that is at least the grace period old, or null for a cron that does not parse. */
export function lastDue(cron: string, now: Date): Date | null {
  try {
    return CronExpressionParser.parse(cron, { tz: "UTC", currentDate: new Date(now.getTime() - GRACE_MS + 1) }).prev().toDate();
  } catch {
    return null;
  }
}

export type WatchdogDeps = { db: Db; mail: MailDeps; secretsKey: Buffer; publicUrl?: string; now?: Date };

/**
 * Compares each published schedule automation with its runs. One whose latest due fire has no scheduled run (a run whose
 * payload carries firedAt, so a manual run does not hide a broken schedule) is flagged and its owner emailed, at most
 * once a day. The flag clears when the fire is covered again or the automation is no longer a live schedule.
 * It only reports: replaying a missed run could send the same email or message twice.
 */
export async function checkSchedules(deps: WatchdogDeps) {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const live = await db
    .select({ id: workflows.id, name: workflows.name, userId: workflows.userId, flagged: workflows.scheduleMissedAt, definition: workflowVersions.definition, publishedAt: workflowVersions.createdAt, resumedAt: workflows.resumedAt })
    .from(workflows)
    .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.published, true)))
    // A paused automation starts nothing on purpose, so it is not watched (N11b); the clean-up below clears an old flag.
    .where(isNull(workflows.pausedAt));
  const scheduled = new Set<string>();
  for (const w of live) {
    const trigger = (w.definition as { trigger?: { type?: string; config?: { cron?: unknown } } }).trigger;
    if (trigger?.type !== "schedule" || typeof trigger.config?.cron !== "string") continue;
    scheduled.add(w.id);
    const due = lastDue(trigger.config.cron, now);
    // A version published after the due time was never expected to run for it, nor was a fire the pause skipped before the resume.
    const expected = due !== null && due > w.publishedAt && (!w.resumedAt || due > w.resumedAt);
    const covered = !expected || (await hasScheduledRun(db, w.id, due!));
    if (covered) {
      if (w.flagged) await db.update(workflows).set({ scheduleMissedAt: null }).where(eq(workflows.id, w.id));
      continue;
    }
    if (!w.flagged) await db.update(workflows).set({ scheduleMissedAt: now }).where(and(eq(workflows.id, w.id), isNull(workflows.scheduleMissedAt)));
    await alertOwner(deps, w, now);
  }
  // Turned off, paused, or no longer on a schedule: nothing is expected, so nothing is missed.
  const stale = (await db.select({ id: workflows.id }).from(workflows).where(isNotNull(workflows.scheduleMissedAt))).filter((w) => !scheduled.has(w.id));
  for (const w of stale) await db.update(workflows).set({ scheduleMissedAt: null }).where(eq(workflows.id, w.id));
}

async function hasScheduledRun(db: Db, workflowId: string, since: Date) {
  const found = await db.execute(sql`
    select 1 from runs r join workflow_versions v on v.id = r.workflow_version_id
    where v.workflow_id = ${workflowId} and r.test = false and r.trigger_payload ? 'firedAt' and r.created_at >= ${since.toISOString()}::timestamptz
    limit 1`);
  return found.rows.length > 0;
}

/** One email per automation per day. The conditional UPDATE decides which worker sends; a failed send gives the claim back. */
async function alertOwner(deps: WatchdogDeps, w: { id: string; name: string; userId: string }, now: Date) {
  const { db } = deps;
  const [before] = await db.select({ at: workflows.scheduleAlertAt }).from(workflows).where(eq(workflows.id, w.id));
  const claimed = await db
    .update(workflows)
    .set({ scheduleAlertAt: now })
    .where(and(eq(workflows.id, w.id), or(isNull(workflows.scheduleAlertAt), lt(workflows.scheduleAlertAt, new Date(now.getTime() - 24 * 3600_000)))))
    .returning({ id: workflows.id });
  if (claimed.length === 0) return;
  try {
    const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, w.userId));
    const language = await workspaceLanguage(db, w.userId);
    const { subject, text } = missedScheduleEmail(w.name, deps.publicUrl ? `${deps.publicUrl}/#/w/${w.id}` : undefined, language);
    await sendAs(db, deps.secretsKey, deps.mail, w.userId, { to: owner!.email, subject, text }, `schedule-missed:${w.id}:${now.toISOString().slice(0, 10)}`);
  } catch (err) {
    await db.update(workflows).set({ scheduleAlertAt: before?.at ?? null }).where(eq(workflows.id, w.id));
    console.error("watchdog: owner email failed", w.id, err instanceof Error ? err.message : err);
  }
}
