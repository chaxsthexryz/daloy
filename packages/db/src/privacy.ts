import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bookingChanges, bookingResults, bookings, calendarEvents, conversationMessages, conversations, deliveries, paymentClaims, paymentDues, paymentHistory, paymentSettings, paymongoEvents, privacyRequests, receiptReferences, requests, runs, stepRuns, uploads, users, workflows, workflowVersions,
} from "./schema";

type AnyDb = NodePgDatabase<Record<string, unknown>>;

/** Who the owner is asking about: exactly one identifier. */
export type CustomerQuery = { email: string } | { phone: string };

/** A Philippine mobile number as its 10 national digits starting with 9, or null when the text is not one. */
export function normalizePhone(text: string): string | null {
  let d = text.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("63")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^9\d{9}$/.test(d) ? d : null;
}

const walk = (test: (leaf: string | number) => boolean) => {
  const hit = (v: unknown): boolean => (typeof v === "string" || typeof v === "number" ? test(v) : Array.isArray(v) ? v.some(hit) : v !== null && typeof v === "object" ? Object.values(v).some(hit) : false);
  return hit;
};
const PHONE_RUN = /(?<!\d)(?:\+?63|0)?[\s.-]*9(?:[\s.-]*\d){9}(?!\d)/g;

/** Walks every leaf of a JSON value. A string matches when it holds the whole email or a run that reads as the phone. */
export function matcher(q: CustomerQuery): (value: unknown) => boolean {
  if ("email" in q) {
    const escaped = q.email.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Not part of a longer address: no address character before, and no more domain or local part after.
    // Every metacharacter in the validated email is escaped above, so the pattern is a literal plus fixed lookarounds.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const re = new RegExp(`(?<![a-z0-9._%+-])${escaped}(?![a-z0-9._%+-]*@|[a-z0-9-]|\\.[a-z])`, "i");
    return walk((leaf) => re.test(String(leaf)));
  }
  const phone = normalizePhone(q.phone);
  return walk((leaf) => phone !== null && (typeof leaf === "number" ? normalizePhone(String(leaf)) === phone : (leaf.match(PHONE_RUN) ?? []).some((m) => normalizePhone(m) === phone)));
}

const b64 = (b: Buffer | null) => (b ? b.toString("base64") : null);

