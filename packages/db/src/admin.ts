import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./index";
import { adminActions, deliveries, runs, stepRuns, usageCounts, users, workflows, workflowVersions, workspaceMembers } from "./schema";
import { manilaDay, periodOf, type Plan } from "./usage";

/*
 * Platform admin queries (A1, decision 0122). These are the only queries in kymavo that read across workspaces, and only
 * AdminController calls them. They select named columns only: never a run's trigger payload, step input or output,
 * error text, delivery payloads, or anything from secrets and connections. Nothing here imports the secrets code.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Runs fn in a read-only transaction, so Postgres refuses any write on the admin read path. */
export function adminRead<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return fn(tx);
  });
}

const since = (days: number) => sql`now() - make_interval(days => ${days})`;
const counts = (createdAt: typeof users.createdAt) => ({
  total: sql<number>`count(*)::int`,
  new7: sql<number>`(count(*) filter (where ${createdAt} > ${since(7)}))::int`,
  new30: sql<number>`(count(*) filter (where ${createdAt} > ${since(30)}))::int`,
});
const isOwner = and(eq(workspaceMembers.userId, users.id), eq(workspaceMembers.role, "owner"));

/** Totals, cross-tenant usage and one row per workspace. */
export function adminOverview(db: Db, now = new Date()) {
  return adminRead(db, async (tx) => {
    const today = manilaDay(now);
    const [userCounts] = await tx.select(counts(users.createdAt)).from(users);
    const [ownerCounts] = await tx.select(counts(users.createdAt)).from(users).innerJoin(workspaceMembers, isOwner);
    const owners = await tx
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
        plan: users.plan,
        planStartedOn: users.planStartedOn,
        sharedMailDailyLimit: users.sharedMailDailyLimit,
        members: sql<number>`(select count(*)::int from ${workspaceMembers} m where m.workspace_id = ${users.id})`,
      })
      .from(users)
      .innerJoin(workspaceMembers, isOwner)
      .orderBy(desc(users.createdAt));
    // ponytail: aggregates every run on each load; add a date bound or a rollup table if runs reach the millions.
    const runRows = await tx
      .select({
        userId: workflows.userId,
        runs30: sql<number>`(count(*) filter (where ${runs.createdAt} > ${since(30)}))::int`,
        failed: sql<number>`(count(*) filter (where ${runs.state} = 'failed'))::int`,
        needsReview: sql<number>`(count(*) filter (where ${runs.state} = 'needs_review'))::int`,
      })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .groupBy(workflows.userId);
    const runStates = await tx.select({ state: runs.state, n: sql<number>`count(*)::int` }).from(runs).where(gt(runs.createdAt, since(30))).groupBy(runs.state);
    const deliveryStates = await tx.select({ state: deliveries.state, n: sql<number>`count(*)::int` }).from(deliveries).where(inArray(deliveries.state, ["failed", "needs_review"])).groupBy(deliveries.state);
    // A monthly cycle starts at most 31 days ago, so older periods can never be the current one.
    const cutoff = manilaDay(new Date(now.getTime() - 40 * 86_400_000));
    const usage = await tx.select({ userId: usageCounts.userId, kind: usageCounts.kind, period: usageCounts.period, used: usageCounts.used }).from(usageCounts).where(and(inArray(usageCounts.kind, ["ai", "sms"]), gte(usageCounts.period, cutoff)));
    const actions = await tx
      .select({ id: adminActions.id, adminEmail: adminActions.adminEmail, action: adminActions.action, workspaceId: adminActions.workspaceId, workspaceEmail: users.email, before: adminActions.before, after: adminActions.after, createdAt: adminActions.createdAt })
      .from(adminActions)
      .leftJoin(users, eq(users.id, adminActions.workspaceId))
      .orderBy(desc(adminActions.createdAt))
      .limit(50);

    const byUser = new Map(runRows.map((r) => [r.userId, r]));
    const used = (o: (typeof owners)[number], kind: "ai" | "sms") => usage.find((u) => u.userId === o.id && u.kind === kind && u.period === periodOf(kind, o.planStartedOn, today))?.used ?? 0;
    const rows = owners.map((o) => {
      const r = byUser.get(o.id);
      return { ...o, runs30: r?.runs30 ?? 0, failed: r?.failed ?? 0, needsReview: r?.needsReview ?? 0, ai: used(o, "ai"), sms: used(o, "sms") };
    });
    const sum = (k: "ai" | "sms" | "failed" | "needsReview") => rows.reduce((n, r) => n + r[k], 0);
    return {
      users: userCounts!,
      // ponytail: every workspace is summed, only the newest 200 are listed; add paging and search past that.
      workspaces: { ...ownerCounts!, rows: rows.slice(0, 200) },
      runs30: Object.fromEntries(runStates.map((s) => [s.state, s.n])),
      attention: {
        runsFailed: sum("failed"),
        runsNeedsReview: sum("needsReview"),
        deliveriesFailed: deliveryStates.find((d) => d.state === "failed")?.n ?? 0,
        deliveriesNeedsReview: deliveryStates.find((d) => d.state === "needs_review")?.n ?? 0,
      },
      usage: { ai: sum("ai"), sms: sum("sms") },
      actions,
    };
  });
}

