import { randomBytes } from "node:crypto";
import { backoffDelayMs, type RetryPolicy } from "@daloy/engine";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { connectionCredential, markConnectionFailed, PROVIDER_NAMES, rotateInto } from "./connections";
import type { Db } from "./index";
import { appendRowOnce, deleteSheetMarker, outlookSend, ProviderError, serviceAccountSchema, slackPost, teamsPost, type OutlookMessage, type ProviderUrls, type SheetDestination } from "./providers";
import { bookingSuperseded, supersededSql } from "./bookings";
import { connections, deliveries, runs, type Provider } from "./schema";

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

export const DELIVERY_POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 10 * 60_000 };
/** A delivery still "sending" after this long belongs to a worker that died mid-call. Well above a call's timeouts. */
const STALE_SENDING = "2 minutes";

/** Why a delivery of a run whose booking moved on was not sent, shown in the Requests list. */
export const BOOKING_CHANGED = "The booking was rescheduled or cancelled, so this was not sent.";

/** A delivery of a run whose booking moved on: Retry and Post again leave it alone. */
const bookingMoved = sql`exists (select 1 from ${runs} where ${runs.id} = ${deliveries.runId} and ${supersededSql})`;

/** A short random marker value for a Sheets write; with the id it tells our marker from anyone else's. */
const markerValue = () => randomBytes(6).toString("base64url");

/**
 * Called by the sheets, slack, outlook and teams steps. One row per run and step: a step that runs again gets the
 * first row back. Pins the connection as it is now; an empty pin means nothing was connected yet, pinned on first send.
 */
