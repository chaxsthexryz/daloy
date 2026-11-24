import { randomBytes } from "node:crypto";
import { backoffDelayMs, FILE_MIME, type FileRef, type Menu, type RetryPolicy } from "@daloy/engine";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { connectionCredential, markConnectionFailed, PROVIDER_NAMES, SMS_NOT_SET_UP, unismsConfig } from "./connections";
import { withGoogle } from "./google-access";
import { freshToken, oauthProvider, slackToken, trelloAuthOf, withFreshToken, withRecordAuth } from "./oauth";
import type { Db } from "./index";
import { discordPost } from "./discord";
import { airtableAdd, appendRowsOnce, driveUpload, type DriveDestination, notionAddPage, trelloAddCard, deleteSheetMarker, outlookSend, ProviderError, slackPost, syncCalendarEvent, teamsPost, telegramSend, unismsSend, type CalendarDestination, type OutlookMessage, type ProviderErrorKind, type ProviderUrls, type SheetDestination } from "./providers";
import { supersededSql } from "./bookings";
import { runSuperseded } from "./conversations";
import { bookingForCalendar } from "./calendar";
import { metaSend, parseMetaCredential } from "./meta";
import { parseWhatsAppCredential, whatsappSend } from "./whatsapp";
import { createShopifyProduct, parseShopifyCredential, shopifyConn, updateShopifyProduct, type ShopifyProductFields } from "./shopify";
import { bookings, calendarEvents, connections, deliveries, runs, users, type Provider } from "./schema";
import { readUpload } from "./uploads";
import { claimUsage, QuotaError, refundUsage } from "./usage";

/**
 * Sheets rows, Slack and Teams notes and Outlook emails, delivered by the worker apart from the run that asked for them
 * (decisions 0021 and 0023).
 *
 *   queued -> sending -> delivered
 *                     -> queued        (quota, provider down, or Sheets ambiguous: try later, look first)
 *                     -> needs_review  (Slack, Teams or Outlook ambiguous: an operator checks the channel or Sent Items)
 *                     -> failed        (auth, permission, bad request, or the last attempt)
 *   failed -> queued (Retry); needs_review -> queued (Post again) or delivered (Mark as posted)
 *
 * A delivery is pinned to the connection's account and destination when it is queued. If the owner reconnects
 * elsewhere before it is sent, it waits for review instead of following the new connection (decision 0021).
 */
export type Delivery = typeof deliveries.$inferSelect;
export type DeliveryPayload = Delivery["payload"];
/** What the last failure was, as a closed value (decision 0039). */
export type DeliveryErrorKind = ProviderErrorKind | "not_connected" | "reconnect" | "no_destination" | "destination_changed" | "queued_before_pin" | "booking_changed" | "plan_quota";
/** pinnedAccount of every UniSMS delivery: the server's own key sends them all (decision 0100). */
const SHARED_UNISMS_ACCOUNT = "__operator_shared__";

export const DELIVERY_POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 10 * 60_000 };
/** A delivery still "sending" after this long belongs to a worker that died mid-call. Well above a call's timeouts. */
const STALE_SENDING = "2 minutes";

/** Why a delivery of a run whose booking moved on was not sent, shown in the Requests list. */
export const BOOKING_CHANGED = "The booking was rescheduled or cancelled, so this was not sent.";
export const NEWER_MESSAGE = "The customer sent a newer message, so this was not sent; the run for the newer message answers instead.";
export const PAST_WINDOW = "Past Meta's 24-hour reply window. Reply directly from your Facebook Page or Instagram inbox.";

/** A delivery of a run whose booking moved on: Retry and Post again leave it alone. A calendar sync is the exception: a changed booking is what it syncs. */
const bookingMoved = sql`(${deliveries.provider} <> 'google_calendar' and exists (select 1 from ${runs} where ${runs.id} = ${deliveries.runId} and ${supersededSql}))`;

/** Sheets and Calendar writes can be repeated safely, so an unknown outcome is looked at again, never sent to a person. */
const repeatable = (d: Pick<Delivery, "provider" | "payload">) => d.provider === "google_sheets" || d.provider === "google_calendar" || (d.provider === "shopify" && shopifyRepeatable(d.payload as ShopifyPayload));

/**
 * I2 (decision 0105): a Shopify product step. An update sets values, so it can run again. A create can only run again
 * when it has a SKU, which is how a retry finds the product an earlier attempt made; without one a person decides.
 */
export type ShopifyPayload = { shopify: "create" | "update"; by?: "id" | "sku"; product?: string; fields: ShopifyProductFields };
const shopifyRepeatable = (p: ShopifyPayload) => p.shopify === "update" || Boolean(p.fields.sku);

/** A short random marker value for a Sheets write; with the id it tells our marker from anyone else's. */
const markerValue = () => randomBytes(6).toString("base64url");

