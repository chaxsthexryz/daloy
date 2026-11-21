import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { retireStoredUnismsKeys, saveConnection, unismsConfig } from "./connections";
import { secretValuesToHide } from "./crypto";
import { BOOKING_CHANGED, claimDueDeliveries, queueDelivery, retryDelivery, runDueDeliveries } from "./deliveries";
import type { Db } from "./index";
import { unismsSend, ProviderError, type ProviderUrls } from "./providers";
import { bookings, connections, deliveries, resources, retiredSecrets, runs, usageCounts, users, workflows, workflowVersions } from "./schema";
import { claimUsage, type Plan } from "./usage";

// N7 and U6: UniSMS delivery, quotas, the server env as the only credential source, error classification, booking cancellation, and secret redaction.
const key = randomBytes(32);
const SYNTH_WS_KEY = "unisms_synth_workspace_key_0001"; // gitleaks:allow
const SYNTH_OP_KEY = "unisms_synth_operator_key_9999"; // gitleaks:allow

let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let seq = 0;

async function owner(plan: Plan | null = "pilot") {
  const [u] = await db.insert(users).values({ email: `sms${++seq}@test.local`, passwordHash: "x", plan, planStartedOn: plan ? "2026-11-01" : null }).returning();
  return u!.id;
}

async function newRun(userId: string, extra: { bookingId?: string; bookingVersion?: number } = {}) {
  const [wf] = await db.insert(workflows).values({ userId, name: "Reminders", slug: `sms-w-${++seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {}, ...extra }).returning();
  return { runId: r!.id, workflowId: wf!.id };
}

const smsDelivery = (userId: string, runId: string, payload: { to: string; message: string; senderId?: string } = { to: "+639171234567", message: "Booking confirmed." }) =>
  queueDelivery(db, { userId, runId, stepId: "send_sms", provider: "unisms", reference: `REF-${seq}`, payload });

const state = async (id: string) => (await db.select().from(deliveries).where(eq(deliveries.id, id)))[0]!;
const makeDue = (id: string) => db.update(deliveries).set({ nextAttemptAt: sql`now()` }).where(eq(deliveries.id, id));
const smsUsed = async (userId: string) => (await db.select().from(usageCounts).where(eq(usageCounts.userId, userId))).filter((r) => r.kind === "sms").reduce((a, r) => a + r.used, 0);

const savedEnv = { UNISMS_SECRET_KEY: process.env.UNISMS_SECRET_KEY, UNISMS_SENDER_ID: process.env.UNISMS_SENDER_ID };
const clearOperatorEnv = () => {
  delete process.env.UNISMS_SECRET_KEY;
  delete process.env.UNISMS_SENDER_ID;
};

/** The server operator's UniSMS settings as the deployment sets them in env (decision 0100); the fake accepts only the operator key. */
const operatorEnv = (senderId = "Daloy") => {
  process.env.UNISMS_SECRET_KEY = SYNTH_OP_KEY;
  process.env.UNISMS_SENDER_ID = senderId;
  fake.unisms.secretKey = SYNTH_OP_KEY;
};

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  urls = { ...fake.urls, timeoutMs: 2000 };
}, 120_000);

afterAll(async () => {
  Object.assign(process.env, savedEnv);
  await fake?.close();
  await pool?.end();
});

beforeEach(async () => {
  clearOperatorEnv();
  await db.delete(deliveries);
  await db.delete(connections);
  fake.unisms.secretKey = SYNTH_WS_KEY;
  fake.unisms.revoked = false;
  fake.unisms.messages.length = 0;
});

afterEach(() => {
  clearOperatorEnv();
});

describe("unismsSend provider client", () => {
  it("sends Basic auth with JSON payload and normalizes PH mobile numbers", async () => {
    const out = await unismsSend(urls, SYNTH_WS_KEY, { recipient: "09171234567", content: "Hello from Daloy", senderId: "LimDental", metadata: { reference: "REF-1" } });
    expect(out).toMatchObject({ recipient: "+639171234567", senderId: "LimDental", sent: true });
    expect(fake.unisms.messages).toEqual([
      expect.objectContaining({ recipient: "+639171234567", content: "Hello from Daloy", senderId: "LimDental", metadata: { reference: "REF-1" } }),
    ]);
  });

  it("classifies 400, 401, 403, 429 (with Retry-After), 5xx, and timeouts safely and redacts secrets", async () => {
    // 400 with secret echoed by remote server
    const b64 = Buffer.from(`${SYNTH_WS_KEY}:`).toString("base64");
    fake.once("/api/sms", { status: 400, body: { error: `invalid key ${SYNTH_WS_KEY} Basic ${b64}` } });
    const err400 = await unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" }).catch((e: unknown) => e);
    expect(err400).toBeInstanceOf(ProviderError);
    expect((err400 as ProviderError).kind).toBe("invalid");
    expect((err400 as Error).message).not.toContain(SYNTH_WS_KEY);
    expect((err400 as Error).message).not.toContain(b64);

    // 401 and 403 -> auth
    fake.once("/api/sms", { status: 401, body: { error: "unauthorized" } });
    await expect(unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" })).rejects.toMatchObject({ kind: "auth" });
    fake.once("/api/sms", { status: 403, body: { error: "forbidden" } });
    await expect(unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" })).rejects.toMatchObject({ kind: "auth" });

    // 429 -> quota with Retry-After
    fake.once("/api/sms", { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "17" } });
    await expect(unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" })).rejects.toMatchObject({ kind: "quota", retryAfterMs: 17_000 });

    // 500 -> ambiguous (never blind retry)
    fake.once("/api/sms", { status: 500, body: { error: "server_error" } });
    await expect(unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" })).rejects.toMatchObject({ kind: "ambiguous" });

    // timeout after send -> ambiguous
    fake.once("/api/sms", "hang-after");
    await expect(unismsSend({ ...urls, timeoutMs: 250 }, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" })).rejects.toMatchObject({ kind: "ambiguous" });

    // redirect -> rejected (redirect: "error")
    fake.once("/api/sms", { status: 302, body: {}, headers: { location: "http://127.0.0.1/other" } });
    const errRedir = await unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" }).catch((e: unknown) => e);
    expect(errRedir).toBeInstanceOf(ProviderError);

    // 200 without message ID or JSON null -> ambiguous (M3)
    fake.once("/api/sms", { status: 200, body: { success: true } });
    await expect(unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" })).rejects.toMatchObject({ kind: "ambiguous" });
    fake.once("/api/sms", { status: 200, body: null });
    await expect(unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" })).rejects.toMatchObject({ kind: "ambiguous" });

    // Shared mode omits upstream error text on 400, and non-shared redacts URL-encoded secret forms (L3)
    fake.once("/api/sms", { status: 400, body: { error: "upstream operator balance low" } });
    await expect(unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" }, { shared: true })).rejects.toThrow("UniSMS rejected the SMS (400).");
    const specialKey = "unisms_key/with+special=chars"; // gitleaks:allow
    fake.once("/api/sms", { status: 400, body: { error: `bad ${encodeURIComponent(specialKey)} and ${specialKey}:` } });
    const errEncoded = await unismsSend(urls, specialKey, { recipient: "+639171234567", content: "Hi" }).catch((e: unknown) => e);
    expect((errEncoded as Error).message).not.toContain(specialKey);
    expect((errEncoded as Error).message).not.toContain(encodeURIComponent(specialKey));

    // Retry-After is clamped to 10 minutes and supports HTTP-date (M4)
    fake.once("/api/sms", { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "999999" } });
    await expect(unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" })).rejects.toMatchObject({ kind: "quota", retryAfterMs: 10 * 60_000 });
    const futureDate = new Date(Date.now() + 25_000).toUTCString();
    fake.once("/api/sms", { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": futureDate } });
    const errDate = (await unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" }).catch((e: unknown) => e)) as ProviderError;
    expect(errDate.kind).toBe("quota");
    expect(errDate.retryAfterMs).toBeGreaterThan(15_000);
    expect(errDate.retryAfterMs).toBeLessThanOrEqual(25_000);
  });
});


describe("UniSMS delivery worker", () => {
  it("sends with the server env key and Sender ID, claims 1 sms unit, and honours Retry-After without double-charging", async () => {
    operatorEnv("DaloyPH");
    const u = await owner("pilot");
    const d = await smsDelivery(u, (await newRun(u)).runId);

    fake.once("/api/sms", { status: 429, body: { error: "throttled" }, headers: { "retry-after": "15" } });
    await runDueDeliveries(db, key, urls);
    const throttled = await state(d.id);
    expect(throttled).toMatchObject({ state: "queued", errorKind: "quota", attempts: 1 });
    expect(throttled.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
    expect(await smsUsed(u)).toBe(0);

    await makeDue(d.id);
    await runDueDeliveries(db, key, urls);
    expect(await state(d.id)).toMatchObject({ state: "delivered", result: expect.objectContaining({ recipient: "+639171234567", senderId: "DaloyPH" }) });
    expect(await smsUsed(u)).toBe(1);
    expect(fake.unisms.messages).toHaveLength(1);
  });

  it("is configured only when both env values are set", () => {
    expect(unismsConfig({})).toBeNull();
    expect(unismsConfig({ UNISMS_SECRET_KEY: SYNTH_OP_KEY })).toBeNull();
    expect(unismsConfig({ UNISMS_SENDER_ID: "Daloy" })).toBeNull();
    expect(unismsConfig({ UNISMS_SECRET_KEY: "  ", UNISMS_SENDER_ID: "Daloy" })).toBeNull();
    expect(unismsConfig({ UNISMS_SECRET_KEY: ` ${SYNTH_OP_KEY} `, UNISMS_SENDER_ID: " Daloy " })).toEqual({ secretKey: SYNTH_OP_KEY, senderId: "Daloy" });
    // The old switch no longer matters: the two values are enough.
    expect(unismsConfig({ UNISMS_SECRET_KEY: SYNTH_OP_KEY, UNISMS_SENDER_ID: "Daloy", SHARED_UNISMS_KEY: "off" })).not.toBeNull();
  });

  it("refuses a preview workspace before sending, even with the env set", async () => {
    operatorEnv();
    const u = await owner("preview");
    const d = await smsDelivery(u, (await newRun(u)).runId);
    await runDueDeliveries(db, key, urls);

    expect(await state(d.id)).toMatchObject({ state: "failed", errorKind: "plan_quota" });
    expect(fake.unisms.messages).toHaveLength(0);
    expect(await smsUsed(u)).toBe(0);
  });

  it("lets a private install (plan null) send", async () => {
    operatorEnv();
    const u = await owner(null);
    const d = await smsDelivery(u, (await newRun(u)).runId);
    await runDueDeliveries(db, key, urls);

    expect(await state(d.id)).toMatchObject({ state: "delivered" });
    expect(fake.unisms.messages).toHaveLength(1);
  });

  it("fails with the server message when the env is not set, and sends nothing", async () => {
    const u = await owner("business");
    const d = await smsDelivery(u, (await newRun(u)).runId);
    await runDueDeliveries(db, key, urls);

    expect(await state(d.id)).toMatchObject({ state: "failed", errorKind: "not_connected", lastError: "SMS is not set up on this server." });
    expect(fake.unisms.messages).toHaveLength(0);
    expect(await smsUsed(u)).toBe(0);

    // With only half of the pair set it is still not set up.
    process.env.UNISMS_SECRET_KEY = SYNTH_OP_KEY;
    const d2 = await smsDelivery(u, (await newRun(u)).runId);
    await runDueDeliveries(db, key, urls);
    expect(await state(d2.id)).toMatchObject({ state: "failed", errorKind: "not_connected" });
  });

  it("ignores a stored workspace key: it is never decrypted into a send, and the operator Sender ID wins", async () => {
    const u = await owner("pilot");
    await saveConnection(db, key, u, "unisms", { account: "LimDental", credential: SYNTH_WS_KEY, destination: { senderId: "LimDental" } });
    // Without the env nothing is sent, even though the workspace has a working key of its own.
    fake.unisms.secretKey = SYNTH_WS_KEY;
    const none = await smsDelivery(u, (await newRun(u)).runId);
    await runDueDeliveries(db, key, urls);
    expect(await state(none.id)).toMatchObject({ state: "failed", errorKind: "not_connected" });
    expect(fake.unisms.messages).toHaveLength(0);

    // With the env set the operator key is used. The stored credential is made unreadable to prove it is never opened.
    operatorEnv("DaloyPH");
    await db.update(connections).set({ credentialCiphertext: "AAAA" }).where(eq(connections.userId, u));
    const d = await smsDelivery(u, (await newRun(u)).runId, { to: "+639171234567", message: "Hi", senderId: "SpoofBrand" });
    await runDueDeliveries(db, key, urls);
    expect(await state(d.id)).toMatchObject({ state: "delivered", result: expect.objectContaining({ senderId: "DaloyPH" }) });
    expect(fake.unisms.messages.at(-1)?.senderId).toBe("DaloyPH");
  });

  it("retires a stored workspace key into retired_secrets once, and keeps hiding its value", async () => {
    const u = await owner("pilot");
    const other = await owner("pilot");
    await saveConnection(db, key, u, "unisms", { account: "LimDental", credential: SYNTH_WS_KEY, destination: { senderId: "LimDental" } });
    await saveConnection(db, key, other, "slack", { account: "T1", credential: "xoxb-synthetic-token-0001", destination: { channelId: "C1" } }); // gitleaks:allow

    expect(await retireStoredUnismsKeys(db)).toBe(1);
    expect(await db.select().from(connections).where(eq(connections.provider, "unisms"))).toHaveLength(0);
    expect(await db.select().from(connections).where(eq(connections.provider, "slack"))).toHaveLength(1);
    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, u))).toHaveLength(1);
    expect(await secretValuesToHide(db, key, u)).toContain(SYNTH_WS_KEY);

    // A second start finds nothing and adds nothing.
    expect(await retireStoredUnismsKeys(db)).toBe(0);
    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, u))).toHaveLength(1);
  });

  it("refunds reserved SMS quota on a definite rejection and leaves the workspace's connections alone on a 401", async () => {
    operatorEnv();
    const u = await owner("pilot");
    const dBad = await smsDelivery(u, (await newRun(u)).runId);
    fake.once("/api/sms", { status: 400, body: { error: "bad_sender" } });
    await runDueDeliveries(db, key, urls);
    expect(await state(dBad.id)).toMatchObject({ state: "failed", errorKind: "invalid" });
    expect(await smsUsed(u)).toBe(0);

    const d401 = await smsDelivery(u, (await newRun(u)).runId);
    fake.once("/api/sms", { status: 401, body: { error: "bad_op_key" } });
    await runDueDeliveries(db, key, urls);
    expect(await state(d401.id)).toMatchObject({ state: "failed", errorKind: "auth" });
    expect(await db.select().from(connections).where(eq(connections.userId, u))).toHaveLength(0);
    expect(await smsUsed(u)).toBe(0);
  });

  it("parks 5xx, timeouts, and stale worker takeovers in needs_review without double-sending, and does not double-charge on Send again", async () => {
    operatorEnv();
    const u = await owner("pilot");
    // Bring usage to 49 of 50 so a double-charge on Send again would hit the limit.
    await claimUsage(db, u, "sms", { n: 49 });

    const d = await smsDelivery(u, (await newRun(u)).runId);
    fake.once("/api/sms", "hang-after");
    await runDueDeliveries(db, key, { ...urls, timeoutMs: 250 });
    expect(await state(d.id)).toMatchObject({ state: "needs_review", errorKind: "ambiguous" });
    expect(await smsUsed(u)).toBe(50);

    // Operator chooses Send again: same delivery idempotency key must not double-bill.
    expect(await retryDelivery(db, u, d.id, { postAgain: true })).toBe(true);
    await runDueDeliveries(db, key, urls);
    expect(await state(d.id)).toMatchObject({ state: "delivered" });
    expect(await smsUsed(u)).toBe(50);

    // Stale sending claim taken over by another worker -> checkFirst parks in needs_review without calling UniSMS.
    const d2 = await smsDelivery(u, (await newRun(u)).runId);
    const beforeCount = fake.unisms.messages.length;
    await db.update(deliveries).set({ state: "sending", updatedAt: sql`now() - interval '5 minutes'` }).where(eq(deliveries.id, d2.id));
    await runDueDeliveries(db, key, urls);
    expect(await state(d2.id)).toMatchObject({ state: "needs_review", errorKind: "ambiguous" });
    expect(fake.unisms.messages).toHaveLength(beforeCount);
  });

  it("stops a queued SMS delivery cleanly when its booking was cancelled or rescheduled (N2b)", async () => {
    operatorEnv();
    const u = await owner("pilot");
    const [res] = await db.insert(resources).values({ userId: u, name: "Room 1" }).returning();
    const [bk] = await db
      .insert(bookings)
      .values({ userId: u, test: false, reference: `BK-${++seq}`, resourceId: res!.id, during: "[2030-05-01T10:00:00Z,2030-05-01T11:00:00Z)", timezone: "Asia/Manila", status: "active", version: 1 })
      .returning();
    const { runId } = await newRun(u, { bookingId: bk!.id, bookingVersion: 1 });
    const d = await smsDelivery(u, runId);

    // Booking is cancelled before the SMS delivery runs.
    await db.update(bookings).set({ status: "cancelled", version: 2 }).where(eq(bookings.id, bk!.id));

    await runDueDeliveries(db, key, urls);
    const out = await state(d.id);
    expect(out).toMatchObject({ state: "failed", errorKind: "booking_changed", lastError: BOOKING_CHANGED });
    expect(fake.unisms.messages).toHaveLength(0);
    expect(await smsUsed(u)).toBe(0);
    // Retry and Post again are both refused for a superseded booking.
    expect(await retryDelivery(db, u, d.id)).toBe(false);
    expect(await retryDelivery(db, u, d.id, { postAgain: true })).toBe(false);
  });

  it("claims stale deliveries cleanly", async () => {
    const u = await owner("pilot");
    const d = await smsDelivery(u, (await newRun(u)).runId);
    const claimed = await claimDueDeliveries(db);
    expect(claimed.map((c) => c.id)).toContain(d.id);
  });
});
