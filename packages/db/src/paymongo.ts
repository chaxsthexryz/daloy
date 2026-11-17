import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./index";
import { call, ProviderError, providerUrls, retryAfter, type ProviderUrls } from "./providers";
import { paymongoEvents, payments } from "./schema";

/** Peso amounts typed in a workflow, as text: "150", "150.5" or "150.50". String parsing only, so no float ever touches money. Result is 100 to 999,999,999 centavos. */
export function pesosToCentavos(text: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  const centavos = m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : NaN;
  if (!(centavos >= 100 && centavos <= 999_999_999)) throw new Error(`Amount "${text.trim()}" is not valid. Use pesos like 150 or 150.50, from 1.00 to 9,999,999.99, with no commas.`);
  return centavos;
}

export type PaymongoMode = "test" | "live";
export function paymongoMode(secretKey: string): PaymongoMode {
  if (secretKey.startsWith("sk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  throw new Error("That is not a PayMongo secret key. It starts with sk_test_ or sk_live_.");
}

/**
 * Checks a Paymongo-Signature header ("t=<unix seconds>,te=<hex>,li=<hex>") against the exact bytes received. The signed string is
 * "<t>.<body>". Only the part for the connection's mode counts, so a live signature never passes a test connection.
 */
export function verifyPaymongoSignature(o: { header: string; rawBody: Buffer | string; secret: string; mode: PaymongoMode; nowSeconds: number; toleranceSeconds?: number; futureSeconds?: number }): boolean {
  const parts = Object.fromEntries(o.header.split(",").map((p) => p.trim().split("=", 2) as [string, string | undefined]));
  const t = parts.t ?? "";
  const given = (parts[o.mode === "test" ? "te" : "li"] ?? "").toLowerCase();
  if (!/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(given)) return false;
  const age = o.nowSeconds - Number(t);
  if (age > (o.toleranceSeconds ?? 72 * 3600) || -age > (o.futureSeconds ?? 300)) return false;
  const want = createHmac("sha256", o.secret).update(`${t}.`).update(o.rawBody).digest();
  return timingSafeEqual(want, Buffer.from(given, "hex"));
}

// The secret key goes in the Authorization header only. No error below echoes a header, the key or the request body.
const basic = (secretKey: string) => `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;

async function paymongoCall(urls: ProviderUrls, secretKey: string, path: string, init: RequestInit, write: boolean) {
  const headers = { ...(init.headers as Record<string, string>), authorization: basic(secretKey), accept: "application/json" };
  const res = await call(`${urls.paymongo ?? "https://api.paymongo.com"}${path}`, { ...init, headers }, urls.timeoutMs ?? 10_000, write, "PayMongo");
  if (res.status === 429) throw new ProviderError("PayMongo is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  if (res.status >= 500) throw new ProviderError(`PayMongo answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  if (res.status === 401) throw new ProviderError("PayMongo no longer accepts the secret key. Connect PayMongo again.", "auth");
  if (res.status === 403) throw new ProviderError("PayMongo refused the key for this request. Check the key's permissions.", "permission");
  if (res.status >= 400) {
    const detail = (res.body.errors as { detail?: unknown }[] | undefined)?.[0]?.detail;
    throw new ProviderError(`PayMongo refused the request (${res.status})${typeof detail === "string" ? `: ${detail}` : ""}.`, "invalid");
  }
  return res.body;
}

/** One checkout link. The idempotency key makes a retry return the same session instead of a second one (max 255 characters). */
export async function createCheckoutSession(o: { secretKey: string; amountCentavos: number; description: string; reference: string; idempotencyKey: string; metadata: Record<string, string>; urls?: ProviderUrls }) {
  const attributes = {
    line_items: [{ amount: o.amountCentavos, currency: "PHP", name: o.description, quantity: 1 }],
    payment_method_types: ["gcash", "paymaya", "card", "qrph"],
    reference_number: o.reference,
    description: o.description,
    metadata: o.metadata,
  };
  const body = await paymongoCall(
    o.urls ?? providerUrls(),
    o.secretKey,
    "/v1/checkout_sessions",
    { method: "POST", headers: { "content-type": "application/json", "idempotency-key": o.idempotencyKey.slice(0, 255) }, body: JSON.stringify({ data: { attributes } }) },
    true,
  );
  const data = (body.data ?? {}) as { id?: unknown; attributes?: { checkout_url?: unknown; livemode?: unknown } };
  if (typeof data.id !== "string" || typeof data.attributes?.checkout_url !== "string") throw new ProviderError("PayMongo answered without a checkout link.", "review");
  return { id: data.id, url: data.attributes.checkout_url, livemode: data.attributes.livemode === true };
}

/** For the connection's Test button: listing webhooks is a cheap authenticated read. */
export async function checkPaymongoKey(secretKey: string, urls: ProviderUrls = providerUrls()) {
  await paymongoCall(urls, secretKey, "/v1/webhooks", { method: "GET" }, false);
  return { mode: paymongoMode(secretKey) };
}

export type Payment = typeof payments.$inferSelect;

export const findPaymentForStep = async (db: Db, runId: string, stepId: string): Promise<Payment | undefined> =>
  (await db.select().from(payments).where(and(eq(payments.runId, runId), eq(payments.stepId, stepId))))[0];

/** One payment per run and step: a repeat returns the existing row. */
export async function insertPayment(db: Db, v: { userId: string; workflowId: string; runId: string; stepId: string; reference: string; amountCentavos: number; livemode: boolean; providerSessionId: string; url: string }): Promise<Payment> {
  await db.insert(payments).values(v).onConflictDoNothing({ target: [payments.runId, payments.stepId] });
  return (await findPaymentForStep(db, v.runId, v.stepId))!;
}

const bySession = (userId: string, sessionId: string) => and(eq(payments.userId, userId), eq(payments.providerSessionId, sessionId));

/** pending -> paid, only once. A different amount or currency parks it in needs_review for a person. Paid, refunded and needs_review never move back. */
export async function markPaymentPaid(db: Db, o: { userId: string; sessionId: string; paymentId: string; amount: number; currency: string }): Promise<{ payment: Payment | undefined; changed: boolean; mismatch: boolean }> {
  const matches = sql`${o.amount}::int = ${payments.amountCentavos} and ${o.currency} = ${payments.currency}`;
  const [row] = await db
    .update(payments)
    .set({ status: sql`case when ${matches} then 'paid' else 'needs_review' end`, providerPaymentId: o.paymentId, paidAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(bySession(o.userId, o.sessionId), eq(payments.status, "pending")))
    .returning();
  if (row) return { payment: row, changed: true, mismatch: row.status === "needs_review" };
  return { payment: (await db.select().from(payments).where(bySession(o.userId, o.sessionId)))[0], changed: false, mismatch: false };
}

/** paid -> refunded, only. */
export async function markPaymentRefunded(db: Db, o: { userId: string; providerPaymentId: string }): Promise<{ payment: Payment | undefined; changed: boolean }> {
  const own = and(eq(payments.userId, o.userId), eq(payments.providerPaymentId, o.providerPaymentId));
  const [row] = await db.update(payments).set({ status: "refunded", updatedAt: sql`now()` }).where(and(own, eq(payments.status, "paid"))).returning();
  if (row) return { payment: row, changed: true };
  return { payment: (await db.select().from(payments).where(own))[0], changed: false };
}

export const eventSeen = async (db: Db, eventId: string) => (await db.select().from(paymongoEvents).where(eq(paymongoEvents.eventId, eventId))).length > 0;

/** True when this call recorded the event, false when it was already there. */
export async function recordEvent(db: Db, v: { eventId: string; userId: string; type: string }) {
  return (await db.insert(paymongoEvents).values(v).onConflictDoNothing().returning()).length > 0;
}