/**
 * Called by the sheets, slack, outlook and teams steps. One row per run and step: a step that runs again gets the
 * first row back. Pins the connection as it is now; an empty pin means nothing was connected yet, pinned on first send.
 */
export async function queueDelivery(db: Pick<Db, "select" | "insert">, d: { userId: string; runId: string; stepId: string; provider: Provider; reference: string; payload: DeliveryPayload }): Promise<Delivery> {
  // SMS never reads a workspace connection row: the server's env is the only source (decision 0100).
  const operator = d.provider === "unisms" ? unismsConfig() : null;
  const [conn] = d.provider === "unisms" ? [] : await db.select({ account: connections.account, destination: connections.destination, externalId: connections.externalId }).from(connections).where(and(eq(connections.userId, d.userId), eq(connections.provider, d.provider)));
  const pinnedAccount = conn?.account ?? (d.provider === "unisms" ? SHARED_UNISMS_ACCOUNT : "");
  const pinnedDestination = conn?.destination ?? (operator ? { senderId: operator.senderId } : null);
  const sheet = d.provider === "google_sheets" ? { sheetMetaId: sql<number>`nextval('sheet_meta_seq')`, sheetMetaValue: markerValue() } : {};
  await db
    .insert(deliveries)
    .values({ ...d, pinnedAccount, pinnedDestination, pinnedExternalId: conn?.externalId ?? null, ...sheet })
    .onConflictDoNothing({ target: [deliveries.runId, deliveries.stepId] });
  const [row] = await db.select().from(deliveries).where(and(eq(deliveries.runId, d.runId), eq(deliveries.stepId, d.stepId)));
  return row!;
}

/**
 * Claims due deliveries. SKIP LOCKED hands each one to a single worker. A claim taken back from a dead worker sets
 * checkFirst, since that worker may have reached the provider before it died.
 */
export async function claimDueDeliveries(db: Db, limit = 10): Promise<Delivery[]> {
  const due = db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(sql`(${deliveries.state} = 'queued' and ${deliveries.nextAttemptAt} <= now()) or (${deliveries.state} = 'sending' and ${deliveries.updatedAt} < now() - ${STALE_SENDING}::interval)`)
    .orderBy(deliveries.nextAttemptAt)
    .limit(limit)
    .for("update", { skipLocked: true });
  return db
    .update(deliveries)
    // Taking back a "sending" claim means its worker may have sent the request and died: that request may still land,
    // so the delivery is uncertain from here on. Recorded in the same UPDATE as the claim, so no crash can skip it.
    .set({
      state: "sending",
      claimId: sql`gen_random_uuid()`,
      attempts: sql`${deliveries.attempts} + 1`,
      checkFirst: sql`${deliveries.checkFirst} or ${deliveries.state} = 'sending'`,
      sheetMarkerUncertain: sql`${deliveries.sheetMarkerUncertain} or ${deliveries.state} = 'sending'`,
      updatedAt: sql`now()`,
    })
    .where(inArray(deliveries.id, due))
    .returning();
}

type Outcome =
  | { state: "delivered"; result: NonNullable<Delivery["result"]> }
  | { state: "failed" | "needs_review"; error: string; kind: DeliveryErrorKind }
  | { state: "queued"; error: string; kind: DeliveryErrorKind; retryAfterMs?: number; checkFirst?: boolean };

/**
 * One attempt at a claimed delivery. Never throws for provider trouble: the outcome is written to the row. null means
 * the claim was lost before anything was sent, so there is nothing to record.
 */