export async function queueDelivery(db: Db, d: { userId: string; runId: string; stepId: string; provider: Provider; reference: string; payload: DeliveryPayload }): Promise<Delivery> {
  const [conn] = await db.select({ account: connections.account, destination: connections.destination }).from(connections).where(and(eq(connections.userId, d.userId), eq(connections.provider, d.provider)));
  const sheet = d.provider === "google_sheets" ? { sheetMetaId: sql<number>`nextval('sheet_meta_seq')`, sheetMetaValue: markerValue() } : {};
  await db
    .insert(deliveries)
    .values({ ...d, pinnedAccount: conn?.account ?? "", pinnedDestination: conn?.destination ?? null, ...sheet })
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
  | { state: "delivered"; result: Record<string, string | boolean> }
  | { state: "failed" | "needs_review"; error: string }
  | { state: "queued"; error: string; retryAfterMs?: number; checkFirst?: boolean };

/**
 * One attempt at a claimed delivery. Never throws for provider trouble: the outcome is written to the row. null means
 * the claim was lost before anything was sent, so there is nothing to record.
 */
async function attempt(db: Db, key: Buffer, urls: ProviderUrls, d: Delivery): Promise<Outcome | null> {
  const name = PROVIDER_NAMES[d.provider];
  const conn = await connectionCredential(db, key, d.userId, d.provider);
  if (!conn) return { state: "failed", error: `${name} is not connected. Connect it in Apps, then retry.` };
  if (conn.status === "failed") return { state: "failed", error: `${name} needs to be connected again (${conn.account}). Reconnect it in Apps, then retry.` };
  if (!conn.destination) return { state: "failed", error: `No ${d.provider === "google_sheets" ? "sheet" : "channel"} is chosen for ${name}. Pick one in Apps, then retry.` };
  if (d.pinnedAccount === null) {
    return { state: "needs_review", error: `This was queued before Daloy recorded where deliveries go, so it cannot confirm the ${name} destination. Choose Post again to send it to ${describe(d.provider, conn.destination)}, or Mark as posted.` };
  }
  if (d.pinnedAccount === "") {
    // Nothing was connected when it was queued: this connection is the first, so pin it now.
    const pinned = await db.update(deliveries).set({ pinnedAccount: conn.account, pinnedDestination: conn.destination }).where(heldBy(d)).returning({ id: deliveries.id });
    // Another worker took the claim over while this one was pinning: that one pins and sends, this one must not (Astra, 8e2c5d8).
    if (pinned.length === 0) return null;
  } else if (d.pinnedAccount !== conn.account || !sameDestination(d.pinnedDestination, conn.destination)) {
    return {
      state: "needs_review",
      error: `The ${name} connection changed since this was queued (it was for ${describe(d.provider, d.pinnedDestination ?? {})}, now ${describe(d.provider, conn.destination)}). Nothing was sent to the new one. Choose Post again to send it there, or Mark as posted.`,
    };
  }
  // Slack, Teams and Outlook have no read access to check with, so after a call that may have arrived a person decides.
  if (d.checkFirst && d.provider !== "google_sheets") {
    return { state: "needs_review", error: `${name} may have ${d.provider === "outlook" ? "sent" : "posted"} this before the connection dropped. ${reviewHint(d.provider, conn.destination)}` };
  }
  const destination = conn.destination;
  const send = async (): Promise<Outcome> => {
    if (d.provider === "google_sheets") {
      const sa = serviceAccountSchema.parse(JSON.parse(conn.credential));
      // Retrying the same marked write is safe: Google adds the row at most once (decision 0021).
      const out = await appendRowOnce(urls, sa, conn.destination as SheetDestination, (d.payload as { row: string[] }).row, { id: d.sheetMetaId!, value: d.sheetMetaValue! });
      return { state: "delivered", result: out.reconciled ? { sheet: out.sheet, reconciled: true } : { sheet: out.sheet } };
    }
    if (d.provider === "outlook") {
      const save = rotateInto(db, key, d.userId, "outlook", conn);
      return { state: "delivered", result: await outlookSend(urls, conn.credential, save, d.payload as OutlookMessage) };
    }
    const text = (d.payload as { text: string }).text;
    if (d.provider === "teams") return { state: "delivered", result: await teamsPost(urls, conn.credential, text) };
    return { state: "delivered", result: await slackPost(urls, conn.credential, destination.channelId!, text) };
  };
  try {
    // The run's booking link as it is now (its own booking step may have moved it), checked under a share lock held
    // until the provider answers: a cancel or reschedule either committed before this check (nothing is sent) or waits
    // for the call to return (decision 0032).
    return await db.transaction(async (tx) => {
      const [run] = await tx.select({ bookingId: runs.bookingId, bookingVersion: runs.bookingVersion }).from(runs).where(eq(runs.id, d.runId));
      if (run && (await bookingSuperseded(tx, run, true))) {
        return { state: "failed", error: d.checkFirst ? `${BOOKING_CHANGED} An earlier attempt may have reached ${name}.` : BOOKING_CHANGED } as const;
      }
      return send();
    });
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError(err instanceof Error ? err.message : String(err), "unavailable");
    switch (e.kind) {
      case "auth":
        await markConnectionFailed(db, d.userId, d.provider, e.message, conn.revision);
        return { state: "failed", error: e.message };
      case "permission":
      case "invalid":
        return { state: "failed", error: e.message };
      case "review":
        return { state: "needs_review", error: e.message };
      case "ambiguous":
        if (d.provider !== "google_sheets") return { state: "needs_review", error: `${e.message} ${name} may have ${d.provider === "outlook" ? "sent" : "posted"} it. ${reviewHint(d.provider, conn.destination)}` };
        return { state: "queued", error: e.message, checkFirst: true };
      case "quota":
      case "unavailable":
        return { state: "queued", error: e.message, retryAfterMs: e.retryAfterMs };
    }
  }
}

/** The destination as a person would name it, for review messages. */
function describe(provider: Provider, dest: Record<string, string>) {
  if (provider === "google_sheets") return `the sheet "${dest.title ?? dest.spreadsheetId}", tab "${dest.tab}"`;
  if (provider === "slack") return `#${dest.channelName ?? dest.channelId}`;
  if (provider === "outlook") return dest.mailbox ?? "the Outlook mailbox";
  return `the Teams channel ${dest.channelName ?? ""}`.trim();
}

/** Same place: the fields that pick where a delivery lands. Display names may change without moving anything. */
function sameDestination(a: Record<string, string> | null, b: Record<string, string>) {
  const where = (d: Record<string, string> | null) => JSON.stringify([d?.spreadsheetId, d?.tab, d?.channelId, d?.mailbox, d?.channelName]);
  return where(a) === where(b);
}

function reviewHint(provider: Provider, dest: Record<string, string>) {
  if (provider === "outlook") return `Look in Sent Items of ${dest.mailbox ?? "the mailbox"}, then choose Mark as sent or Send again.`;
  return `Check ${provider === "slack" ? `#${dest.channelName ?? dest.channelId}` : `the Teams channel ${dest.channelName ?? ""}`.trim()}, then choose Mark as posted or Post again.`;
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
    await db.update(deliveries).set({ state: "delivered", result: o.result, lastError: null, checkFirst: false, updatedAt: sql`now()` }).where(claim);
    return;
  }
  const checkFirst = d.checkFirst || (o.state === "queued" && o.checkFirst === true);
  // An ambiguous answer: the request may still be applied later. Sticky (OR), so no outcome can clear it.
  const sheetMarkerUncertain = sql`${deliveries.sheetMarkerUncertain} or ${o.state === "queued" && o.checkFirst === true}`;
  if (o.state === "queued" && d.attempts < DELIVERY_POLICY.maxAttempts) {
    const delay = Math.max(backoffDelayMs(d.attempts, DELIVERY_POLICY), o.retryAfterMs ?? 0);
    await db.update(deliveries).set({ state: "queued", lastError: o.error, checkFirst, sheetMarkerUncertain, nextAttemptAt: new Date(Date.now() + delay), updatedAt: sql`now()` }).where(claim);
    return;
  }
  // The last attempt keeps checkFirst, so a manual Retry of an uncertain Sheets row still looks before writing.
  await db.update(deliveries).set({ state: o.state === "queued" ? "failed" : o.state, lastError: o.error, checkFirst, sheetMarkerUncertain, updatedAt: sql`now()` }).where(claim);
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
      // Post again is the operator's explicit choice: it goes to the connection as it is now (pinned on the next
      // attempt), and a Sheets row gets a fresh marker, as the old one may sit in another sheet or belong to someone else.
      ...(postAgain
        ? {
            checkFirst: false,
            pinnedAccount: "",
            pinnedDestination: null,
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
    .set({ state: "delivered", result: { confirmedBy: "operator" }, lastError: null, checkFirst: false, updatedAt: sql`now()` })
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
        await deleteSheetMarker(urls, serviceAccountSchema.parse(JSON.parse(conn.credential)), spreadsheetId, { id: d.sheetMetaId!, value: d.sheetMetaValue! });
      }
      await db.update(deliveries).set({ sheetMetaClearedAt: sql`now()` }).where(eq(deliveries.id, d.id));
      cleared++;
    } catch {
      // Google unavailable or refusing: try again on the next sweep.
    }
  }
  return cleared;
}
