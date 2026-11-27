import { randomBytes } from "node:crypto";
import { fileType } from "@daloy/engine";
import { and, asc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "./index";
import { queueDelivery, retryDelivery } from "./deliveries";
import { normalizeReceiptRef, type MetaChannel } from "./meta";
import { pesosToCentavos } from "./paymongo";
import { claimUsageInTx } from "./usage";
import { bookingResults, bookings, conversations, deliveries, paymentClaims, paymentDues, paymentHistory, payments, paymentSettings, receiptReferences, users, workspaceMembers, type ClaimFlag, type Role } from "./schema";

/**
 * The two payment paths of R3 (decisions 0088 and 0089). A due is what a customer owes on one order or booking. It is
 * confirmed by exactly one of: a reviewer's decision on a claim, or a PayMongo checkout event that matches workspace,
 * checkout, order, currency and amount. Every change locks the due row first, so a reviewer and a webhook take turns,
 * and the confirmation reply is a delivery keyed (run, "<step>#confirmed"), so it can be queued only once.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Due = typeof paymentDues.$inferSelect;
export type Claim = typeof paymentClaims.$inferSelect;

export class DueTakenError extends Error {
  constructor(reference: string, kind: string) {
    super(`Order ${reference} already has an open ${kind} payment, so a second one was not made.`);
  }
}

const CONFIRMED_STEP = (d: Due) => `${d.stepId}#confirmed`;
const now = sql`clock_timestamp()`;

async function log(tx: Tx, d: Due, event: string, source: "transfer" | "checkout" | "staff" | "workflow", o: { actorId?: string | null; claimId?: string | null; detail?: Record<string, string | number | boolean | null> } = {}) {
  await tx.insert(paymentHistory).values({ userId: d.userId, dueId: d.id, event, source, actorId: o.actorId ?? null, claimId: o.claimId ?? null, detail: o.detail ?? {}, at: now as unknown as Date });
}

const lockDue = async (tx: Tx, where: SQL | undefined) => (await tx.select().from(paymentDues).where(where).for("update"))[0];

/** Queues one message to the customer on the due's reply channel. Test dues message nobody. */
async function message(tx: Tx, d: Due, stepId: string, text: string) {
  if (d.test || !d.replyChannel || !d.replyTo) return undefined;
  const sms = d.replyChannel === "sms";
  return queueDelivery(tx as unknown as Db, {
    userId: d.userId,
    runId: d.runId,
    stepId,
    provider: sms ? "unisms" : "meta_messenger",
    reference: d.reference,
    payload: sms ? { to: d.replyTo, message: text } : { recipientId: d.replyTo, channel: "messenger", text },
  });
}

export type NewDue = {
  userId: string;
  test: boolean;
  workflowId: string | null;
  runId: string;
  stepId: string;
  reference: string;
  kind: Due["kind"];
  amountCentavos: number;
  totalCentavos?: number | null;
  bookingId?: string | null;
  reviewerId?: string | null;
  replyChannel?: "sms" | "messenger" | null;
  replyTo?: string | null;
  replyText?: string | null;
  /** C6 (decision 0121): conversation whose open_due_id points to this due until confirmed or expired. */
  conversationId?: string | null;
};

/** One due per run and step: the step running again gets the first one back. A second open due of the same kind for the same order is refused. */
export async function createDue(db: Db, v: NewDue): Promise<Due> {
  const { conversationId, ...dueValues } = v;
  const own = and(eq(paymentDues.runId, v.runId), eq(paymentDues.stepId, v.stepId));
  const [existing] = await db.select().from(paymentDues).where(own);
  if (existing) return existing;
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(paymentDues)
        .values({ ...dueValues, token: randomBytes(32).toString("base64url") })
        .onConflictDoNothing({ target: [paymentDues.runId, paymentDues.stepId] })
        .returning();
      if (!row) return (await tx.select().from(paymentDues).where(own))[0]!;
      if (!row.test) {
        if (conversationId) {
          await tx
            .update(conversations)
            .set({ openDueId: row.id })
            .where(and(eq(conversations.id, conversationId), eq(conversations.userId, row.userId)));
        } else if (row.replyChannel === "messenger" && row.replyTo) {
          await tx
            .update(conversations)
            .set({ openDueId: row.id })
            .where(and(eq(conversations.userId, row.userId), eq(conversations.channel, "messenger"), eq(conversations.externalId, row.replyTo)));
        }
      }
      await log(tx, row, "requested", "workflow", { detail: { kind: row.kind, amount: row.amountCentavos } });
      return row;
    });
  } catch (err) {
    if ((err as { constraint?: string; cause?: { constraint?: string } }).constraint === "payment_dues_open_order" || (err as { cause?: { constraint?: string } }).cause?.constraint === "payment_dues_open_order") throw new DueTakenError(v.reference, v.kind);
    throw err;
  }
}

