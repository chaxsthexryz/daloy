import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { bookingSuperseded } from "./bookings";
import { buildThreadHeaders, sanitizeMessageId, sanitizeReferences } from "./mail";
import { businessProfiles, conversationMessages, conversations, users } from "./schema";

type AnyDb = NodePgDatabase<Record<string, unknown>>;
type Reader = Pick<AnyDb, "select">;

export type ConversationChannel = "messenger" | "instagram" | "email";
export type Conversation = typeof conversations.$inferSelect;

/** Meta's standard messaging window: a reply may go out up to 24 hours after the guest's last message. */
export const WINDOW_MS = 24 * 3600_000;
/** Longest stored message text; the trigger payload carries at most this much history. */
export const MESSAGE_MAX = 4000;
const HISTORY_MESSAGES = 10;
/** What conversation_update may save, and how long each value may be. */
export const CONVERSATION_FIELDS = ["check_in", "check_out", "guests", "name", "phone", "email"] as const;
export const FIELD_MAX = 200;
/** An echo with this text as its own copy of a reply, sent within this time, is Daloy's reply, not a staff reply. */
const OWN_ECHO_MS = 10 * 60_000;

/** True while Meta still accepts a standard reply: at most 24 hours since the guest's last message. */
export const windowOpen = (lastInboundAt: Date | null, now = Date.now()) => lastInboundAt !== null && now - lastInboundAt.getTime() <= WINDOW_MS;

/** True while staff have the conversation: the bot sends nothing until staff_until (or until Hand back, when there is none). */
export const isPaused = (c: Pick<Conversation, "status" | "staffUntil">, now = Date.now()) => c.status === "staff" && (c.staffUntil === null || c.staffUntil.getTime() > now);

const cap = (text: string) => text.slice(0, MESSAGE_MAX);

/**
 * Upserts the guest's conversation and appends the inbound message, in the caller's transaction so the run that answers
 * it commits with it. A new mid raises version (older runs stop at their next step); a replayed mid changes nothing.
 * The conversation row stays locked until the caller commits, so two messages at once get versions one after another.
 */
