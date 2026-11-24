import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "./index";
import { bookings, conversations, deliveries, paymentClaims, paymentDues, runs, users } from "./schema";

/** A failed message older than this is no longer news for a morning digest. */
const FAILED_WITHIN_DAYS = 7;

/**
 * What a workspace owner's morning digest counts (R5, decision 0092): receipts waiting for a decision, orders still
 * unpaid, and messages to customers (SMS or Messenger) that failed or may not have gone out. Test runs and other
 * workspaces never count.
 */
export async function digestCounts(db: Db, workspaceId: string, now = new Date()) {
  const [receipts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentClaims)
    .innerJoin(paymentDues, eq(paymentDues.id, paymentClaims.dueId))
    .where(and(eq(paymentClaims.userId, workspaceId), eq(paymentDues.test, false), inArray(paymentClaims.status, ["open", "clarify"])));
  const [unpaid] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentDues)
    .where(and(eq(paymentDues.userId, workspaceId), eq(paymentDues.test, false), eq(paymentDues.status, "pending")));
  const [failedReplies] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deliveries)
    .innerJoin(runs, eq(runs.id, deliveries.runId))
    .where(
      and(
        eq(deliveries.userId, workspaceId),
        eq(runs.test, false),
        inArray(deliveries.provider, ["unisms", "meta_messenger"]),
        inArray(deliveries.state, ["failed", "needs_review"]),
        gte(deliveries.createdAt, new Date(now.getTime() - FAILED_WITHIN_DAYS * 86_400_000)),
      ),
    );
  const [waiting] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(conversations)
    .where(and(eq(conversations.userId, workspaceId), eq(conversations.status, "staff"), or(isNull(conversations.staffUntil), sql`${conversations.staffUntil} > ${now.toISOString()}::timestamptz`)));
  return { receipts: receipts!.n, unpaid: unpaid!.n, failedReplies: failedReplies!.n, conversationsWaiting: waiting!.n };
}

/** The first millisecond of a Manila calendar day (YYYY-MM-DD), as an instant. */
const manilaStart = (day: string) => new Date(`${day}T00:00:00+08:00`);

/**
 * Confirmed and refunded payments whose confirmation fell on a Manila day from `from` to `to`, both included, oldest
 * first (R5, decision 0092). Test payments and other workspaces never appear. Money stays in centavos here; the
 * caller formats it.
 */
export async function paymentsExport(db: Db, workspaceId: string, range: { from: string; to: string }) {
  const end = new Date(manilaStart(range.to).getTime() + 86_400_000);
  const by = sql<string | null>`(select ${users.email} from ${users} where ${users.id} = ${paymentDues.confirmedBy})`;
  const transferRef = sql<string | null>`(select ${paymentClaims.transferRef} from ${paymentClaims} where ${paymentClaims.id} = ${paymentDues.confirmedClaimId})`;
  return db
    .select({ confirmedAt: paymentDues.confirmedAt, reference: paymentDues.reference, booking: bookings.reference, kind: paymentDues.kind, amount: paymentDues.amountCentavos, total: paymentDues.totalCentavos, status: paymentDues.status, source: paymentDues.confirmedSource, transferRef, confirmedBy: by })
    .from(paymentDues)
    .leftJoin(bookings, eq(bookings.id, paymentDues.bookingId))
    .where(and(eq(paymentDues.userId, workspaceId), eq(paymentDues.test, false), inArray(paymentDues.status, ["confirmed", "refunded"]), gte(paymentDues.confirmedAt, manilaStart(range.from)), lt(paymentDues.confirmedAt, end)))
    .orderBy(asc(paymentDues.confirmedAt), asc(paymentDues.reference));
}
