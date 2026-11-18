import { StepError } from "@daloy/engine";
import { and, eq, exists, sql } from "drizzle-orm";
import type { Db } from "./index";
import { usageClaims, usageCounts, users, workflows, workflowVersions } from "./schema";

/** What each plan allows. ai counts per monthly cycle; email recipients, http requests and uploaded files per Manila day. */
export const PLANS = {
  pilot: { label: "Pilot", automations: 1, ai: 100, email: 100, http: 200, upload: 100, minScheduleMinutes: 60 },
  business: { label: "Business", automations: 5, ai: 500, email: 300, http: 1000, upload: 500, minScheduleMinutes: 15 },
  business_plus: { label: "Business Plus", automations: 15, ai: 2000, email: 1000, http: 5000, upload: 2000, minScheduleMinutes: 5 },
} as const;
export type Plan = keyof typeof PLANS;
/** Files a hosted form takes a day when the operator has set no plan. Other kinds stay unlimited without a plan. */
export const UPLOADS_WITHOUT_PLAN = 20;
export type UsageKind = "ai" | "email" | "http" | "upload";
const limitFor = (plan: Plan | null, kind: UsageKind) => (plan ? PLANS[plan][kind] : kind === "upload" ? UPLOADS_WITHOUT_PLAN : null);

/** Thrown when a plan's limit is reached. The API maps it to HTTP 429. */
export class QuotaError extends StepError {
  override name = "QuotaError";
  constructor(message: string, readonly kind: UsageKind) {
    super(message, false, { outcome: "not_sent" });
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const parts = (d: string) => d.split("-").map(Number) as [number, number, number];
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (d: string) => `${parts(d)[2]} ${MONTHS[parts(d)[1] - 1]}`;

/** The start (day clamped to the month's length) of the cycle k months after startedOn. */
function cycle(startedOn: string, k: number) {
  const [y, m, d] = parts(startedOn);
  const index = m - 1 + k;
  const year = y + Math.floor(index / 12);
  const month = (index % 12) + 1;
  return iso(year, month, Math.min(d, new Date(Date.UTC(year, month, 0)).getUTCDate()));
}
const monthsSince = (startedOn: string, today: string) => {
  const [y, m] = parts(startedOn);
  const [ty, tm] = parts(today);
  const k = (ty - y) * 12 + (tm - m);
  return k < 0 ? 0 : cycle(startedOn, k) > today ? k - 1 : k;
};

/** Start date of the monthly cycle holding today. A start in the future is its own first cycle. */
export const cycleStart = (startedOn: string, today: string) => cycle(startedOn, monthsSince(startedOn, today));
export const nextCycleStart = (startedOn: string, today: string) => cycle(startedOn, monthsSince(startedOn, today) + 1);

/** The calendar date in Manila (UTC+8, no daylight saving) as YYYY-MM-DD. */
export const manilaDay = (now = new Date()) => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const tomorrow = (day: string) => new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);

export async function planOf(db: Db, userId: string) {
  const [row] = await db.select({ plan: users.plan, startedOn: users.planStartedOn }).from(users).where(eq(users.id, userId));
  return { plan: (row?.plan ?? null) as Plan | null, startedOn: row?.startedOn ?? null };
}

/** The AI cycle's anchor: the plan start, or the first of the Manila month when there is none. */
const anchor = (startedOn: string | null, today: string) => startedOn ?? `${today.slice(0, 8)}01`;
const periodOf = (kind: UsageKind, startedOn: string | null, today: string) => (kind === "ai" ? cycleStart(anchor(startedOn, today), today) : today);
const resetsOn = (kind: UsageKind, startedOn: string | null, today: string) => (kind === "ai" ? nextCycleStart(anchor(startedOn, today), today) : tomorrow(today));

function quotaMessage(kind: UsageKind, limit: number, reset: string) {
  if (kind === "ai") return `This office used its ${limit} AI actions for this month. They come back on ${longDate(reset)}, Manila time. To get more now, ask Daloy to move you to a larger plan.`;
  if (kind === "email") return `This office reached today's limit of ${limit} email recipients. Sending starts again tomorrow, Manila time. Press Retry on this run then.`;
  if (kind === "upload") return `This office reached today's limit of ${limit} files. Forms take files again tomorrow, Manila time.`;
  return `This office reached today's limit of ${limit} web requests. They start again tomorrow, Manila time. Press Retry on this run then.`;
}

/**
 * Counts n units of work before it is done. One transaction: the key (when given) is recorded so a retried step is not
 * counted twice, then one upsert under the row lock holds the limit exactly across API and worker processes. Over the
 * limit it throws a QuotaError and rolls the key back. A workspace with no plan is counted without a limit, except for uploads (UPLOADS_WITHOUT_PLAN).
 */
export async function claimUsage(db: Db, userId: string, kind: UsageKind, opts: { n?: number; key?: string; now?: Date } = {}) {
  const n = opts.n ?? 1;
  const today = manilaDay(opts.now);
  const { plan, startedOn } = await planOf(db, userId);
  const limit = limitFor(plan, kind);
  const period = periodOf(kind, startedOn, today);
  const over = () => new QuotaError(quotaMessage(kind, limit!, resetsOn(kind, startedOn, today)), kind);
  if (limit !== null && n > limit) throw over();
  await db.transaction(async (tx) => {
    if (opts.key !== undefined) {
      const fresh = await tx.insert(usageClaims).values({ userId, kind, key: opts.key }).onConflictDoNothing().returning({ key: usageClaims.key });
      if (fresh.length === 0) return;
    }
    const counted = await tx
      .insert(usageCounts)
      .values({ userId, kind, period, used: n })
      .onConflictDoUpdate({
        target: [usageCounts.userId, usageCounts.kind, usageCounts.period],
        set: { used: sql`${usageCounts.used} + ${n}` },
        ...(limit === null ? {} : { setWhere: sql`${usageCounts.used} + ${n} <= ${limit}` }),
      })
      .returning({ used: usageCounts.used });
    if (counted.length === 0) throw over();
  });
}

/** What the console shows: plan, limits, use so far and when each counter resets. */
export async function usageSummary(db: Db, userId: string, now = new Date()) {
  const today = manilaDay(now);
  const { plan, startedOn } = await planOf(db, userId);
  const limits = plan ? PLANS[plan] : null;
  const rows = await db.select().from(usageCounts).where(eq(usageCounts.userId, userId));
  const meter = (kind: UsageKind) => ({
    used: rows.find((r) => r.kind === kind && r.period === periodOf(kind, startedOn, today))?.used ?? 0,
    limit: limitFor(plan, kind),
    resetsOn: resetsOn(kind, startedOn, today),
  });
  const published = db.select({ one: sql`1` }).from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.published, true)));
  const [row] = await db.select({ live: sql<number>`count(*)::int` }).from(workflows).where(and(eq(workflows.userId, userId), exists(published)));
  return {
    plan,
    label: limits?.label ?? null,
    limits,
    ai: meter("ai"),
    email: meter("email"),
    http: meter("http"),
    upload: meter("upload"),
    automations: { live: row?.live ?? 0, limit: limits?.automations ?? null },
    minScheduleMinutes: limits?.minScheduleMinutes ?? null,
  };
}
