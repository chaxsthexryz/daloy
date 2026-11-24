import { definitionSchema } from "@daloy/engine";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { bookingSuperseded } from "./bookings";
import { connectionCredential } from "./connections";
import { buildThreadHeaders, sanitizeMessageId, sanitizeReferences, type MailDeps } from "./mail";
import { metaSend, parseMetaCredential } from "./meta";
import { providerUrls, telegramSend, type ProviderUrls } from "./providers";
import { publishedVersion } from "./runs";
import { bookings, businessProfiles, connections, conversationMessages, conversations, paymentDues, users, workflows } from "./schema";

type AnyDb = NodePgDatabase<Record<string, unknown>>;
type Reader = Pick<AnyDb, "select">;

export type ConversationChannel = "messenger" | "instagram" | "email" | "telegram";
export type Conversation = typeof conversations.$inferSelect;

/** Meta's standard messaging window: a reply may go out up to 24 hours after the guest's last message. */
export const WINDOW_MS = 24 * 3600_000;
/** Longest stored message text; the trigger payload carries at most this much history. */
export const MESSAGE_MAX = 4000;
const HISTORY_MESSAGES = 10;
/** What conversation_update may save, and how long each value may be. */
export const CONVERSATION_FIELDS = ["check_in", "check_out", "guests", "name", "phone", "email"] as const;
export const FIELD_MAX = 200;
/** An echo with this text as its own copy of a reply, sent within this time, is kymavo's reply, not a staff reply. */
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
 * A message the Page or Instagram account sent to the guest. kymavo's own reply (marked by the send, or the same text as a
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

