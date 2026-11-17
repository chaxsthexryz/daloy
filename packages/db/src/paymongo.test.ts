import { createHmac, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import type { Db } from "./index";
import { checkPaymongoKey, createCheckoutSession, eventSeen, findPaymentForStep, insertPayment, markPaymentPaid, markPaymentRefunded, paymongoMode, pesosToCentavos, recordEvent, verifyPaymongoSignature } from "./paymongo";
import { ProviderError } from "./providers";
import { runs, users, workflows, workflowVersions } from "./schema";

const secret = "whsk_test_secret";
const now = 1_800_000_000;
const body = '{"data":{"id":"evt_1"}}';
const sign = (t: number, b = body, s = secret) => createHmac("sha256", s).update(`${t}.${b}`).digest("hex");
const verify = (header: string, over: Partial<Parameters<typeof verifyPaymongoSignature>[0]> = {}) =>
  verifyPaymongoSignature({ header, rawBody: body, secret, mode: "test", nowSeconds: now, ...over });

describe("pesosToCentavos", () => {
  it.each([["150", 15000], ["150.5", 15050], ["150.50", 15050], [" 1.00 ", 100], ["9999999.99", 999999999]] as const)("accepts %s", (text, centavos) => {
    expect(pesosToCentavos(text)).toBe(centavos);
  });
  it.each(["1,500", "-5", "1.234", "abc", "0.99", "", "1e3", ".5", "10000000", "5."])("rejects %j", (text) => {
    expect(() => pesosToCentavos(text)).toThrow(/amount/i);
  });
});

describe("paymongoMode", () => {
  it("reads the key prefix", () => {
    expect(paymongoMode("sk_test_abc")).toBe("test");
    expect(paymongoMode("sk_live_abc")).toBe("live");
    expect(() => paymongoMode("pk_test_abc")).toThrow();
  });
});

describe("verifyPaymongoSignature", () => {
  it("accepts a valid test-mode signature, as a Buffer too", () => {
    expect(verify(`t=${now},te=${sign(now)},li=`)).toBe(true);
    expect(verify(`t=${now},te=${sign(now)},li=`, { rawBody: Buffer.from(body) })).toBe(true);
  });
  it("accepts a valid live-mode signature", () => {
    expect(verify(`t=${now},te=,li=${sign(now)}`, { mode: "live" })).toBe(true);
  });
  it("rejects a live signature in test mode and the reverse", () => {
    expect(verify(`t=${now},te=,li=${sign(now)}`)).toBe(false);
    expect(verify(`t=${now},te=${sign(now)},li=`, { mode: "live" })).toBe(false);
  });
  it("rejects a tampered body and a wrong secret", () => {
    expect(verify(`t=${now},te=${sign(now)},li=`, { rawBody: body + " " })).toBe(false);
    expect(verify(`t=${now},te=${sign(now, body, "other")},li=`)).toBe(false);
  });
  it("rejects stale and future timestamps", () => {
    const old = now - 72 * 3600 - 1;
    expect(verify(`t=${old},te=${sign(old)},li=`)).toBe(false);
    const edge = now - 72 * 3600;
    expect(verify(`t=${edge},te=${sign(edge)},li=`)).toBe(true);
    const ahead = now + 301;
    expect(verify(`t=${ahead},te=${sign(ahead)},li=`)).toBe(false);
  });
  it("rejects malformed headers and signatures", () => {
    for (const h of ["", "garbage", `te=${sign(now)}`, `t=abc,te=${sign(now)}`, `t=${now},te=,li=`, `t=${now},te=zz${sign(now).slice(2)}`, `t=${now},te=${sign(now).slice(0, 10)}`]) {
      expect(verify(h)).toBe(false);
    }
  });
  it("is case-insensitive about hex and tolerates spaces after commas", () => {
    expect(verify(`t=${now}, te=${sign(now).toUpperCase()}, li=`)).toBe(true);
  });
});

describe("payment state", () => {
  let db: Db;
  let pool: Pool;
  let userId: string;
  let workflowId: string;
  let n = 0;

  beforeAll(async () => {
    ({ db, pool } = await freshDatabase());
    const [u] = await db.insert(users).values({ email: "pay@test.local", passwordHash: "x" }).returning();
    userId = u!.id;
    const [wf] = await db.insert(workflows).values({ userId, name: "Orders", slug: "orders" }).returning();
    workflowId = wf!.id;
  }, 120_000);
  afterAll(() => pool?.end());

  async function pending(amountCentavos = 15000) {
    const [v] = await db.insert(workflowVersions).values({ workflowId, version: ++n, definition: {} }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
    const p = await insertPayment(db, { userId, workflowId, runId: r!.id, stepId: "link", reference: `ORD-${n}`, amountCentavos, livemode: false, providerSessionId: `cs_${n}`, url: `https://pm.test/cs_${n}` });
    return { run: r!.id, p };
  }

  it("insertPayment is once per run and step", async () => {
    const { run, p } = await pending();
    const again = await insertPayment(db, { userId, workflowId, runId: run, stepId: "link", reference: "x", amountCentavos: 1, livemode: false, providerSessionId: "cs_other", url: "u" });
    expect(again.id).toBe(p.id);
    expect((await findPaymentForStep(db, run, "link"))!.id).toBe(p.id);
    expect(await findPaymentForStep(db, run, "nope")).toBeUndefined();
  });

  it("pending becomes paid once, and a repeat changes nothing", async () => {
    const { p } = await pending();
    const first = await markPaymentPaid(db, { userId, sessionId: p.providerSessionId, paymentId: "pay_1", amount: 15000, currency: "PHP" });
    expect(first).toMatchObject({ changed: true, mismatch: false });
    expect(first.payment!.status).toBe("paid");
    expect(first.payment!.providerPaymentId).toBe("pay_1");
    expect(first.payment!.paidAt).toBeTruthy();
    const second = await markPaymentPaid(db, { userId, sessionId: p.providerSessionId, paymentId: "pay_2", amount: 15000, currency: "PHP" });
    expect(second).toMatchObject({ changed: false, mismatch: false });
    expect(second.payment!.providerPaymentId).toBe("pay_1");
  });

  it("an amount or currency mismatch goes to needs_review and stays", async () => {
    const a = await pending();
    const r = await markPaymentPaid(db, { userId, sessionId: a.p.providerSessionId, paymentId: "pay_m1", amount: 100, currency: "PHP" });
    expect(r).toMatchObject({ changed: true, mismatch: true });
    expect(r.payment!.status).toBe("needs_review");
    const b = await pending();
    expect((await markPaymentPaid(db, { userId, sessionId: b.p.providerSessionId, paymentId: "pay_m2", amount: 15000, currency: "USD" })).payment!.status).toBe("needs_review");
    const again = await markPaymentPaid(db, { userId, sessionId: a.p.providerSessionId, paymentId: "pay_m3", amount: 15000, currency: "PHP" });
    expect(again.changed).toBe(false);
    expect(again.payment!.status).toBe("needs_review");
  });

  it("another owner or an unknown session finds nothing", async () => {
    const { p } = await pending();
    expect((await markPaymentPaid(db, { userId: randomUUID(), sessionId: p.providerSessionId, paymentId: "pay_x", amount: 15000, currency: "PHP" })).payment).toBeUndefined();
    expect((await markPaymentPaid(db, { userId, sessionId: "cs_none", paymentId: "pay_x", amount: 1, currency: "PHP" })).payment).toBeUndefined();
  });

  it("refund moves only paid payments, and a late paid never undoes it", async () => {
    const { p } = await pending();
    expect(await markPaymentRefunded(db, { userId, providerPaymentId: "pay_r" })).toMatchObject({ changed: false });
    await markPaymentPaid(db, { userId, sessionId: p.providerSessionId, paymentId: "pay_r", amount: 15000, currency: "PHP" });
    const r = await markPaymentRefunded(db, { userId, providerPaymentId: "pay_r" });
    expect(r.changed).toBe(true);
    expect(r.payment!.status).toBe("refunded");
    expect((await markPaymentRefunded(db, { userId, providerPaymentId: "pay_r" })).changed).toBe(false);
    const late = await markPaymentPaid(db, { userId, sessionId: p.providerSessionId, paymentId: "pay_r", amount: 15000, currency: "PHP" });
    expect(late.changed).toBe(false);
    expect(late.payment!.status).toBe("refunded");
  });

  it("records each event once", async () => {
    expect(await eventSeen(db, "evt_a")).toBe(false);
    expect(await recordEvent(db, { eventId: "evt_a", userId, type: "payment.paid" })).toBe(true);
    expect(await recordEvent(db, { eventId: "evt_a", userId, type: "payment.paid" })).toBe(false);
    expect(await eventSeen(db, "evt_a")).toBe(true);
  });
});

describe("PayMongo calls", () => {
  const key = "sk_test_supersecret";
  const urls = { googleToken: "", sheets: "", slack: "", telegram: "", paymongo: "https://pm.test" };
  const reply = (status: number, body: object) => vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  afterEach(() => vi.restoreAllMocks());

  it("creates a session with Basic auth, an idempotency key and centavo amounts", async () => {
    const spy = reply(200, { data: { id: "cs_1", attributes: { checkout_url: "https://pm.test/pay/cs_1", livemode: false } } });
    const r = await createCheckoutSession({ secretKey: key, amountCentavos: 15050, description: "Order", reference: "ORD-1", idempotencyKey: "run:step", metadata: { run: "r" }, urls });
    expect(r).toEqual({ id: "cs_1", url: "https://pm.test/pay/cs_1", livemode: false });
    const [url, init] = spy.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(url).toBe("https://pm.test/v1/checkout_sessions");
    expect(headers.authorization).toBe(`Basic ${Buffer.from(`${key}:`).toString("base64")}`);
    expect(headers["idempotency-key"]).toBe("run:step");
    const attrs = JSON.parse(init!.body as string).data.attributes;
    expect(attrs.line_items).toEqual([{ amount: 15050, currency: "PHP", name: "Order", quantity: 1 }]);
    expect(attrs.payment_method_types).toEqual(["gcash", "paymaya", "card", "qrph"]);
  });

  it("maps failures to a ProviderError that never contains the key", async () => {
    for (const [status, kind] of [[401, "auth"], [403, "permission"], [429, "quota"], [500, "ambiguous"], [400, "invalid"]] as const) {
      reply(status, { errors: [{ detail: "bad" }] });
      const err = await createCheckoutSession({ secretKey: key, amountCentavos: 100, description: "d", reference: "r", idempotencyKey: "k", metadata: {}, urls }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe(kind);
      expect((err as ProviderError).message).not.toContain("supersecret");
    }
  });

  it("checks a key by listing webhooks", async () => {
    const spy = reply(200, { data: [] });
    expect(await checkPaymongoKey(key, urls)).toEqual({ mode: "test" });
    expect(spy.mock.calls[0]![0]).toBe("https://pm.test/v1/webhooks");
  });
});