async function attempt(db: Db, key: Buffer, urls: ProviderUrls, d: Delivery): Promise<Outcome | null> {
  const name = PROVIDER_NAMES[d.provider];
  // UniSMS is sent with the server's key only. A workspace's stored key is never read, whatever this delivery was pinned to.
  let conn = d.provider === "unisms" ? null : await connectionCredential(db, key, d.userId, d.provider);
  let usingShared = false;
  if (d.provider === "unisms") {
    const operator = unismsConfig();
    if (!operator) return { state: "failed", error: SMS_NOT_SET_UP, kind: "not_connected" };
    const [u] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, d.userId));
    if (u?.plan === "preview") {
      return { state: "failed", error: "SMS sending is not included on the Preview plan. Ask kymavo to move you to a paid plan.", kind: "plan_quota" };
    }
    usingShared = true;
    conn = {
      credential: operator.secretKey,
      status: "active",
      account: SHARED_UNISMS_ACCOUNT,
      destination: { senderId: operator.senderId },
      revision: "",
      authMethod: "token",
      externalId: null,
    };
  }
  if (!conn) return { state: "failed", error: `${name} is not connected. Connect it in Apps, then retry.`, kind: "not_connected" };
  if (conn.status === "failed") return { state: "failed", error: `${name} needs to be connected again (${conn.account}). Reconnect it in Apps, then retry.`, kind: "reconnect" };
  if (!conn.destination) return { state: "failed", error: `No ${d.provider === "google_sheets" ? "sheet" : d.provider === "google_calendar" ? "calendar" : d.provider === "google_drive" ? "folder" : d.provider === "telegram" ? "chat" : d.provider === "airtable" ? "table" : d.provider === "notion" ? "database" : d.provider === "trello" ? "list" : d.provider === "unisms" ? "Sender ID" : d.provider === "meta_messenger" ? "page" : "channel"} is chosen for ${name}. Pick one in Apps, then retry.`, kind: "no_destination" };
  if (d.pinnedAccount === null) {
    return { state: "needs_review", error: `This was queued before kymavo recorded where deliveries go, so it cannot confirm the ${name} destination. Choose Post again to send it to ${describe(d.provider, conn.destination)}, or Mark as posted.`, kind: "queued_before_pin" };
  }
  if (d.pinnedAccount === "") {
    // Nothing was connected when it was queued: this connection is the first, so pin it now.
    const pinned = await db.update(deliveries).set({ pinnedAccount: conn.account, pinnedDestination: conn.destination, pinnedExternalId: conn.externalId }).where(heldBy(d)).returning({ id: deliveries.id });
    // Another worker took the claim over while this one was pinning: that one pins and sends, this one must not (Astra, 8e2c5d8).
    if (pinned.length === 0) return null;
  } else if ((!destinationOnly(d.provider, conn.authMethod) && !sameAccount(d, conn)) || !sameDestination(d.pinnedDestination, conn.destination)) {
    return {
      state: "needs_review",
      error: d.provider === "google_calendar"
        ? `The calendar connection changed since this event was created: it is still in ${describe(d.provider, d.pinnedDestination ?? {})}, and ${describe(d.provider, conn.destination)} is chosen now. Nothing was written to the new one. Choose Post again to write this change to the new calendar, or Mark as posted.`
        : `The ${name} connection changed since this was queued (it was for ${describe(d.provider, d.pinnedDestination ?? {})}, now ${describe(d.provider, conn.destination)}). Nothing was sent to the new one. Choose ${d.provider === "unisms" || d.provider === "outlook" || d.provider === "meta_messenger" ? "Send again" : "Post again"} to send it there, or ${d.provider === "unisms" || d.provider === "outlook" || d.provider === "meta_messenger" ? "Mark as sent" : "Mark as posted"}.`,
      kind: "destination_changed",
    };
  }
  // A table name can be renamed and reused by a collaborator, so only a table id is trusted.
  if (d.provider === "airtable" && !conn.destination.tableId?.startsWith("tbl")) {
    return { state: "failed", kind: "reconnect", error: "Airtable is connected by table name, which can point to another table after a rename. Reconnect Airtable with the table id (it starts with tbl), then retry." };
  }
  // Slack, Teams, Outlook and UniSMS have no read access to check with, so after a call that may have arrived a person decides.
  if (d.checkFirst && !repeatable(d)) {
    return { state: "needs_review", error: `${name} may have ${verb(d.provider)} this before the connection dropped. ${reviewHint(d.provider, conn.destination)}`, kind: "ambiguous" };
  }
  const activeConn = conn;
  const destination = activeConn.destination!;
  const oauth = activeConn.authMethod === "oauth" ? oauthProvider(d.provider) : undefined;
  let smsClaimNow: Date | undefined;
  let smsSent = false;
  // null: the claim was lost partway through a Drive save, so the new holder owns what happens next.
  const send = async (tx: Pick<Db, "select" | "update" | "insert">): Promise<Outcome | null> => {
    if (d.provider === "unisms") {
      const p = d.payload as { to: string; message: string; senderId?: string };
      // A step never overrides the operator's UNISMS_SENDER_ID (H2).
      const senderId = destination.senderId!;
      try {
        const res = await unismsSend(urls, activeConn.credential, { recipient: p.to, content: p.message, senderId, metadata: { reference: d.reference, deliveryId: d.id } }, { shared: usingShared });
        smsSent = true;
        return { state: "delivered", result: res };
      } catch (err) {
        // Keep the quota claim committed when UniSMS may have sent the SMS (timeout / 5xx after connect).
        if (err instanceof ProviderError && err.kind === "ambiguous") {
          return { state: "needs_review", error: `${err.message} ${name} may have ${verb(d.provider)} it. ${reviewHint(d.provider, destination)}`, kind: err.kind };
        }
        throw err;
      }
    }
    if (d.provider === "google_sheets") {
      // Retrying the same marked write is safe: Google adds the row(s) at most once (decision 0021).
      const p = d.payload as { row?: string[]; rows?: string[][]; header?: string[] };
      const rows = p.rows ?? (p.row ? [p.row] : []);
      const out = await withGoogle(db, key, urls, d.userId, "google_sheets", activeConn, (auth) => appendRowsOnce(urls, auth, destination as SheetDestination, rows, { id: d.sheetMetaId!, value: d.sheetMetaValue! }, p.header));
      return { state: "delivered", result: { sheet: out.sheet, ...(p.rows ? { rows: out.rows } : {}), ...(out.headerWritten ? { headerWritten: true } : {}), ...(out.reconciled ? { reconciled: true } : {}) } };
    }
    if (d.provider === "google_calendar") {
      const { bookingId } = d.payload as { bookingId: string };
      const b = await bookingForCalendar(tx, d.userId, bookingId);
      if (!b) return { state: "failed", error: "The booking or its calendar event details are gone, so nothing was sent.", kind: "invalid" };
      const calendarId = (destination as CalendarDestination).calendarId;
      // A service account key or a Google sign-in, by the connection's auth_method (decision 0064).
      const out = await withGoogle(db, key, urls, d.userId, "google_calendar", activeConn, (auth) => syncCalendarEvent(urls, auth, calendarId, bookingId, b, b));
      await tx.update(calendarEvents).set({ account: activeConn.account, calendarId }).where(eq(calendarEvents.bookingId, bookingId));
      return { state: "delivered", result: { event: out.event, eventId: out.eventId } };
    }
    if (d.provider === "google_drive") {
      const { folderId, title } = destination as DriveDestination;
      const files = (d.payload as { files: FileRef[] }).files;
      // Files already saved by an earlier attempt (or before a Post again) are not saved twice.
      const saved: Record<string, string> = { ...((d.result as { saved?: Record<string, string> } | null)?.saved ?? {}) };
      for (const f of files) {
        if (saved[f.id]) continue;
        const up = await readUpload(db, { userId: d.userId, runId: d.runId, id: f.id });
        if (!up) return { state: "failed", error: `The file ${f.name} was removed after 7 days, so it cannot be saved now.`, kind: "invalid" };
        saved[f.id] = (await withGoogle(db, key, urls, d.userId, "google_drive", activeConn, (auth) => driveUpload(urls, auth, folderId, { name: `${d.reference} ${up.name}`, mimeType: FILE_MIME[up.type], data: up.data }))).id;
        // Written through db, not the transaction this runs in, so what is saved survives a later throw or rollback.
        const held = await db.update(deliveries).set({ result: { saved }, updatedAt: sql`now()` }).where(heldBy(d)).returning({ id: deliveries.id });
        if (held.length === 0) return null;
      }
      return { state: "delivered", result: { folder: title, saved, count: files.length } };
    }
    if (d.provider === "outlook") {
      // Outlook is always an OAuth grant (migration 0037), so oauth is set.
      return { state: "delivered", result: await withFreshToken(db, key, urls, d.userId, oauth!, activeConn, (token) => outlookSend(urls, token, d.payload as OutlookMessage)) };
    }
    // Airtable, Notion and Trello add one record, page or card. None can be asked "did this land?", so an unknown outcome is a person's call.
    const p = d.payload as { text: string; fields: Record<string, string>; title: string; name: string; desc?: string };
    // A pasted credential is used as it is stored; an OAuth grant is refreshed first and its access token sent (decision 0062).
    const auth = <T>(fn: (credential: string) => Promise<T>) => withRecordAuth(db, key, urls, d.userId, oauth, activeConn, fn);
    if (d.provider === "airtable") return { state: "delivered", result: await auth((t) => airtableAdd(urls, t, destination as { baseId: string; tableId: string }, p.fields)) };
    if (d.provider === "notion") return { state: "delivered", result: await auth((t) => notionAddPage(urls, t, destination as { databaseId: string; titleProperty: string }, p.title, p.fields)) };
    if (d.provider === "trello") return { state: "delivered", result: await auth((t) => trelloAddCard(urls, trelloAuthOf(activeConn.authMethod, t), destination.listId!, p.name, p.desc ?? "")) };
    if (d.provider === "shopify") {
      const s = d.payload as ShopifyPayload;
      const conn = await shopifyConn(urls, destination.shop!, parseShopifyCredential(activeConn.credential));
      const out = s.shopify === "create" ? await createShopifyProduct(urls, conn, { ...s.fields, title: s.fields.title ?? "" }, { retrying: d.checkFirst }) : await updateShopifyProduct(urls, conn, { by: s.by ?? "id", key: s.product ?? "" }, s.fields);
      return { state: "delivered", result: out };
    }
    const text = p.text;
    if (d.provider === "discord") return { state: "delivered", result: await discordPost(urls, activeConn.credential, text) };
    if (d.provider === "teams") return { state: "delivered", result: await teamsPost(urls, activeConn.credential, text) };
    // A reply (T9) carries the sender's chat, which the step already checked against the run's message.
    if (d.provider === "telegram") return { state: "delivered", result: await telegramSend(urls, activeConn.credential, (d.payload as { chatId?: string }).chatId ?? destination.chatId!, text) };
    if (d.provider === "meta_messenger") {
      const m = d.payload as {
        recipientId?: string;
        channel?: string;
        text?: string;
        quickReplies?: Menu;
        inboundTimestamp?: string;
        receivingPageId?: string;
        receivingInstagramAccountId?: string;
      };
      if (!m.recipientId || !m.text) return { state: "failed", error: "Missing recipient or message text for Meta reply.", kind: "invalid" };
      if (
        (m.receivingPageId && destination.pageId !== m.receivingPageId) ||
        (m.channel === "instagram" && m.receivingInstagramAccountId && destination.instagramAccountId !== m.receivingInstagramAccountId)
      ) {
        return {
          state: "needs_review",
          error: `The ${name} connection changed since this message arrived, so it cannot be sent from ${describe(d.provider, destination)}.`,
          kind: "destination_changed",
        };
      }
      const inboundAt = m.inboundTimestamp ? Date.parse(m.inboundTimestamp) : Number.NaN;
      if (Number.isFinite(inboundAt) && Date.now() - inboundAt > 24 * 3600_000) {
        return { state: "failed", error: PAST_WINDOW, kind: "invalid" };
      }
      const { pageAccessToken } = parseMetaCredential(activeConn.credential);
      return { state: "delivered", result: await metaSend(urls, pageAccessToken, { recipientId: m.recipientId, channel: m.channel, text: m.text, quickReplies: m.quickReplies }) };
    }
    if (d.provider === "whatsapp") {
      const w = d.payload as {
        mode?: "text" | "template";
        to?: string;
        text?: string;
        quickReplies?: Menu;
        templateName?: string;
        templateLanguage?: string;
        templateParams?: string[];
        inboundTimestamp?: string;
        receivingPhoneNumberId?: string;
      };
      if (!destination.phoneNumberId || !w.to) {
        return { state: "failed", error: "Missing recipient or phone number configuration for WhatsApp.", kind: "invalid" };
      }
      if (w.receivingPhoneNumberId && destination.phoneNumberId !== w.receivingPhoneNumberId) {
        return {
          state: "needs_review",
          error: `The ${name} connection changed since this message arrived, so it cannot be sent from ${describe(d.provider, destination)}.`,
          kind: "destination_changed",
        };
      }
      const mode = w.mode ?? "text";
      if (mode === "text") {
        const inboundAt = w.inboundTimestamp ? Date.parse(w.inboundTimestamp) : Number.NaN;
        if (Number.isFinite(inboundAt) && Date.now() - inboundAt > 24 * 3600_000) {
          return { state: "failed", error: "Past WhatsApp's 24-hour service window. Use an approved utility template instead.", kind: "invalid" };
        }
        if (!w.text) return { state: "failed", error: "Missing message text for WhatsApp service reply.", kind: "invalid" };
        const { accessToken } = parseWhatsAppCredential(activeConn.credential);
        return { state: "delivered", result: await whatsappSend(urls, accessToken, destination.phoneNumberId, { mode: "text", to: w.to, text: w.text, quickReplies: w.quickReplies }) };
      }
      if (!w.templateName) return { state: "failed", error: "Missing WhatsApp template name.", kind: "invalid" };
      const { accessToken } = parseWhatsAppCredential(activeConn.credential);
      return {
        state: "delivered",
        result: await whatsappSend(urls, accessToken, destination.phoneNumberId, {
          mode: "template",
          to: w.to,
          templateName: w.templateName,
          templateLanguage: w.templateLanguage,
          templateParams: w.templateParams,
        }),
      };
    }
    return { state: "delivered", result: await slackPost(urls, slackToken(activeConn), destination.channelId!, text) };
  };
  try {
    // An expiring OAuth token is refreshed before the booking-lock transaction opens, so the common refresh never needs
    // a second pool connection while the transaction holds one (decision 0058).
    if (oauth) await freshToken(db, key, urls, d.userId, oauth, activeConn);
    // Reserve SMS quota durably before opening the booking-lock transaction or calling UniSMS (M1).
    if (d.provider === "unisms") {
      smsClaimNow = new Date();
      await claimUsage(db, d.userId, "sms", { n: 1, key: `delivery:${d.id}`, now: smsClaimNow });
    }
    // The run's booking link as it is now (its own booking step may have moved it), checked under a share lock held
    // until the provider answers: a cancel or reschedule either committed before this check (nothing is sent) or waits
    // for the call to return (decision 0032).
    const outcome = await db.transaction(async (tx) => {
      const [run] = await tx.select({ bookingId: runs.bookingId, bookingVersion: runs.bookingVersion, conversationId: runs.conversationId, conversationVersion: runs.conversationVersion }).from(runs).where(eq(runs.id, d.runId));
      // A newer guest message moves the conversation on the same way (decision 0115): the newer run answers instead.
      const why = run && d.provider !== "google_calendar" ? await runSuperseded(tx, run, true) : false;
      if (why) {
        const said = why === "conversation" ? NEWER_MESSAGE : BOOKING_CHANGED;
        return { state: "failed", error: d.checkFirst ? `${said} An earlier attempt may have reached ${name}.` : said, kind: "booking_changed" } as const;
      }
      // Shared lock on the booking until Google answers, so a cancel cannot commit under an older write (decision 0055).
      if (d.provider === "google_calendar") await tx.execute(sql`select 1 from ${bookings} where ${bookings.id} = ${(d.payload as { bookingId: string }).bookingId} for share`);
      return send(tx);
    });
    if (d.provider === "unisms" && outcome && outcome.state === "failed" && outcome.kind === "booking_changed" && smsClaimNow) {
      await refundUsage(db, d.userId, "sms", { n: 1, key: `delivery:${d.id}`, now: smsClaimNow });
    }
    return outcome;
  } catch (err) {
    if (err instanceof QuotaError) {
      return { state: "failed", error: err.message, kind: "plan_quota" };
    }
    if (d.provider === "unisms") {
      if (smsSent) {
        return { state: "needs_review", error: `${name} sent this SMS, but kymavo could not record the outcome right away. ${reviewHint(d.provider, destination)}`, kind: "ambiguous" };
      }
      if (smsClaimNow && err instanceof ProviderError && err.kind !== "ambiguous") {
        await refundUsage(db, d.userId, "sms", { n: 1, key: `delivery:${d.id}`, now: smsClaimNow });
      }
    }
    const e = err instanceof ProviderError ? err : new ProviderError(err instanceof Error ? err.message : String(err), "unavailable");
    switch (e.kind) {
      case "auth":
        if (!usingShared) await markConnectionFailed(db, d.userId, d.provider, e.message, activeConn.revision);
        return { state: "failed", error: e.message, kind: e.kind };
      case "permission":
      case "invalid":
        return { state: "failed", error: e.message, kind: e.kind };
      case "review":
        return { state: "needs_review", error: e.message, kind: e.kind };
      case "ambiguous":
        if (!repeatable(d)) return { state: "needs_review", error: `${e.message} ${name} may have ${verb(d.provider)} it. ${reviewHint(d.provider, destination)}`, kind: e.kind };
        return { state: "queued", error: e.message, kind: e.kind, checkFirst: true };
      case "quota":
      case "unavailable":
        return { state: "queued", error: e.message, kind: e.kind, retryAfterMs: e.retryAfterMs };
    }
  }
}