/** The newest runs across every workspace: metadata and step counts by state only. */
export function adminRuns(db: Db, opts: { state?: (typeof runs.state.enumValues)[number]; limit: number }) {
  return adminRead(db, (tx) =>
    tx
      .select({
        id: runs.id,
        workspaceId: workflows.userId,
        email: users.email,
        workflow: workflows.name,
        version: workflowVersions.version,
        state: runs.state,
        test: runs.test,
        live: runs.live,
        createdAt: runs.createdAt,
        finishedAt: runs.finishedAt,
        hasError: sql<boolean>`${runs.error} is not null`,
        steps: sql<Record<string, number>>`coalesce((select jsonb_object_agg(s.state, s.n) from (select state, count(*)::int as n from ${stepRuns} where ${stepRuns.runId} = ${runs.id} group by state) s), '{}'::jsonb)`,
      })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .innerJoin(users, eq(users.id, workflows.userId))
      .where(opts.state ? eq(runs.state, opts.state) : undefined)
      .orderBy(desc(runs.createdAt))
      .limit(opts.limit),
  );
}

/**
 * Locks a workspace owner's row, applies the change and records it in admin_actions, in one transaction. Null when the
 * id is not a workspace owner (an unknown id, or a member's own account).
 */
async function change<K extends "plan" | "shared_mail", T extends Record<string, unknown>>(db: Db, adminEmail: string, workspaceId: string, action: K, read: (row: typeof users.$inferSelect) => T, next: (before: T) => T) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ user: users }).from(users).innerJoin(workspaceMembers, isOwner).where(eq(users.id, workspaceId)).for("update", { of: users });
    if (!row) return null;
    const before = read(row.user);
    const after = next(before);
    await tx.update(users).set(after).where(eq(users.id, workspaceId));
    await tx.insert(adminActions).values({ adminEmail, action, workspaceId, before, after });
    return after;
  });
}

/** Sets or removes a workspace's plan. A new plan with no start date starts today (Manila); removing it clears the date. */
export function setWorkspacePlan(db: Db, adminEmail: string, workspaceId: string, plan: Plan | null, startedOn?: string) {
  return change(db, adminEmail, workspaceId, "plan", (u) => ({ plan: u.plan, planStartedOn: u.planStartedOn }), (before) => ({
    plan,
    planStartedOn: plan === null ? null : (startedOn ?? (plan === before.plan ? before.planStartedOn : manilaDay())),
  }));
}

/** Approves a workspace for the shared mail server with a daily recipient limit, or withdraws it with null (decision 0024). */
export function setWorkspaceSharedMail(db: Db, adminEmail: string, workspaceId: string, dailyLimit: number | null) {
  return change(db, adminEmail, workspaceId, "shared_mail", (u) => ({ sharedMailDailyLimit: u.sharedMailDailyLimit }), () => ({ sharedMailDailyLimit: dailyLimit }));
}