export const dueForStep = async (db: Db, runId: string, stepId: string): Promise<Due | undefined> => (await db.select().from(paymentDues).where(and(eq(paymentDues.runId, runId), eq(paymentDues.stepId, stepId))))[0];
export const dueByToken = async (db: Db, token: string): Promise<Due | undefined> => (await db.select().from(paymentDues).where(eq(paymentDues.token, token)))[0];

const READABLE = new Set(["jpeg", "png", "webp", "heic"]);

/** How many references one order can have waiting for the seller at once, so one pay link cannot flood Receipts to review. */
export const OPEN_CLAIMS_PER_DUE = 5;

export class TooManyClaimsError extends Error {
  constructor() {
    super(`This order already has ${OPEN_CLAIMS_PER_DUE} references waiting for the seller.`);
  }
}

/** Shared review-flag pipeline for both pay-page submissions and DM receipt photos (C6, decision 0121). */
async function evaluateTransferClaim(
  tx: Tx,
  d: Due,
  c: { normalizedRef: string | null; submittedCentavos?: number | null; image?: { bytes: Buffer } },
) {
  const flags: ClaimFlag[] = [];
  if (c.normalizedRef) {
    const [used] = await tx.select({ id: paymentClaims.id }).from(paymentClaims).where(and(eq(paymentClaims.userId, d.userId), eq(paymentClaims.normalizedRef, c.normalizedRef))).limit(1);
    const [seen] = used ? [used] : await tx.select({ id: receiptReferences.firstRunId }).from(receiptReferences).where(and(eq(receiptReferences.userId, d.userId), eq(receiptReferences.normalizedRef, c.normalizedRef)));
    if (used || seen) flags.push("duplicate_reference");
  }
  if (c.submittedCentavos != null && c.submittedCentavos !== d.amountCentavos) flags.push("amount_mismatch");
  const kind = c.image ? fileType(c.image.bytes) : null;
  const readable = kind !== null && READABLE.has(kind);
  if (c.image && !readable) flags.push("unreadable_upload");
  if (d.status === "confirmed" || d.status === "refunded") flags.push("already_confirmed");
  if (d.status === "cancelled") flags.push("late_payment");
  return { flags, kind, readable };
}