const verb = (p: Provider) => (p === "outlook" || p === "unisms" || p === "meta_messenger" ? "sent" : p === "google_drive" || p === "shopify" ? "saved" : "posted");

/** The destination as a person would name it, for review messages. */
function describe(provider: Provider, dest: Record<string, string>) {
  if (provider === "google_sheets") return `the sheet "${dest.title ?? dest.spreadsheetId}", tab "${dest.tab}"`;
  if (provider === "google_calendar") return `the calendar "${dest.title ?? dest.calendarId}"`;
  if (provider === "google_drive") return `the Drive folder "${dest.title ?? dest.folderId}"`;
  if (provider === "slack") return `#${dest.channelName ?? dest.channelId}`;
  if (provider === "telegram") return `the Telegram chat ${dest.chatTitle ?? dest.chatId}`;
  if (provider === "outlook") return dest.mailbox ?? "the Outlook mailbox";
  if (provider === "unisms") return `UniSMS (Sender ID: ${dest.senderId ?? "Unisoft"})`;
  if (provider === "airtable") return `the Airtable table ${dest.tableName ?? dest.tableId}`;
  if (provider === "notion") return `the Notion database ${dest.databaseTitle ?? dest.databaseId}`;
  if (provider === "trello") return `the Trello list ${dest.listName ?? dest.listId}`;
  if (provider === "meta_messenger") return `the Meta Page ${dest.pageName ?? dest.pageId}`;
  if (provider === "discord") return `the Discord channel ${dest.channelName ?? ""}`.trim();
  if (provider === "shopify") return `the Shopify store ${dest.shopName ?? dest.shop}`;
  return `the Teams channel ${dest.channelName ?? ""}`.trim();
}