/** Records an outbound reply (e.g. Telegram) in conversation history without adding the booking privacy notice (J1, decision 0135). */
export async function recordOutboundReply(
  db: Pick<AnyDb, "insert" | "update">,
  o: { conversationId: string; runId: string; text: string },
): Promise<void> {
  await db
    .insert(conversationMessages)
    .values({ conversationId: o.conversationId, direction: "out", text: cap(o.text).trim(), runId: o.runId });
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
  if (!c) return "conversation";
  if (run.conversationVersion == null) return false;
  return c.version === run.conversationVersion ? false : "conversation";
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
 * max, the reply goes alone and the next one carries the notice. The out row is how a later echo is known as kymavo's own.
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

const STATUS_ORDER: Record<Conversation["status"], number> = { staff: 0, bot: 1, closed: 2 };

export type StaffAlertStatus = {
  staffAlertPsid: string | null;
  messengerConnected: boolean;
  staffWindowOpen: boolean;
  staffWindowExpiresAt: string | null;
  telegramReady: boolean;
  emailFallback: string | null;
  activeChannel: "messenger" | "telegram" | "email";
};

export type ConversationSettings = {
  conversationRetentionDays: number;
  staffQuietHours: number;
  staffAlertPsid: string | null;
};

/** Lists workspace conversations with Needs staff sorted first, then latest message activity (C7, decision 0125). */
export async function listConversations(db: AnyDb, workspaceId: string) {
  const rows = await db.select().from(conversations).where(eq(conversations.userId, workspaceId));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const msgs = await db
    .select({
      conversationId: conversationMessages.conversationId,
      direction: conversationMessages.direction,
      text: conversationMessages.text,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .where(inArray(conversationMessages.conversationId, ids))
    .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id));

  const latestByConvo = new Map<string, { direction: string; text: string; createdAt: string }>();
  for (const m of msgs) {
    if (!latestByConvo.has(m.conversationId)) {
      latestByConvo.set(m.conversationId, { direction: m.direction, text: m.text, createdAt: m.createdAt.toISOString() });
    }
  }

  return rows
    .map((c) => {
      const activityAt = Math.max(c.lastInboundAt?.getTime() ?? 0, c.lastOutboundAt?.getTime() ?? 0, c.createdAt.getTime());
      return {
        id: c.id,
        channel: c.channel,
        externalId: c.externalId,
        status: c.status,
        paused: isPaused(c),
        windowOpen: windowOpen(c.lastInboundAt),
        version: c.version,
        fields: c.fields,
        lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
        lastOutboundAt: c.lastOutboundAt?.toISOString() ?? null,
        staffUntil: c.staffUntil?.toISOString() ?? null,
        openDueId: c.openDueId ?? null,
        createdAt: c.createdAt.toISOString(),
        latestMessage: latestByConvo.get(c.id) ?? null,
        _activityAt: activityAt,
      };
    })
    .sort((a, b) => {
      const sa = a.paused ? 0 : STATUS_ORDER[a.status];
      const sb = b.paused ? 0 : STATUS_ORDER[b.status];
      if (sa !== sb) return sa - sb;
      return b._activityAt - a._activityAt;
    })
    .map(({ _activityAt, ...item }) => {
      void _activityAt;
      return item;
    });
}

/** Full conversation detail: chronological messages, linked stay bookings, and any open/linked payment due. */
export async function conversationDetail(db: AnyDb, workspaceId: string, conversationId: string) {
  const [c] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, workspaceId)));
  if (!c) return null;

  const messages = await db
    .select({
      id: conversationMessages.id,
      direction: conversationMessages.direction,
      text: conversationMessages.text,
      uploadIds: conversationMessages.uploadIds,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, c.id))
    .orderBy(asc(conversationMessages.createdAt), asc(conversationMessages.id));

  const linkedBookings = await db
    .select({
      id: bookings.id,
      reference: bookings.reference,
      status: bookings.status,
      nights: bookings.nights,
      timezone: bookings.timezone,
      start: sql<Date>`lower(${bookings.during})`.mapWith((v: string | Date) => new Date(v)),
      end: sql<Date>`upper(${bookings.during})`.mapWith((v: string | Date) => new Date(v)),
    })
    .from(bookings)
    .where(and(eq(bookings.userId, workspaceId), eq(bookings.conversationId, c.id)))
    .orderBy(desc(bookings.createdAt));

  const [openDue] = c.openDueId
    ? await db
        .select({
          id: paymentDues.id,
          reference: paymentDues.reference,
          kind: paymentDues.kind,
          amountCentavos: paymentDues.amountCentavos,
          status: paymentDues.status,
          token: paymentDues.token,
          createdAt: paymentDues.createdAt,
        })
        .from(paymentDues)
        .where(and(eq(paymentDues.userId, workspaceId), eq(paymentDues.id, c.openDueId)))
    : [];

  return {
    id: c.id,
    channel: c.channel,
    externalId: c.externalId,
    status: c.status,
    paused: isPaused(c),
    windowOpen: windowOpen(c.lastInboundAt),
    version: c.version,
    fields: c.fields,
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: c.lastOutboundAt?.toISOString() ?? null,
    staffUntil: c.staffUntil?.toISOString() ?? null,
    openDueId: c.openDueId ?? null,
    createdAt: c.createdAt.toISOString(),
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      text: m.text,
      uploadIds: m.uploadIds,
      createdAt: m.createdAt.toISOString(),
    })),
    bookings: linkedBookings.map((b) => ({
      id: b.id,
      reference: b.reference,
      status: b.status,
      nights: b.nights,
      timezone: b.timezone,
      start: b.start.toISOString(),
      end: b.end.toISOString(),
    })),
    openDue: openDue
      ? {
          id: openDue.id,
          reference: openDue.reference,
          kind: openDue.kind,
          amountCentavos: openDue.amountCentavos,
          status: openDue.status,
          token: openDue.token,
          createdAt: openDue.createdAt.toISOString(),
        }
      : null,
  };
}

export async function takeOverConversation(db: AnyDb, workspaceId: string, conversationId: string) {
  const [updated] = await db
    .update(conversations)
    .set({ status: "staff", staffUntil: null })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, workspaceId)))
    .returning();
  return updated ?? null;
}

export async function handBackConversation(db: AnyDb, workspaceId: string, conversationId: string) {
  const [updated] = await db
    .update(conversations)
    .set({ status: "bot", staffUntil: null })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, workspaceId)))
    .returning();
  return updated ?? null;
}

export async function updateConversationFields(
  db: AnyDb,
  workspaceId: string,
  conversationId: string,
  patch: Partial<Record<(typeof CONVERSATION_FIELDS)[number], string>>,
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, workspaceId)))
      .for("update");
    if (!existing) return null;
    const next: Record<string, string> = { ...(existing.fields ?? {}) };
    for (const k of CONVERSATION_FIELDS) {
      if (!(k in patch)) continue;
      const v = patch[k]?.trim().slice(0, FIELD_MAX) ?? "";
      if (v) next[k] = v;
      else delete next[k];
    }
    const [updated] = await tx
      .update(conversations)
      .set({ fields: next })
      .where(eq(conversations.id, existing.id))
      .returning();
    return updated ?? null;
  });
}