const isPhPhoneDigits = (digits: string) => /^(?:09|639)\d{9}$/.test(digits);
const LABELLED_REF_RE = /(?:\bref(?:erence)?(?:\s*(?:no\.?|num(?:ber)?|#))?|\btxn(?:\s*id)?|\btrace(?:\s*no\.?)?)\s*[:#.-]?\s*((?:\d+(?:[\s-]\d+)+)|[A-Za-z0-9][A-Za-z0-9-]{4,62}[A-Za-z0-9])/i;
const STANDALONE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{4,62}[A-Za-z0-9]$/;
const GROUPED_DIGITS_RE = /^\d+(?:[\s-]\d+)+$/;
const EMBEDDED_DIGITS_RE = /(?<![A-Za-z0-9+])\d+(?:[\s-]\d+)*(?![A-Za-z0-9])/g;

/** Extracts a GCash or bank transfer reference number from a DM caption, avoiding phone numbers and plain prose. */
export function extractDmReceiptRef(text: string): string | null {
  const s = text.trim();
  if (!s) return null;
  const check = (raw: string, allowPhoneLike = false) => {
    const candidate = raw.trim().slice(0, 64);
    if (!/\d/.test(candidate)) return null;
    const norm = normalizeReceiptRef(candidate);
    if (!norm) return null;
    if (!allowPhoneLike && /^\d+$/.test(norm) && isPhPhoneDigits(norm)) return null;
    return candidate;
  };
  const labelled = LABELLED_REF_RE.exec(s);
  if (labelled?.[1]) {
    const found = check(labelled[1], true);
    if (found) return found;
  }
  if (STANDALONE_TOKEN_RE.test(s) || GROUPED_DIGITS_RE.test(s)) {
    const found = check(s);
    if (found) return found;
  }
  for (const m of s.matchAll(EMBEDDED_DIGITS_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 24 && !isPhPhoneDigits(digits)) {
      const found = check(m[0]);
      if (found) return found;
    }
  }
  return null;
}

const PREFIX_AMOUNT_RE = /(?:\bPHP|₱|\bP(?=\s*\d))\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b/i;
const SUFFIX_AMOUNT_RE = /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:pesos?|php)\b/i;

/** Extracts an explicit peso amount (PHP, ₱, P or pesos) from a DM caption as integer centavos, or null. */
export function extractDmReceiptAmount(text: string): number | null {
  const m = PREFIX_AMOUNT_RE.exec(text) ?? SUFFIX_AMOUNT_RE.exec(text);
  if (!m?.[1]) return null;
  const whole = m[1].replaceAll(",", "");
  const formatted = m[2] ? `${whole}.${m[2]}` : whole;
  try {
    return pesosToCentavos(formatted);
  } catch {
    return null;
  }
}

/** The guest's open (pending, live) payment due id for this conversation, or null. */
export async function openDueForGuest(db: Db, userId: string, channel: MetaChannel | "whatsapp", externalId: string): Promise<string | null> {
  const [row] = await db
    .select({ dueId: paymentDues.id })
    .from(conversations)
    .innerJoin(paymentDues, eq(paymentDues.id, conversations.openDueId))
    .where(and(eq(conversations.userId, userId), eq(conversations.channel, channel), eq(conversations.externalId, externalId), eq(paymentDues.userId, userId), eq(paymentDues.status, "pending"), eq(paymentDues.test, false)))
    .limit(1);
  return row?.dueId ?? null;
}

/** An existing DM receipt claim recorded for this Meta message id in the workspace, if any. */
export async function dmClaimByMid(db: Db, userId: string, sourceMid: string): Promise<Claim | undefined> {
  const [row] = await db
    .select()
    .from(paymentClaims)
    .where(and(eq(paymentClaims.userId, userId), eq(paymentClaims.sourceMid, sourceMid)))
    .limit(1);
  return row;
}

/**
 * A customer's "I paid" for the due behind a pay page token. It never confirms anything: it puts the order in review,
 * flagged when the transfer reference was used before in this workspace, the amount differs, or the upload is not an
 * image. An unreadable upload is not stored. The same reference sent twice for the same order is one claim.
 * A stored image spends one upload of the workspace in the same transaction, after the repeat check, so a repeat or an
 * unreadable file costs nothing (review of 22 November, M2). Throws QuotaError or TooManyClaimsError and stores nothing.
 */
export async function submitTransferClaim(db: Db, token: string, c: { transferRef: string; submittedCentavos?: number | null; image?: { bytes: Buffer } }): Promise<Claim | undefined> {
  return db.transaction(async (tx) => {
    const d = await lockDue(tx, eq(paymentDues.token, token));
    if (!d) return undefined;
    const transferRef = c.transferRef.trim();
    const normalizedRef = transferRef.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    const [same] = await tx
      .select()
      .from(paymentClaims)
      .where(and(eq(paymentClaims.dueId, d.id), eq(paymentClaims.normalizedRef, normalizedRef), inArray(paymentClaims.status, ["open", "clarify"])));
    if (same) return same;
    const [waiting] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(paymentClaims)
      .where(and(eq(paymentClaims.dueId, d.id), eq(paymentClaims.channel, "transfer"), inArray(paymentClaims.status, ["open", "clarify"])));
    if (waiting!.n >= OPEN_CLAIMS_PER_DUE) throw new TooManyClaimsError();

    const { flags, kind, readable } = await evaluateTransferClaim(tx, d, { normalizedRef: normalizeReceiptRef(transferRef), submittedCentavos: c.submittedCentavos, image: c.image });
    if (readable) await claimUsageInTx(tx, d.userId, "upload");

    const [claim] = await tx
      .insert(paymentClaims)
      .values({
        userId: d.userId,
        dueId: d.id,
        channel: "transfer",
        transferRef,
        normalizedRef,
        submittedCentavos: c.submittedCentavos ?? null,
        flags,
        ...(readable && c.image ? { image: c.image.bytes, imageType: kind as "jpeg", imageSize: c.image.bytes.length } : {}),
      })
      .returning();
    await log(tx, d, "receipt_submitted", "transfer", { claimId: claim!.id, detail: { reference: transferRef, flags: flags.join(",") } });
    return claim!;
  });
}

/**
 * C6 (decision 0121) & C10 (decision 0138): turns a Messenger, Instagram DM or WhatsApp receipt photo into a transfer
 * claim on the conversation's open pending due, using the same flagging pipeline as the pay page. Never marks the due
 * paid; creates nothing when the due is closed or test; deduplicates webhook replays by (userId, sourceMid).
 */
export async function submitDmReceiptClaim(
  db: Db,
  o: { userId: string; dueId: string; sourceMid: string; channel: MetaChannel | "whatsapp"; caption?: string; image: { bytes: Buffer } },
): Promise<Claim | undefined> {
  return db.transaction(async (tx) => {
    const d = await lockDue(tx, and(eq(paymentDues.id, o.dueId), eq(paymentDues.userId, o.userId)));
    if (!d || d.test || d.status !== "pending") return undefined;

    const [replayed] = await tx
      .select()
      .from(paymentClaims)
      .where(and(eq(paymentClaims.userId, d.userId), eq(paymentClaims.sourceMid, o.sourceMid)))
      .limit(1);
    if (replayed) return replayed;

    const [waiting] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(paymentClaims)
      .where(and(eq(paymentClaims.dueId, d.id), eq(paymentClaims.channel, "transfer"), inArray(paymentClaims.status, ["open", "clarify"])));
    if (waiting!.n >= OPEN_CLAIMS_PER_DUE) throw new TooManyClaimsError();

    const transferRef = extractDmReceiptRef(o.caption ?? "");
    const normalizedRef = transferRef ? normalizeReceiptRef(transferRef) : null;
    const submittedCentavos = extractDmReceiptAmount(o.caption ?? "");
    const { flags, kind, readable } = await evaluateTransferClaim(tx, d, { normalizedRef, submittedCentavos, image: o.image });
    if (readable) await claimUsageInTx(tx, d.userId, "upload", { key: `dm-claim:${o.sourceMid}` });

    const [claim] = await tx
      .insert(paymentClaims)
      .values({
        userId: d.userId,
        dueId: d.id,
        channel: "transfer",
        transferRef,
        normalizedRef,
        submittedCentavos,
        sourceMid: o.sourceMid,
        flags,
        ...(readable ? { image: o.image.bytes, imageType: kind as "jpeg", imageSize: o.image.bytes.length } : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (!claim) {
      return (await tx.select().from(paymentClaims).where(and(eq(paymentClaims.userId, d.userId), eq(paymentClaims.sourceMid, o.sourceMid))).limit(1))[0];
    }
    await log(tx, d, "receipt_submitted", "transfer", {
      claimId: claim.id,
      detail: { source: "dm", channel: o.channel, mid: o.sourceMid, ...(transferRef ? { reference: transferRef } : {}), flags: flags.join(",") },
    });
    return claim;
  });
}

/** pending -> confirmed, once, with its source. Open claims of the same due are flagged, and one reply is queued. */
async function confirm(tx: Tx, d: Due, by: { source: "transfer" | "checkout"; actorId: string | null; claimId: string | null; paymentId: string | null }): Promise<boolean> {
  const [row] = await tx
    .update(paymentDues)
    .set({ status: "confirmed", confirmedSource: by.source, confirmedBy: by.actorId, confirmedAt: now as unknown as Date, confirmedClaimId: by.claimId, confirmedPaymentId: by.paymentId, updatedAt: now as unknown as Date })
    .where(and(eq(paymentDues.id, d.id), eq(paymentDues.status, "pending")))
    .returning();
  if (!row) return false;
  await tx.update(conversations).set({ openDueId: null }).where(and(eq(conversations.userId, row.userId), eq(conversations.openDueId, row.id)));
  await tx
    .update(paymentClaims)
    .set({ flags: sql`array_append(${paymentClaims.flags}, 'already_confirmed')`, version: sql`${paymentClaims.version} + 1` })
    .where(and(eq(paymentClaims.dueId, d.id), inArray(paymentClaims.status, ["open", "clarify"]), by.claimId ? ne(paymentClaims.id, by.claimId) : undefined, sql`not ('already_confirmed' = any(${paymentClaims.flags}))`));
  await log(tx, row, "confirmed", by.source, { actorId: by.actorId, claimId: by.claimId, detail: { amount: row.amountCentavos } });
  if (row.replyText && (await message(tx, row, CONFIRMED_STEP(row), row.replyText))) await log(tx, row, "reply_queued", "workflow", { detail: { channel: row.replyChannel } });
  return true;
}

export type Decision = "confirm" | "reject" | "clarify";
export type DecideResult = { result: "done" | "not_found" | "conflict" | "forbidden" | "already_confirmed" | "reason_needed"; claim?: Claim; due?: Due };

/**
 * A reviewer's decision on one claim. The version is the one the reviewer saw, so two reviewers at once cannot both
 * decide. A due with an assigned reviewer is decided by that reviewer or the owner. Reject and clarify need a reason,
 * which is sent to the customer.
 */
export async function decideClaim(db: Db, o: { workspaceId: string; actor: { id: string; role: Role }; claimId: string; version: number; decision: Decision; reason?: string }): Promise<DecideResult> {
  const reason = o.reason?.trim() ?? "";
  if (o.decision !== "confirm" && !reason) return { result: "reason_needed" };
  return db.transaction(async (tx) => {
    const [seen] = await tx.select({ dueId: paymentClaims.dueId }).from(paymentClaims).where(and(eq(paymentClaims.id, o.claimId), eq(paymentClaims.userId, o.workspaceId)));
    if (!seen) return { result: "not_found" };
    // The due first, then the claim: the same order as the webhook, so the two never deadlock.
    const d = (await lockDue(tx, and(eq(paymentDues.id, seen.dueId), eq(paymentDues.userId, o.workspaceId))))!;
    const [c] = await tx.select().from(paymentClaims).where(eq(paymentClaims.id, o.claimId)).for("update");
    if (!c || c.version !== o.version || (c.status !== "open" && c.status !== "clarify")) return { result: "conflict", claim: c, due: d };
    if (d.reviewerId && d.reviewerId !== o.actor.id && o.actor.role !== "owner") return { result: "forbidden", claim: c, due: d };
    if (o.decision === "confirm" && d.status !== "pending") return { result: "already_confirmed", claim: c, due: d };

    const status = o.decision === "confirm" ? "confirmed" : o.decision === "reject" ? "rejected" : "clarify";
    const [claim] = await tx
      .update(paymentClaims)
      .set({ status, reason: reason || null, decidedBy: o.actor.id, decidedAt: now as unknown as Date, version: c.version + 1 })
      .where(eq(paymentClaims.id, c.id))
      .returning();
    if (o.decision === "confirm") {
      await confirm(tx, d, { source: c.channel, actorId: o.actor.id, claimId: c.id, paymentId: c.paymentId });
      if (c.paymentId) {
        const [p] = await tx.select({ status: payments.status, providerPaymentId: payments.providerPaymentId }).from(payments).where(eq(payments.id, c.paymentId));
        if (p?.status === "refunded") {
          const [refRow] = await tx.update(paymentDues).set({ status: "refunded", updatedAt: now as unknown as Date }).where(and(eq(paymentDues.id, d.id), eq(paymentDues.status, "confirmed"))).returning();
          if (refRow) await log(tx, refRow, "refunded", "checkout", { detail: { payment: p.providerPaymentId } });
        }
      }
    } else {
      const text = o.decision === "reject" ? `We could not confirm your payment for ${d.reference}: ${reason}` : `About your payment for ${d.reference}: ${reason}`;
      const sent = await message(tx, d, `${d.stepId}#claim-${c.id}-${c.version}`, text);
      await log(tx, d, o.decision === "reject" ? "rejected" : "clarification_requested", "staff", { actorId: o.actor.id, claimId: c.id, detail: { reason, messaged: Boolean(sent) } });
    }
    return { result: "done", claim, due: (await tx.select().from(paymentDues).where(eq(paymentDues.id, d.id)))[0] };
  });
}

/**
 * What a PayMongo event means for the due its checkout belongs to, after markPaymentPaid or markPaymentRefunded has
 * moved the payment row. Safe to call again for the same payment: a replayed event changes nothing and sends nothing.
 * Returns the confirmed due only when this call transitioned a pending due to confirmed.
 */
export async function settleCheckout(db: Db, userId: string, paymentId: string): Promise<Due | undefined> {
  return db.transaction(async (tx) => {
    const [first] = await tx.select({ dueId: payments.dueId }).from(payments).where(and(eq(payments.id, paymentId), eq(payments.userId, userId)));
    if (!first?.dueId) return undefined;
    const d = await lockDue(tx, and(eq(paymentDues.id, first.dueId), eq(paymentDues.userId, userId)));
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!d || !p) return undefined;
    const matches = p.paidAmountCentavos === d.amountCentavos && p.paidCurrency === d.currency && p.reference === d.reference;

    if (p.status === "refunded") {
      if (d.confirmedPaymentId !== p.id || d.status !== "confirmed") return undefined;
      const [row] = await tx.update(paymentDues).set({ status: "refunded", updatedAt: now as unknown as Date }).where(and(eq(paymentDues.id, d.id), eq(paymentDues.status, "confirmed"))).returning();
      if (row) {
        await tx.update(conversations).set({ openDueId: null }).where(and(eq(conversations.userId, row.userId), eq(conversations.openDueId, row.id)));
        await log(tx, row, "refunded", "checkout", { detail: { payment: p.providerPaymentId } });
      }
      return undefined;
    }
    if (p.status !== "paid" && p.status !== "needs_review") return undefined;
    if (d.confirmedPaymentId === p.id) return undefined;
    if (p.status === "paid" && d.status === "pending" && matches) {
      if (await confirm(tx, d, { source: "checkout", actorId: null, claimId: null, paymentId: p.id })) {
        return (await tx.select().from(paymentDues).where(eq(paymentDues.id, d.id)))[0];
      }
      return undefined;
    }
    const flags: ClaimFlag[] = [];
    if (p.paidAmountCentavos !== d.amountCentavos || p.paidCurrency !== d.currency) flags.push("amount_mismatch");
    if (d.status === "confirmed" || d.status === "refunded") flags.push("paid_twice");
    if (d.status === "cancelled") flags.push("late_payment");
    if (flags.length === 0) flags.push("amount_mismatch");
    const [claim] = await tx
      .insert(paymentClaims)
      .values({ userId, dueId: d.id, channel: "checkout", transferRef: p.providerPaymentId, normalizedRef: null, submittedCentavos: p.paidAmountCentavos && p.paidAmountCentavos > 0 ? p.paidAmountCentavos : null, paymentId: p.id, flags })
      .onConflictDoNothing({ target: paymentClaims.paymentId })
      .returning();
    if (claim) await log(tx, d, "checkout_needs_review", "checkout", { claimId: claim.id, detail: { payment: p.providerPaymentId, paid: p.paidAmountCentavos, flags: flags.join(",") } });
    return undefined;
  });
}

/**
 * The unpaid deadline: pending -> cancelled, and its open checkout -> expired, from the expire step of the same run.
 * A due that was confirmed meanwhile is kept. The step running again reads its own earlier result.
 */
export async function expireDue(db: Db, at: { userId: string; runId: string; stepId: string; dueStepId: string }): Promise<{ result: "expired" | "kept" | "not_found"; due?: Due }> {
  return db.transaction(async (tx) => {
    const d = await lockDue(tx, and(eq(paymentDues.userId, at.userId), eq(paymentDues.runId, at.runId), eq(paymentDues.stepId, at.dueStepId)));
    if (!d) return { result: "not_found" };
    const marker = `${at.runId}:${at.stepId}`;
    if (d.status === "cancelled" && d.cancelledBy === marker) return { result: "expired", due: d };
    if (d.status !== "pending") return { result: "kept", due: d };
    const [row] = await tx.update(paymentDues).set({ status: "cancelled", cancelledBy: marker, updatedAt: now as unknown as Date }).where(eq(paymentDues.id, d.id)).returning();
    await tx.update(conversations).set({ openDueId: null }).where(and(eq(conversations.userId, row!.userId), eq(conversations.openDueId, row!.id)));
    await tx.update(payments).set({ status: "expired", updatedAt: now as unknown as Date }).where(and(eq(payments.dueId, d.id), eq(payments.status, "pending")));
    await log(tx, row!, "expired", "workflow");
    return { result: "expired", due: row };
  });
}

/** Payment confirmed, reply failed: queues the confirmation reply again, and nothing else. */
export async function retryReply(db: Db, workspaceId: string, dueId: string): Promise<boolean> {
  const [d] = await db.select().from(paymentDues).where(and(eq(paymentDues.id, dueId), eq(paymentDues.userId, workspaceId), eq(paymentDues.status, "confirmed")));
  if (!d) return false;
  const [reply] = await db.select({ id: deliveries.id }).from(deliveries).where(and(eq(deliveries.runId, d.runId), eq(deliveries.stepId, CONFIRMED_STEP(d))));
  if (!reply || !(await retryDelivery(db, workspaceId, reply.id))) return false;
  await db.transaction((tx) => log(tx, d, "reply_retried", "staff"));
  return true;
}

export type ReviewRow = {
  type: "claim" | "reply";
  claimId: string | null;
  version: number | null;
  dueId: string;
  reference: string;
  bookingReference: string | null;
  kind: Due["kind"];
  amountDue: number;
  submitted: number | null;
  transferRef: string | null;
  channel: string;
  flags: ClaimFlag[];
  status: string;
  dueStatus: Due["status"];
  confirmedSource: Due["confirmedSource"];
  reviewer: string | null;
  hasImage: boolean;
  replyState: string | null;
  replyError: string | null;
  createdAt: Date;
};

/**
 * Receipts to review: open and waiting-for-customer claims (manual receipts and checkout exceptions), then confirmed
 * dues whose reply failed. Oldest first. Test dues stay out.
 */
export async function reviewList(db: Db, workspaceId: string): Promise<ReviewRow[]> {
  const base = { dueId: paymentDues.id, reference: paymentDues.reference, bookingReference: bookings.reference, kind: paymentDues.kind, amountDue: paymentDues.amountCentavos, dueStatus: paymentDues.status, confirmedSource: paymentDues.confirmedSource, reviewer: sql<string | null>`coalesce(${users.displayName}, ${users.email})` };
  const claims = await db
    .select({ ...base, claimId: paymentClaims.id, version: paymentClaims.version, submitted: paymentClaims.submittedCentavos, transferRef: paymentClaims.transferRef, channel: paymentClaims.channel, flags: paymentClaims.flags, status: paymentClaims.status, hasImage: sql<boolean>`${paymentClaims.imageType} is not null`, createdAt: paymentClaims.createdAt })
    .from(paymentClaims)
    .innerJoin(paymentDues, eq(paymentDues.id, paymentClaims.dueId))
    .leftJoin(bookings, eq(bookings.id, paymentDues.bookingId))
    .leftJoin(users, eq(users.id, paymentDues.reviewerId))
    .where(and(eq(paymentClaims.userId, workspaceId), eq(paymentDues.test, false), inArray(paymentClaims.status, ["open", "clarify"])))
    .orderBy(asc(paymentClaims.createdAt));
  const failed = await db
    .select({ ...base, channel: sql<string>`coalesce(${paymentDues.replyChannel}, '')`, replyState: deliveries.state, replyError: deliveries.lastError, createdAt: sql<Date>`coalesce(${paymentDues.confirmedAt}, ${paymentDues.createdAt})` })
    .from(paymentDues)
    .innerJoin(deliveries, and(eq(deliveries.runId, paymentDues.runId), eq(deliveries.stepId, sql`${paymentDues.stepId} || '#confirmed'`)))
    .leftJoin(bookings, eq(bookings.id, paymentDues.bookingId))
    .leftJoin(users, eq(users.id, paymentDues.reviewerId))
    .where(and(eq(paymentDues.userId, workspaceId), eq(paymentDues.test, false), eq(paymentDues.status, "confirmed"), inArray(deliveries.state, ["failed", "needs_review"])))
    .orderBy(asc(paymentDues.confirmedAt));
  return [
    ...claims.map((c) => ({ ...c, type: "claim" as const, replyState: null, replyError: null })),
    ...failed.map((f) => ({ ...f, type: "reply" as const, claimId: null, version: null, submitted: null, transferRef: null, flags: [], status: "reply_failed", hasImage: false, createdAt: new Date(f.createdAt) })),
  ];
}

/** A claim's receipt image, only within its own workspace. */
export async function claimImage(db: Db, workspaceId: string, claimId: string) {
  const [row] = await db.select({ image: paymentClaims.image, type: paymentClaims.imageType }).from(paymentClaims).where(and(eq(paymentClaims.id, claimId), eq(paymentClaims.userId, workspaceId)));
  return row?.image && row.type ? { bytes: row.image, type: row.type } : undefined;
}

/**
 * The payments of one booking or order, with their history and what is still owed: a confirmed deposit leaves the rest
 * of the total outstanding, and a pay-later balance is owed in full until it is confirmed.
 */
export async function duesForBooking(db: Db, workspaceId: string, by: { bookingId?: string; reference?: string }) {
  if (!by.bookingId && !by.reference) return [];
  const confirmer = sql<string | null>`(select coalesce(${users.displayName}, ${users.email}) from ${users} where ${users.id} = ${paymentDues.confirmedBy})`;
  const rows = await db
    .select({ due: paymentDues, confirmedBy: confirmer })
    .from(paymentDues)
    .where(and(eq(paymentDues.userId, workspaceId), eq(paymentDues.test, false), or(by.bookingId ? eq(paymentDues.bookingId, by.bookingId) : undefined, by.reference ? eq(paymentDues.reference, by.reference) : undefined)))
    .orderBy(asc(paymentDues.createdAt));
  if (rows.length === 0) return [];
  const actor = sql<string | null>`(select coalesce(${users.displayName}, ${users.email}) from ${users} where ${users.id} = ${paymentHistory.actorId})`;
  const events = await db
    .select({ dueId: paymentHistory.dueId, event: paymentHistory.event, source: paymentHistory.source, actor, detail: paymentHistory.detail, at: paymentHistory.at })
    .from(paymentHistory)
    .where(inArray(paymentHistory.dueId, rows.map((r) => r.due.id)))
    .orderBy(asc(paymentHistory.at));
  return rows.map(({ due: d, confirmedBy }) => {
    const paid = d.status === "confirmed" ? d.amountCentavos : 0;
    return {
      id: d.id,
      reference: d.reference,
      bookingId: d.bookingId,
      kind: d.kind,
      status: d.status,
      amount: d.amountCentavos,
      total: d.totalCentavos,
      outstanding: (d.totalCentavos ?? d.amountCentavos) - paid,
      confirmedSource: d.confirmedSource,
      confirmedBy,
      confirmedAt: d.confirmedAt,
      history: events.filter((e) => e.dueId === d.id).map((e) => ({ event: e.event, source: e.source, actor: e.actor, detail: e.detail, at: e.at })),
    };
  });
}

/** The owner or operator of the workspace with this email, who may review payments, or null. */
export async function findReviewer(db: Db, workspaceId: string, email: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.email, email.trim().toLowerCase()), inArray(workspaceMembers.role, ["owner", "operator"])));
  return row ?? null;
}

/** The booking a booking step of this run made, with its reference, or undefined when it booked nothing (taken). */
export async function bookingOfStep(db: Db, runId: string, stepId: string) {
  const [row] = await db
    .select({ id: bookings.id, reference: bookings.reference, test: bookings.test })
    .from(bookingResults)
    .innerJoin(bookings, eq(bookings.id, bookingResults.bookingId))
    .where(and(eq(bookingResults.runId, runId), eq(bookingResults.stepId, stepId)));
  return row;
}

export const bookingReference = async (db: Db, bookingId: string) => (await db.select({ reference: bookings.reference }).from(bookings).where(eq(bookings.id, bookingId)))[0]?.reference;

/** The open checkout of a due, if it has one. */
export const pendingCheckout = async (db: Db, dueId: string) => (await db.select().from(payments).where(and(eq(payments.dueId, dueId), eq(payments.status, "pending"))))[0];

export const readPaymentSettings = async (db: Db, workspaceId: string) => (await db.select().from(paymentSettings).where(eq(paymentSettings.userId, workspaceId)))[0];

/** The owner's payment details for the pay page. A qr of null removes the image; undefined leaves it. */
export async function savePaymentSettings(db: Db, workspaceId: string, v: { gcashNumber: string | null; accountName: string | null; qr?: { bytes: Buffer; type: "jpeg" | "png" | "webp" } | null; receiptRetentionDays?: number }) {
  const qr = { ...(v.qr === undefined ? {} : { qrImage: v.qr?.bytes ?? null, qrType: v.qr?.type ?? null }), ...(v.receiptRetentionDays === undefined ? {} : { receiptRetentionDays: v.receiptRetentionDays }) };
  await db
    .insert(paymentSettings)
    .values({ userId: workspaceId, gcashNumber: v.gcashNumber, accountName: v.accountName, ...qr })
    .onConflictDoUpdate({ target: paymentSettings.userId, set: { gcashNumber: v.gcashNumber, accountName: v.accountName, ...qr, updatedAt: sql`now()` } });
}

/** The latest claim the customer sent for a due, for the pay page: its state and, for a clarification, the reviewer's question. */
export const latestClaim = async (db: Db, dueId: string) =>
  (await db.select({ status: paymentClaims.status, reason: paymentClaims.reason, transferRef: paymentClaims.transferRef }).from(paymentClaims).where(and(eq(paymentClaims.dueId, dueId), eq(paymentClaims.channel, "transfer"))).orderBy(sql`${paymentClaims.createdAt} desc`).limit(1))[0];