/**
 * Sheets, Drive and Calendar pin only where data lands: the same spreadsheet and tab, folder or calendar id, reached
 * through another Google account or a service account replaced by a Google sign-in, is the same place (plan R7,
 * decisions 0060 and 0064). For Calendar this holds only while the connection is a Google sign-in, which can reach
 * only calendars kymavo created; a service account still compares the account as before. A different calendar id still
 * goes to review, so M11 holds.
 */
const destinationOnly = (p: Provider, method: string) => p === "google_sheets" || p === "google_drive" || (p === "google_calendar" && method === "oauth");

/** Same provider account: by its stable id when both sides have one (OAuth), otherwise by the account name as before. */
const sameAccount = (d: Delivery, conn: { account: string; externalId: string | null }) =>
  // Plan R7 (decision 0062): for these destination providers a table, database or list id names the place, so a paste
  // connection replaced by an OAuth one, or another sign-in, does not stop a delivery that still goes to the same place.
  DESTINATION_ONLY.has(d.provider) || (d.pinnedExternalId && conn.externalId ? d.pinnedExternalId === conn.externalId : d.pinnedAccount === conn.account);
const DESTINATION_ONLY = new Set<Provider>(["airtable", "notion", "trello"]);

/** Same place: the fields that pick where a delivery lands. Display names may change without moving anything. */
function sameDestination(a: Record<string, string> | null, b: Record<string, string>) {
  const where = (d: Record<string, string> | null) => JSON.stringify([d?.spreadsheetId, d?.calendarId, d?.folderId, d?.tab, d?.channelId, d?.chatId, d?.baseId, d?.tableId, d?.databaseId, d?.listId, d?.mailbox, d?.channelName, d?.senderId, d?.pageId, d?.instagramAccountId, d?.phoneNumberId, d?.shop]);
  return where(a) === where(b);
}