export async function conversationSettings(db: AnyDb, workspaceId: string): Promise<ConversationSettings | null> {
  const [u] = await db
    .select({
      conversationRetentionDays: users.conversationRetentionDays,
      staffQuietHours: users.staffQuietHours,
      staffAlertPsid: users.staffAlertPsid,
    })
    .from(users)
    .where(eq(users.id, workspaceId));
  if (!u) return null;
  return {
    conversationRetentionDays: u.conversationRetentionDays,
    staffQuietHours: u.staffQuietHours,
    staffAlertPsid: u.staffAlertPsid ?? null,
  };
}

export async function saveConversationSettings(
  db: AnyDb,
  workspaceId: string,
  patch: { conversationRetentionDays?: number; staffQuietHours?: number; staffAlertPsid?: string | null },
): Promise<ConversationSettings | null> {
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.conversationRetentionDays !== undefined) set.conversationRetentionDays = patch.conversationRetentionDays;
  if (patch.staffQuietHours !== undefined) set.staffQuietHours = patch.staffQuietHours;
  if (patch.staffAlertPsid !== undefined) set.staffAlertPsid = patch.staffAlertPsid?.trim() || null;
  if (Object.keys(set).length === 0) return conversationSettings(db, workspaceId);
  const [u] = await db
    .update(users)
    .set(set)
    .where(eq(users.id, workspaceId))
    .returning({
      conversationRetentionDays: users.conversationRetentionDays,
      staffQuietHours: users.staffQuietHours,
      staffAlertPsid: users.staffAlertPsid,
    });
  if (!u) return null;
  return {
    conversationRetentionDays: u.conversationRetentionDays,
    staffQuietHours: u.staffQuietHours,
    staffAlertPsid: u.staffAlertPsid ?? null,
  };
}

/** Reports whether the staff Messenger PSID is within Meta's 24-hour window, or falling back to Telegram / email. */
export async function staffAlertStatus(db: AnyDb, workspaceId: string, now = Date.now()): Promise<StaffAlertStatus> {
  const [owner] = await db
    .select({ email: users.email, staffAlertPsid: users.staffAlertPsid })
    .from(users)
    .where(eq(users.id, workspaceId));
  const psid = owner?.staffAlertPsid?.trim() || null;

  const conns = await db
    .select({ provider: connections.provider, status: connections.status, destination: connections.destination })
    .from(connections)
    .where(and(eq(connections.userId, workspaceId), inArray(connections.provider, ["meta_messenger", "telegram"])));

  const metaConn = conns.find((c) => c.provider === "meta_messenger" && c.status === "active");
  const tgConn = conns.find((c) => c.provider === "telegram" && c.status === "active");
  const telegramReady = Boolean((tgConn?.destination as { chatId?: string } | null)?.chatId);

  let staffLastInbound: Date | null = null;
  if (psid) {
    const [staffConvo] = await db
      .select({ lastInboundAt: conversations.lastInboundAt })
      .from(conversations)
      .where(and(eq(conversations.userId, workspaceId), eq(conversations.channel, "messenger"), eq(conversations.externalId, psid)));
    staffLastInbound = staffConvo?.lastInboundAt ?? null;
  }

  const staffWindowOpen = Boolean(metaConn && psid && windowOpen(staffLastInbound, now));
  const staffWindowExpiresAt = staffLastInbound ? new Date(staffLastInbound.getTime() + WINDOW_MS).toISOString() : null;
  const activeChannel = staffWindowOpen ? "messenger" : telegramReady ? "telegram" : "email";

  return {
    staffAlertPsid: psid,
    messengerConnected: Boolean(metaConn),
    staffWindowOpen,
    staffWindowExpiresAt,
    telegramReady,
    emailFallback: owner?.email ?? null,
    activeChannel,
  };
}

/**
 * Alerts staff through Messenger (when configured and within the 24-hour window), else Telegram, else email.
 * Privacy rule: sends only first name, dates/guests, reason, and console link, never the full guest conversation.
 */