/** Every row of the workspace that belongs to the customer. Nothing is read outside the workspace. */
async function collect(db: AnyDb, workspaceId: string, q: CustomerQuery) {
  const match = matcher(q);
  // shortcut: scans every run in the workspace, add an index or customer table if workspaces reach many thousands of runs.
  const allRuns = await db
    .select({ id: runs.id, triggerPayload: runs.triggerPayload, conversationId: runs.conversationId })
    .from(runs)
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(workflows.userId, workspaceId));
  const runIds = new Set(allRuns.filter((r) => match(r.triggerPayload)).map((r) => r.id));
  for (const d of await db.select({ runId: paymentDues.runId, replyTo: paymentDues.replyTo }).from(paymentDues).where(and(eq(paymentDues.userId, workspaceId), isNotNull(paymentDues.replyTo)))) if (match(d.replyTo)) runIds.add(d.runId);
  // Conversations (decision 0115): by saved fields, the email address one is keyed by, any message text, or a matched
  // run's conversation. Every run of a matched conversation belongs to the customer too.
  // shortcut: scans every message in the workspace, like the runs above; the retention sweep keeps the table bounded.
  const allConversations = await db.select().from(conversations).where(eq(conversations.userId, workspaceId));
  const convIds = new Set(allConversations.filter((c) => match(c.fields) || (c.channel === "email" && match(c.externalId))).map((c) => c.id));
  const texts = await db.select({ conversationId: conversationMessages.conversationId, text: conversationMessages.text }).from(conversationMessages).innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId)).where(eq(conversations.userId, workspaceId));
  for (const t of texts) if (match(t.text)) convIds.add(t.conversationId);
  for (const r of allRuns) if (r.conversationId && runIds.has(r.id)) convIds.add(r.conversationId);
  for (const r of allRuns) if (r.conversationId && convIds.has(r.conversationId)) runIds.add(r.id);
  const cIds = [...convIds];
  const events = (await db.select().from(paymongoEvents).where(and(eq(paymongoEvents.userId, workspaceId), isNotNull(paymongoEvents.payload)))).filter((e) => match(e.payload));
  const ids = [...runIds];
  const inRuns = (col: AnyPgColumn) => (ids.length ? inArray(col, ids) : sql`false`);

  const runRows = ids.length ? await db.select().from(runs).where(inArray(runs.id, ids)) : [];
  const dues = await db.select().from(paymentDues).where(and(eq(paymentDues.userId, workspaceId), inRuns(paymentDues.runId)));
  const dueIds = dues.map((d) => d.id);
  const bookingIds = new Set<string>();
  for (const r of await db.select({ id: bookings.id }).from(bookings).where(and(eq(bookings.userId, workspaceId), inRuns(bookings.runId)))) bookingIds.add(r.id);
  for (const d of dues) if (d.bookingId) bookingIds.add(d.bookingId);
  const results = await db.select().from(bookingResults).where(inRuns(bookingResults.runId));
  for (const r of results) if (r.bookingId) bookingIds.add(r.bookingId);
  const bIds = [...bookingIds];
  const inBookings = (col: AnyPgColumn) => (bIds.length ? inArray(col, bIds) : sql`false`);
  const changes = await db.select().from(bookingChanges).where(inBookings(bookingChanges.bookingId));

  return {
    runs: runRows,
    stepRuns: await db.select().from(stepRuns).where(inRuns(stepRuns.runId)),
    uploads: await db.select().from(uploads).where(and(eq(uploads.userId, workspaceId), inRuns(uploads.runId))),
    deliveries: await db.select().from(deliveries).where(and(eq(deliveries.userId, workspaceId), inRuns(deliveries.runId))),
    requests: await db.select().from(requests).where(and(eq(requests.userId, workspaceId), inRuns(requests.runId))),
    bookings: await db.select().from(bookings).where(and(eq(bookings.userId, workspaceId), inBookings(bookings.id))),
    bookingResults: results,
    bookingChanges: changes,
    calendarEvents: await db.select().from(calendarEvents).where(and(eq(calendarEvents.userId, workspaceId), inBookings(calendarEvents.bookingId))),
    dues,
    claims: dueIds.length ? await db.select().from(paymentClaims).where(and(eq(paymentClaims.userId, workspaceId), inArray(paymentClaims.dueId, dueIds))) : [],
    history: dueIds.length ? await db.select().from(paymentHistory).where(and(eq(paymentHistory.userId, workspaceId), inArray(paymentHistory.dueId, dueIds))) : [],
    paymongoEvents: events,
    receiptReferences: await db.select().from(receiptReferences).where(and(eq(receiptReferences.userId, workspaceId), inRuns(receiptReferences.firstRunId))),
    conversations: allConversations.filter((c) => convIds.has(c.id)),
    conversationMessages: cIds.length ? await db.select().from(conversationMessages).where(inArray(conversationMessages.conversationId, cIds)).orderBy(conversationMessages.createdAt) : [],
  };
}
type Found = Awaited<ReturnType<typeof collect>>;

const countsOf = (f: Found): Record<string, number> => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.length]));

/** What stays after a delete, and why. Only items that exist for this customer are listed. */
function keptOf(f: Found): { item: string; reason: string }[] {
  const all: [keyof Found, string, string][] = [
    ["runs", "runs", "state and time stay so run history and usage counts stay right; the customer's content is erased"],
    ["bookings", "bookings", "the held time stays; it has no name or contact"],
    ["requests", "requests", "the reference stays so staff can still find the request"],
    ["dues", "payment_dues", "amount, status and reference stay for bookkeeping"],
    ["history", "payment_history", "amounts, events and who decided stay for bookkeeping"],
    ["receiptReferences", "receipt_references", "reference numbers stay to catch a reused receipt; they hold no name"],
  ];
  // conversations and conversationMessages are not listed: a delete removes them outright, so nothing of them stays.
  const kept = all.filter(([k]) => f[k].length > 0).map(([, item, reason]) => ({ item, reason }));
  if (f.claims.some((c) => c.status === "confirmed")) kept.push({ item: "payment_claims", reason: "the transfer reference of a confirmed payment stays for bookkeeping; the receipt image is deleted" });
  return kept;
}