function reviewHint(provider: Provider, dest: Record<string, string>) {
  if (provider === "outlook") return `Look in Sent Items of ${dest.mailbox ?? "the mailbox"}, then choose Mark as sent or Send again.`;
  if (provider === "unisms") return `Check your UniSMS delivery logs (Sender ID ${dest.senderId ?? "Unisoft"}), then choose Mark as sent or Send again.`;
  if (provider === "meta_messenger") return `Check the inbox of ${describe(provider, dest)}, then choose Mark as sent or Send again.`;
  if (provider === "whatsapp") return `Check WhatsApp Manager for ${dest.verifiedName ?? dest.displayPhone ?? dest.phoneNumberId ?? "the number"}, then choose Mark as sent or Send again.`;
  if (provider === "shopify") return `Look under Products in the admin of ${describe(provider, dest)}, then choose Mark as posted or Post again.`;
  return `Check ${describe(provider, dest)}, then choose Mark as posted or Post again.`;
}

/**
 * Still this worker's claim. The claim id is new on every claim and never reused, so a worker whose claim expired, or
 * whose delivery was retried or posted again since, can no longer write (Astra, c05fa81). Attempt numbers are not
 * enough: Retry and Post again start them from zero.
 */
const heldBy = (d: Delivery) => and(eq(deliveries.id, d.id), eq(deliveries.state, "sending"), eq(deliveries.claimId, d.claimId!));