export async function recordInbound(
  tx: AnyDb,
  m: { userId: string; channel: ConversationChannel; externalId: string; mid: string; text: string; at: Date; uploadIds?: string[]; emailReferences?: string[] },
): Promise<Conversation & { replayed: boolean }> {
  const key = and(eq(conversations.userId, m.userId), eq(conversations.channel, m.channel), eq(conversations.externalId, m.externalId));
  await tx.insert(conversations).values({ userId: m.userId, channel: m.channel, externalId: m.externalId }).onConflictDoNothing();
  const [c] = await tx.select().from(conversations).where(key).for("update");
  const emailReferences = m.channel === "email" ? sanitizeReferences(m.emailReferences) : [];
  const added = await tx
    .insert(conversationMessages)
    .values({ conversationId: c!.id, direction: "in", text: cap(m.text), mid: m.mid, emailReferences, uploadIds: m.uploadIds ?? [] })
    .onConflictDoNothing()
    .returning({ id: conversationMessages.id });
  if (added.length === 0) return { ...c!, replayed: true };
  // A timestamp from the sender is never trusted past now, so a future one cannot hold the window open.
  const at = new Date(Math.min(m.at.getTime(), Date.now()));
  const [next] = await tx
    .update(conversations)
    .set({
      version: sql`${conversations.version} + 1`,
      lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${at.toISOString()}::timestamptz)`,
      // The quiet period after a staff reply has passed: the bot answers again.
      status: sql`case when ${conversations.status} = 'staff' and ${conversations.staffUntil} <= now() then 'bot' else ${conversations.status} end`,
    })
    .where(eq(conversations.id, c!.id))
    .returning();
  return { ...next!, replayed: false };
}

/**
 * A message the Page or Instagram account sent to the guest. Daloy's own reply (marked by the send, or the same text as a
 * reply queued in the last ten minutes) changes nothing. Any other is a person replying from the inbox: it is stored and
 * the bot stays quiet for the workspace's quiet period. An echo for a guest with no conversation is ignored.
 */
export async function recordEcho(db: AnyDb, e: { userId: string; channel: ConversationChannel; externalId: string; mid: string; text: string; ours: boolean }): Promise<"own" | "staff" | "ignored"> {
  return db.transaction(async (tx) => {
    const [c] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.userId, e.userId), eq(conversations.channel, e.channel), eq(conversations.externalId, e.externalId)))
      .for("update");
    if (!c) return "ignored";
    if (e.ours) return "own";
    const since = new Date(Date.now() - OWN_ECHO_MS);
    const [mine] = await tx
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.conversationId, c.id), eq(conversationMessages.direction, "out"), eq(conversationMessages.text, cap(e.text).trim()), gt(conversationMessages.createdAt, since)))
      .limit(1);
    if (mine) return "own";
    const added = await tx.insert(conversationMessages).values({ conversationId: c.id, direction: "staff", text: cap(e.text), mid: e.mid }).onConflictDoNothing().returning({ id: conversationMessages.id });
    if (added.length > 0) {
      const quiet = sql`now() + make_interval(hours => (select ${users.staffQuietHours} from ${users} where ${users.id} = ${e.userId}))`;
      await tx.update(conversations).set({ status: "staff", staffUntil: quiet, lastOutboundAt: sql`now()` }).where(eq(conversations.id, c.id));
    }
    return "staff";
  });
}

/** What a run sees of its conversation: id, status, saved fields, open due id and the last 10 messages, oldest first, within 4,000 characters. */
export async function conversationPayload(db: Reader, c: Pick<Conversation, "id" | "status" | "fields"> & { openDueId?: string | null }) {
  const rows = await db
    .select({ direction: conversationMessages.direction, text: conversationMessages.text, at: conversationMessages.createdAt })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, c.id))
    .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id))
    .limit(HISTORY_MESSAGES);
  const history: { direction: string; text: string; at: string }[] = [];
  let budget = MESSAGE_MAX;
  for (const r of rows) {
    if (budget <= 0) break;
    const text = r.text.slice(0, budget);
    budget -= text.length;
    history.unshift({ direction: r.direction, text, at: r.at.toISOString() });
  }
  return { id: c.id, status: c.status, fields: c.fields, openDueId: c.openDueId ?? null, history };
}

/**
 * Latest sanitized In-Reply-To and References headers for replying to an email conversation (C6, decision 0121).
 * Reads the most recent inbound message and validates every Message-ID before returning it.
 */
export async function emailThreadFor(db: Reader, conversationId: string): Promise<{ inReplyTo?: string; references?: string[] }> {
  const [latest] = await db
    .select({ mid: conversationMessages.mid, emailReferences: conversationMessages.emailReferences })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.direction, "in")))
    .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id))
    .limit(1);
  if (!latest) return {};
  return buildThreadHeaders({ inReplyTo: latest.mid, references: latest.emailReferences });
}

/** Records an outbound email reply sent to the guest of an email conversation (C6, decision 0121). */
export async function recordOutboundEmail(
  db: AnyDb,
  o: { conversationId: string; runId: string; text: string; messageId: string; references?: string[] },
): Promise<void> {
  const mid = sanitizeMessageId(o.messageId);
  const emailReferences = sanitizeReferences(o.references);
  await db
    .insert(conversationMessages)
    .values({ conversationId: o.conversationId, direction: "out", text: cap(o.text).trim(), mid, emailReferences, runId: o.runId })
    .onConflictDoNothing();
  await db.update(conversations).set({ lastOutboundAt: sql`now()` }).where(eq(conversations.id, o.conversationId));
}

/** The run's conversation, or undefined for a run that no message started. */
export async function runConversation(db: Reader, conversationId: string | null | undefined): Promise<Conversation | undefined> {
  if (!conversationId) return undefined;
  const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  return c;
}

type Linked = { bookingId: string | null; bookingVersion: number | null; conversationId?: string | null; conversationVersion?: number | null };

/**
 * Why a run must stop before its next step, or false: its booking changed (decision 0032), or the guest sent a newer
 * message, which the newer run answers (decision 0115). lock holds a share lock on the row until the caller commits.
 */
export async function runSuperseded(db: Reader, run: Linked, lock = false): Promise<"booking" | "conversation" | false> {
  if (await bookingSuperseded(db, run, lock)) return "booking";
  if (!run.conversationId) return false;
  const q = db.select({ version: conversations.version }).from(conversations).where(eq(conversations.id, run.conversationId));
  const [c] = lock ? await q.for("share") : await q;
  return c && c.version === run.conversationVersion ? false : "conversation";
}

/** Merges the given fields into the conversation; an empty value leaves the saved one as it is. Returns all saved fields. */
export async function saveConversationFields(db: AnyDb, conversationId: string, given: Partial<Record<(typeof CONVERSATION_FIELDS)[number], string>>) {
  const patch: Record<string, string> = {};
  for (const k of CONVERSATION_FIELDS) {
    const v = given[k]?.trim().slice(0, FIELD_MAX);
    if (v) patch[k] = v;
  }
  const [c] = await db
    .update(conversations)
    .set({ fields: sql`${conversations.fields} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(conversations.id, conversationId))
    .returning({ fields: conversations.fields });
  return c?.fields;
}