async function audit(db: AnyDb, workspaceId: string, actorId: string, action: "export" | "delete", counts: Record<string, number>, kept: { item: string; reason: string }[]) {
  await db.insert(privacyRequests).values({ userId: workspaceId, actorId, action, counts, kept });
}

/** Everything the workspace holds about the customer, as one JSON-ready object. Writes an audit row. */
export async function exportCustomer(db: AnyDb, workspaceId: string, actorId: string, q: CustomerQuery) {
  const f = await collect(db, workspaceId, q);
  const counts = countsOf(f);
  await audit(db, workspaceId, actorId, "export", counts, []);
  return {
    exportedAt: new Date().toISOString(),
    counts,
    ...f,
    uploads: f.uploads.map(({ data, ...u }) => ({ ...u, dataBase64: b64(data) })),
    claims: f.claims.map(({ image, ...c }) => ({ ...c, imageBase64: b64(image) })),
    // The deliveries show where data was sent outside Daloy, which a delete cannot reach.
  };
}

/** Erases what runs hold about a customer and stops the ones still going. Their state and times stay for history and usage. */
async function eraseRuns(tx: AnyDb, workspaceId: string, runIds: string[]) {
  if (!runIds.length) return;
  await tx.update(runs).set({ triggerPayload: { erased: true }, error: null }).where(inArray(runs.id, runIds));
  await tx.update(runs).set({ state: "cancelled", finishedAt: new Date() }).where(and(inArray(runs.id, runIds), inArray(runs.state, ["pending", "running", "waiting", "needs_review"])));
  await tx.update(stepRuns).set({ input: null, output: null, error: null }).where(inArray(stepRuns.runId, runIds));
  await tx.delete(uploads).where(and(eq(uploads.userId, workspaceId), inArray(uploads.runId, runIds)));
  await tx.delete(deliveries).where(and(eq(deliveries.userId, workspaceId), inArray(deliveries.runId, runIds)));
  await tx.update(requests).set({ subject: "Deleted on request" }).where(and(eq(requests.userId, workspaceId), inArray(requests.runId, runIds)));
  await tx.update(bookingResults).set({ output: {} }).where(inArray(bookingResults.runId, runIds));
}