/** Writes the outcome, guarded by the claim, so a stale worker cannot overwrite a newer attempt. */
async function finish(db: Db, d: Delivery, o: Outcome) {
  const claim = heldBy(d);
  if (o.state === "delivered") {
    await db.update(deliveries).set({ state: "delivered", result: o.result, lastError: null, errorKind: null, checkFirst: false, updatedAt: sql`now()` }).where(claim);
    return;
  }
  const checkFirst = d.checkFirst || (o.state === "queued" && o.checkFirst === true);
  // An ambiguous answer: the request may still be applied later. Sticky (OR), so no outcome can clear it.
  const sheetMarkerUncertain = sql`${deliveries.sheetMarkerUncertain} or ${o.state === "queued" && o.checkFirst === true}`;
  if (o.state === "queued" && d.attempts < DELIVERY_POLICY.maxAttempts) {
    const retryAfterMs = o.retryAfterMs !== undefined ? Math.min(Math.max(0, o.retryAfterMs), DELIVERY_POLICY.maxDelayMs) : 0;
    const delay = Math.max(backoffDelayMs(d.attempts, DELIVERY_POLICY), retryAfterMs);
    await db.update(deliveries).set({ state: "queued", lastError: o.error, errorKind: o.kind, checkFirst, sheetMarkerUncertain, nextAttemptAt: new Date(Date.now() + delay), updatedAt: sql`now()` }).where(claim);
    return;
  }
  // The last attempt keeps checkFirst, so a manual Retry of an uncertain Sheets row still looks before writing.
  await db.update(deliveries).set({ state: o.state === "queued" ? "failed" : o.state, lastError: o.error, errorKind: o.kind, checkFirst, sheetMarkerUncertain, updatedAt: sql`now()` }).where(claim);
}

/** The worker's poll: claims what is due and delivers each one independently. */
export async function runDueDeliveries(db: Db, key: Buffer, urls: ProviderUrls) {
  const claimed = await claimDueDeliveries(db);
  await Promise.all(
    claimed.map(async (d) => {
      const o = await attempt(db, key, urls, d);
      if (o) await finish(db, d, o);
    }),
  );
  return claimed.length;
}

/**
 * Retry: queues a failed delivery again with a fresh set of attempts. postAgain is the operator's explicit choice for a
 * Slack message that may already be in the channel. One guarded UPDATE, so a double-click queues it once.
 */