export async function sendStaffAlert(
  deps: { db: AnyDb; secretsKey: Buffer; mail: MailDeps; urls?: ProviderUrls; publicUrl?: string },
  opts: { workspaceId: string; conversationId: string; reason?: string },
): Promise<{ delivered: boolean; channel: "messenger" | "telegram" | "email"; fallbackReason?: string }> {
  const { db, secretsKey, mail } = deps;
  const urls = deps.urls ?? providerUrls();
  const [c] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, opts.conversationId), eq(conversations.userId, opts.workspaceId)));
  if (!c) return { delivered: false, channel: "email", fallbackReason: "conversation not found" };

  const [owner] = await db
    .select({ email: users.email, language: users.language, staffAlertPsid: users.staffAlertPsid })
    .from(users)
    .where(eq(users.id, opts.workspaceId));
  if (!owner) return { delivered: false, channel: "email", fallbackReason: "workspace not found" };

  const cleanAlertText = (raw: string, max: number) =>
    raw
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, max);

  const firstName = cleanAlertText(c.fields.name?.trim().split(/\s+/)[0] || "", 40) || "Guest";
  const stayBits = [
    c.fields.check_in ? cleanAlertText(c.fields.check_out ? `${c.fields.check_in} to ${c.fields.check_out}` : c.fields.check_in, 45) : "",
    c.fields.guests ? cleanAlertText(`${c.fields.guests} guests`, 30) : "",
  ].filter(Boolean);
  const channelLabel = c.channel === "messenger" ? "Messenger" : c.channel === "instagram" ? "Instagram" : c.channel === "telegram" ? "Telegram" : "Email";
  const reason = cleanAlertText(opts.reason ?? "", 120) || (owner.language === "tl" ? "Kailangan ng sagot ng staff" : "Needs staff reply");
  const base = deps.publicUrl?.replace(/\/+$/, "");
  const consoleLink = base ? `${base}/#/conversations` : "";
  const summary = stayBits.length > 0 ? `${firstName} (${channelLabel}, ${stayBits.join(", ")})` : `${firstName} (${channelLabel})`;
  const text =
    owner.language === "tl"
      ? `${summary}: ${reason}.${consoleLink ? ` Buksan ang Conversations: ${consoleLink}` : ""}`
      : `${summary}: ${reason}.${consoleLink ? ` Open Conversations: ${consoleLink}` : ""}`;

  const status = await staffAlertStatus(db, opts.workspaceId);
  let fallbackReason: string | undefined;

  if (status.activeChannel === "messenger" && status.staffAlertPsid) {
    try {
      const conn = await connectionCredential(db as never, secretsKey, opts.workspaceId, "meta_messenger");
      if (conn && conn.status === "active") {
        const { pageAccessToken } = parseMetaCredential(conn.credential);
        await metaSend(urls, pageAccessToken, { recipientId: status.staffAlertPsid, channel: "messenger", text });
        return { delivered: true, channel: "messenger" };
      }
    } catch (err) {
      fallbackReason = err instanceof Error ? err.message : String(err);
    }
  } else if (status.staffAlertPsid && status.messengerConnected && !status.staffWindowOpen) {
    fallbackReason = "Messenger staff 24-hour window is closed";
  }

  if (status.telegramReady) {
    try {
      const conn = await connectionCredential(db as never, secretsKey, opts.workspaceId, "telegram");
      const chatId = (conn?.destination as { chatId?: string } | null)?.chatId;
      if (conn && conn.status === "active" && chatId) {
        await telegramSend(urls, conn.credential, chatId, text);
        return { delivered: true, channel: "telegram", ...(fallbackReason ? { fallbackReason } : {}) };
      }
    } catch (err) {
      fallbackReason = err instanceof Error ? err.message : String(err);
    }
  }

  const subject = owner.language === "tl" ? `kymavo: Kailangan ng staff para kay ${firstName}` : `kymavo: Staff needed for ${firstName}`;
  await mail.installation.transport.sendMail({ from: mail.installation.from, to: owner.email, subject, text });
  return { delivered: true, channel: "email", ...(fallbackReason ? { fallbackReason } : {}) };
}

/** Finds a published manual deposit workflow in the workspace (with payment_due, preferring stay_quote + payment_due). */
export async function findDepositWorkflow(db: AnyDb, workspaceId: string, workflowId?: string) {
  const candidates = await db
    .select({ id: workflows.id, name: workflows.name })
    .from(workflows)
    .where(workflowId ? and(eq(workflows.userId, workspaceId), eq(workflows.id, workflowId)) : eq(workflows.userId, workspaceId))
    .orderBy(asc(workflows.createdAt));

  let dueOnly: { workflowId: string; versionId: string } | null = null;
  for (const w of candidates) {
    const version = await publishedVersion(db as never, w.id);
    if (!version) continue;
    const parsed = definitionSchema.safeParse(version.definition);
    if (!parsed.success || parsed.data.trigger.type !== "manual") continue;
    const hasDue = parsed.data.steps.some((s) => s.type === "payment_due");
    if (!hasDue) continue;
    const hasQuote = parsed.data.steps.some((s) => s.type === "stay_quote");
    if (hasQuote) return { workflowId: w.id, versionId: version.id };
    dueOnly ??= { workflowId: w.id, versionId: version.id };
  }
  return dueOnly;
}