/** Erases the customer's content in one transaction and keeps what bookkeeping needs. Writes an audit row. */
export async function deleteCustomer(db: AnyDb, workspaceId: string, actorId: string, q: CustomerQuery) {
  return db.transaction(async (tx) => {
    const f = await collect(tx as unknown as AnyDb, workspaceId, q);
    const counts = countsOf(f);
    const kept = keptOf(f);
    const runIds = f.runs.map((r) => r.id);
    const bookingIds = f.bookings.map((b) => b.id);
    await eraseRuns(tx as unknown as AnyDb, workspaceId, runIds);
    const convIds = f.conversations.map((c) => c.id);
    // Messages go with their conversation (on delete cascade).
    if (convIds.length) await tx.delete(conversations).where(and(eq(conversations.userId, workspaceId), inArray(conversations.id, convIds)));
    if (bookingIds.length) {
      await tx.update(bookingResults).set({ output: {} }).where(inArray(bookingResults.bookingId, bookingIds));
      await tx.update(bookingChanges).set({ result: {} }).where(inArray(bookingChanges.bookingId, bookingIds));
      await tx.delete(calendarEvents).where(and(eq(calendarEvents.userId, workspaceId), inArray(calendarEvents.bookingId, bookingIds)));
    }
    const dueIds = f.dues.map((d) => d.id);
    if (dueIds.length) {
      await tx.update(paymentDues).set({ replyTo: null, replyText: null }).where(and(eq(paymentDues.userId, workspaceId), inArray(paymentDues.id, dueIds)));
      const claim = and(eq(paymentClaims.userId, workspaceId), inArray(paymentClaims.dueId, dueIds));
      await tx.update(paymentClaims).set({ image: null, imageType: null, imageSize: null }).where(claim);
      await tx.update(paymentClaims).set({ transferRef: null, normalizedRef: null }).where(and(claim, sql`${paymentClaims.status} <> 'confirmed'`));
      // History rows about a claim that lost its reference lose the copy of it too.
      const lost = f.claims.filter((c) => c.status !== "confirmed").map((c) => c.id);
      if (lost.length) await tx.update(paymentHistory).set({ detail: sql`${paymentHistory.detail} - 'reference'` }).where(and(eq(paymentHistory.userId, workspaceId), inArray(paymentHistory.claimId, lost)));
    }
    const eventIds = f.paymongoEvents.map((e) => e.eventId);
    if (eventIds.length) await tx.update(paymongoEvents).set({ payload: null }).where(and(eq(paymongoEvents.userId, workspaceId), inArray(paymongoEvents.eventId, eventIds)));
    await audit(tx as unknown as AnyDb, workspaceId, actorId, "delete", counts, kept);
    return { counts, kept };
  });
}

/**
 * Clears receipt images on claims whose due closed (confirmed, cancelled or refunded) longer ago than the workspace's
 * retention days, by the due's updated_at. A workspace with no settings row uses 90 days. At most limit claims per call.
 */
export async function purgeReceiptImages(db: AnyDb, now = new Date(), limit = 200): Promise<number> {
  const old = db
    .select({ id: paymentClaims.id })
    .from(paymentClaims)
    .innerJoin(paymentDues, eq(paymentDues.id, paymentClaims.dueId))
    .leftJoin(paymentSettings, eq(paymentSettings.userId, paymentClaims.userId))
    .where(
      and(
        isNotNull(paymentClaims.image),
        inArray(paymentDues.status, ["confirmed", "cancelled", "refunded"]),
        lt(paymentDues.updatedAt, sql`${now.toISOString()}::timestamptz - make_interval(days => coalesce(${paymentSettings.receiptRetentionDays}, 90))`),
      ),
    )
    .orderBy(paymentDues.updatedAt)
    .limit(limit);
  const gone = await db.update(paymentClaims).set({ image: null, imageType: null, imageSize: null }).where(inArray(paymentClaims.id, old)).returning({ id: paymentClaims.id });
  return gone.length;
}

/**
 * Retention (decision 0115): deletes conversations whose last message, in or out, is older than the workspace's
 * conversation retention days (90 unless changed), with their messages, and erases the runs that answered them the way
 * a customer delete does, since their trigger payload carries the message history. At most limit conversations per call.
 */
export async function purgeConversations(db: AnyDb, now = new Date(), limit = 200): Promise<number> {
  const old = await db
    .select({ id: conversations.id, userId: conversations.userId })
    .from(conversations)
    .innerJoin(users, eq(users.id, conversations.userId))
    .where(lt(sql`coalesce(greatest(${conversations.lastInboundAt}, ${conversations.lastOutboundAt}), ${conversations.createdAt})`, sql`${now.toISOString()}::timestamptz - make_interval(days => ${users.conversationRetentionDays})`))
    .limit(limit);
  for (const workspaceId of new Set(old.map((c) => c.userId))) {
    const ids = old.filter((c) => c.userId === workspaceId).map((c) => c.id);
    await db.transaction(async (tx) => {
      const linked = await tx.select({ id: runs.id }).from(runs).where(inArray(runs.conversationId, ids));
      await eraseRuns(tx as unknown as AnyDb, workspaceId, linked.map((r) => r.id));
      await tx.delete(conversations).where(inArray(conversations.id, ids));
    });
  }
  return old.length;
}