export async function retryDelivery(db: Db, userId: string, id: string, { postAgain = false } = {}): Promise<boolean> {
  const from = postAgain ? sql`${deliveries.state} in ('failed', 'needs_review')` : sql`${deliveries.state} = 'failed'`;
  const done = await db
    .update(deliveries)
    .set({
      state: "queued",
      attempts: 0,
      nextAttemptAt: sql`now()`,
      lastError: null,
      errorKind: null,
      // Post again is the operator's explicit choice: it goes to the connection as it is now (pinned on the next
      // attempt), and a Sheets row gets a fresh marker, as the old one may sit in another sheet or belong to someone else.
      ...(postAgain
        ? {
            checkFirst: false,
            pinnedAccount: "",
            pinnedDestination: null,
            pinnedExternalId: null,
            sheetMetaId: sql`case when ${deliveries.provider} = 'google_sheets' then nextval('sheet_meta_seq') end`,
            sheetMetaValue: sql`case when ${deliveries.provider} = 'google_sheets' then ${markerValue()} end`,
          }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(deliveries.id, id), eq(deliveries.userId, userId), from, sql`not ${bookingMoved}`))
    .returning({ id: deliveries.id });
  return done.length === 1;
}

/** For a refused Retry or Post again: whether the delivery's run belongs to a booking that moved on. */
export async function deliveryBookingMoved(db: Db, userId: string, id: string): Promise<boolean> {
  const [row] = await db.select({ moved: bookingMoved }).from(deliveries).where(and(eq(deliveries.id, id), eq(deliveries.userId, userId)));
  return row?.moved === true;
}

/** Mark as posted: the operator found the message, so the delivery counts as done without sending it again. */
export async function confirmDelivery(db: Db, userId: string, id: string): Promise<boolean> {
  const done = await db
    .update(deliveries)
    .set({ state: "delivered", result: { confirmedBy: "operator" }, lastError: null, errorKind: null, checkFirst: false, updatedAt: sql`now()` })
    .where(and(eq(deliveries.id, id), eq(deliveries.userId, userId), eq(deliveries.state, "needs_review")))
    .returning({ id: deliveries.id });
  return done.length === 1;
}

/** The deliveries of the given runs, for the Requests list and run details. Payloads stay out: they can hold request details. */
export async function listDeliveries(db: Db, userId: string, runIds: string[]) {
  if (runIds.length === 0) return [];
  return db
    .select({
      id: deliveries.id,
      runId: deliveries.runId,
      stepId: deliveries.stepId,
      provider: deliveries.provider,
      reference: deliveries.reference,
      state: deliveries.state,
      checkFirst: deliveries.checkFirst,
      attempts: deliveries.attempts,
      result: deliveries.result,
      lastError: deliveries.lastError,
      errorKind: deliveries.errorKind,
      nextAttemptAt: deliveries.nextAttemptAt,
      updatedAt: deliveries.updatedAt,
    })
    .from(deliveries)
    .where(and(eq(deliveries.userId, userId), inArray(deliveries.runId, runIds)))
    .orderBy(deliveries.createdAt);
}

/** How long a Sheets marker outlives its delivery: well past any request Google could still be holding (decision 0021). */
export const SHEET_MARKER_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes the markers of Sheets deliveries done for longer than the retention time, a few at a time, but only of
 * deliveries whose every attempt got a definite answer: then no request of theirs can still be in flight, and the marker
 * is no longer needed. Markers of uncertain deliveries stay, so a request Google applies late is still refused. A marker whose
 * sheet is no longer reachable through the owner's connection is stamped cleared, since nobody can delete it now.
 * Google trouble leaves it for the next sweep. Returns how many were cleared.
 */
export async function clearSheetWriteKeys(db: Db, key: Buffer, urls: ProviderUrls, retentionMs = SHEET_MARKER_RETENTION_MS, limit = 20) {
  const due = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.provider, "google_sheets"),
        eq(deliveries.state, "delivered"),
        isNotNull(deliveries.sheetMetaId),
        isNull(deliveries.sheetMetaClearedAt),
        eq(deliveries.sheetMarkerUncertain, false),
        sql`${deliveries.updatedAt} < now() - make_interval(secs => ${retentionMs / 1000})`,
      ),
    )
    .orderBy(deliveries.updatedAt)
    .limit(limit);
  let cleared = 0;
  for (const d of due) {
    const conn = await connectionCredential(db, key, d.userId, "google_sheets");
    const spreadsheetId = (d.pinnedDestination as SheetDestination | null)?.spreadsheetId;
    try {
      if (conn && spreadsheetId && (conn.destination as SheetDestination | null)?.spreadsheetId === spreadsheetId) {
        await withGoogle(db, key, urls, d.userId, "google_sheets", conn, (auth) => deleteSheetMarker(urls, auth, spreadsheetId, { id: d.sheetMetaId!, value: d.sheetMetaValue! }));
      }
      await db.update(deliveries).set({ sheetMetaClearedAt: sql`now()` }).where(eq(deliveries.id, d.id));
      cleared++;
    } catch {
      // Google unavailable or refusing: try again on the next sweep.
    }
  }
  return cleared;
}