/**
 * Records a reply the run is about to queue and returns the text to send. The first reply of a conversation carries the
 * privacy notice (RA 10173), once: notice_sent_at is claimed in this transaction. When reply and notice together pass
 * max, the reply goes alone and the next one carries the notice. The out row is how a later echo is known as Daloy's own.
 */
export async function prepareReply(tx: AnyDb, c: { id: string; userId: string; runId: string; text: string; max: number }): Promise<string> {
  const [ws] = await tx
    .select({ language: users.language, days: users.conversationRetentionDays, business: businessProfiles.businessName })
    .from(users)
    .leftJoin(businessProfiles, eq(businessProfiles.userId, users.id))
    .where(eq(users.id, c.userId));
  const withNotice = `${conversationNotice(ws?.language ?? "en", ws?.business ?? null, ws?.days ?? 90)}\n\n${c.text}`;
  const claimed = withNotice.length <= c.max && (await tx.update(conversations).set({ noticeSentAt: sql`now()` }).where(and(eq(conversations.id, c.id), isNull(conversations.noticeSentAt))).returning({ id: conversations.id })).length > 0;
  const body = claimed ? withNotice : c.text;
  await tx.insert(conversationMessages).values({ conversationId: c.id, direction: "out", text: cap(body).trim(), runId: c.runId });
  await tx.update(conversations).set({ lastOutboundAt: sql`now()` }).where(eq(conversations.id, c.id));
  return body;
}

/** The first-reply notice: an automated assistant, what is kept and why, the AI provider, and for how long. */
export function conversationNotice(language: "en" | "tl", business: string | null, days: number) {
  const name = business?.trim();
  return language === "tl"
    ? `Hi! Ito ang automated assistant ng ${name || "negosyong ito"}. Para matulungan ka sa booking, itinatago namin ang petsa, bilang ng guests, pangalan at contact na ibibigay mo rito nang ${days} araw, at pinoproseso ng aming AI provider ang iyong mga mensahe. Huwag po magpadala ng ID, card number o health details.`
    : `Hi! This is ${name ? `${name}'s` : "this business's"} automated assistant. To help with your booking we keep the dates, number of guests, name and contact details you send here for ${days} days, and your messages are processed by our AI provider. Please do not send ID photos, card numbers or health details.`;
}
