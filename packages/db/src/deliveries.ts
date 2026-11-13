import { backoffDelayMs, type RetryPolicy } from "@daloy/engine";
import { and, eq, inArray, sql } from "drizzle-orm";
import { connectionCredential, markConnectionFailed, PROVIDER_NAMES } from "./connections";
import type { Db } from "./index";
import { appendRow, findReference, ProviderError, serviceAccountSchema, slackPost, type ProviderUrls, type SheetDestination } from "./providers";
import { deliveries, type Provider } from "./schema";

/**
 * Sheets rows and Slack messages, delivered by the worker apart from the run that asked for them (decision 0021).
 *
 *   queued -> sending -> delivered
 *                     -> queued        (quota, provider down, or Sheets ambiguous: try later, look first)
 *                     -> needs_review  (Slack ambiguous: an operator checks the channel)
 *                     -> failed        (auth, permission, bad request, or the last attempt)
 *   failed -> queued (Retry); needs_review -> queued (Post again) or delivered (Mark as posted)
 */
export type Delivery = typeof deliveries.$inferSelect;
export type DeliveryPayload = Delivery["payload"];

export const DELIVERY_POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 10 * 60_000 };
/** A delivery still "sending" after this long belongs to a worker that died mid-call. Well above a call's timeouts. */
const STALE_SENDING = "2 minutes";

/** Called by the sheets and slack steps. One row per run and step: a step that runs again gets the first row back. */
export async function queueDelivery(db: Db, d: { userId: string; runId: string; stepId: string; provider: Provider; reference: string; payload: DeliveryPayload }): Promise<Delivery> {
  await db.insert(deliveries).values(d).onConflictDoNothing({ target: [deliveries.runId, deliveries.stepId] });
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
    .set({ state: "sending", attempts: sql`${deliveries.attempts} + 1`, checkFirst: sql`${deliveries.checkFirst} or ${deliveries.state} = 'sending'`, updatedAt: sql`now()` })
    .where(inArray(deliveries.id, due))
    .returning();
}

type Outcome =
  | { state: "delivered"; result: Record<string, string | boolean> }
  | { state: "failed" | "needs_review"; error: string }
  | { state: "queued"; error: string; retryAfterMs?: number; checkFirst?: boolean };

/** One attempt at a claimed delivery. Never throws for provider trouble: the outcome is written to the row. */
async function attempt(db: Db, key: Buffer, urls: ProviderUrls, d: Delivery): Promise<Outcome> {
  const name = PROVIDER_NAMES[d.provider];
  const conn = await connectionCredential(db, key, d.userId, d.provider);
  if (!conn) return { state: "failed", error: `${name} is not connected. Connect it in Settings, Business and email, then retry.` };
  if (conn.status === "failed") return { state: "failed", error: `${name} needs to be connected again (${conn.account}). Reconnect it in Settings, Business and email, then retry.` };
  if (!conn.destination) return { state: "failed", error: `No ${d.provider === "slack" ? "channel" : "sheet"} is chosen for ${name}. Pick one in Settings, Business and email, then retry.` };
  try {
    if (d.provider === "google_sheets") {
      const sa = serviceAccountSchema.parse(JSON.parse(conn.credential));
      const dest = conn.destination as SheetDestination;
      if (d.checkFirst) {
        const found = await findReference(urls, sa, dest, d.reference);
        if (found) return { state: "delivered", result: { range: found, reconciled: true } };
      }
      return { state: "delivered", result: await appendRow(urls, sa, dest, (d.payload as { row: string[] }).row) };
    }
    const channel = conn.destination.channelId!;
    if (d.checkFirst) {
      // Without a history scope Daloy cannot look in the channel, so a person decides.
      return { state: "needs_review", error: `Slack may have posted this message before the connection dropped. Check #${conn.destination.channelName ?? channel}, then choose Mark as posted or Post again.` };
    }
    return { state: "delivered", result: await slackPost(urls, conn.credential, channel, (d.payload as { text: string }).text) };
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError(err instanceof Error ? err.message : String(err), "unavailable");
    switch (e.kind) {
      case "auth":
        await markConnectionFailed(db, d.userId, d.provider, e.message);
        return { state: "failed", error: e.message };
      case "permission":
      case "invalid":
        return { state: "failed", error: e.message };
      case "ambiguous":
        if (d.provider === "slack") return { state: "needs_review", error: `${e.message} Slack may have posted it. Check the channel, then choose Mark as posted or Post again.` };
        return { state: "queued", error: e.message, checkFirst: true };
      case "quota":
      case "unavailable":
        return { state: "queued", error: e.message, retryAfterMs: e.retryAfterMs };
    }
  }
}

/** Writes the outcome, guarded by the claim (state and attempt number) so a stale worker cannot overwrite a newer one. */
async function finish(db: Db, d: Delivery, o: Outcome) {
  const claim = and(eq(deliveries.id, d.id), eq(deliveries.state, "sending"), eq(deliveries.attempts, d.attempts));
  if (o.state === "delivered") {
    await db.update(deliveries).set({ state: "delivered", result: o.result, lastError: null, checkFirst: false, updatedAt: sql`now()` }).where(claim);
    return;
  }
  const checkFirst = d.checkFirst || (o.state === "queued" && o.checkFirst === true);
  if (o.state === "queued" && d.attempts < DELIVERY_POLICY.maxAttempts) {
    const delay = Math.max(backoffDelayMs(d.attempts, DELIVERY_POLICY), o.retryAfterMs ?? 0);
    await db.update(deliveries).set({ state: "queued", lastError: o.error, checkFirst, nextAttemptAt: new Date(Date.now() + delay), updatedAt: sql`now()` }).where(claim);
    return;
  }
  // The last attempt keeps checkFirst, so a manual Retry of an uncertain Sheets row still looks before writing.
  await db.update(deliveries).set({ state: o.state === "queued" ? "failed" : o.state, lastError: o.error, checkFirst, updatedAt: sql`now()` }).where(claim);
}

/** The worker's poll: claims what is due and delivers each one independently. */
export async function runDueDeliveries(db: Db, key: Buffer, urls: ProviderUrls) {
  const claimed = await claimDueDeliveries(db);
  await Promise.all(claimed.map(async (d) => finish(db, d, await attempt(db, key, urls, d))));
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
      ...(postAgain ? { checkFirst: false } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(deliveries.id, id), eq(deliveries.userId, userId), from))
    .returning({ id: deliveries.id });
  return done.length === 1;
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
