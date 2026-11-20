import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { connectionCredential, markConnectionFailed, removeConnection, saveConnection } from "./connections";
import { BOOKING_CHANGED, claimDueDeliveries, queueDelivery, retryDelivery, runDueDeliveries } from "./deliveries";
import type { Db } from "./index";
import { unismsSend, ProviderError, type ProviderUrls } from "./providers";
import { bookings, connections, deliveries, resources, runs, usageCounts, users, workflows, workflowVersions } from "./schema";
import { claimUsage, type Plan } from "./usage";

// N7: UniSMS delivery, quotas, operator fallback, error classification, booking cancellation, and secret redaction.
const key = randomBytes(32);
const SYNTH_WS_KEY = "unisms_synth_workspace_key_0001"; // gitleaks:allow
const SYNTH_WS_KEY_2 = "unisms_synth_workspace_key_0002"; // gitleaks:allow
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

const savedEnv = { SHARED_UNISMS_KEY: process.env.SHARED_UNISMS_KEY, UNISMS_SECRET_KEY: process.env.UNISMS_SECRET_KEY, UNISMS_SENDER_ID: process.env.UNISMS_SENDER_ID };
const clearSharedEnv = () => {
  delete process.env.SHARED_UNISMS_KEY;
  delete process.env.UNISMS_SECRET_KEY;
  delete process.env.UNISMS_SENDER_ID;
};

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  urls = { ...fake.urls, timeoutMs: 300 };
}, 120_000);

afterAll(async () => {
  Object.assign(process.env, savedEnv);
  await fake?.close();
  await pool?.end();
});

beforeEach(async () => {
  clearSharedEnv();
  await db.delete(deliveries);
  await db.delete(connections);
  fake.unisms.secretKey = SYNTH_WS_KEY;
  fake.unisms.revoked = false;
  fake.unisms.messages.length = 0;
});

afterEach(() => {
  clearSharedEnv();
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
    await expect(unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" })).rejects.toMatchObject({ kind: "ambiguous" });

    // redirect -> rejected (redirect: "error")
    fake.once("/api/sms", { status: 302, body: {}, headers: { location: "http://127.0.0.1/other" } });
    const errRedir = await unismsSend(urls, SYNTH_WS_KEY, { recipient: "+639171234567", content: "Hi" }).catch((e: unknown) => e);
    expect(errRedir).toBeInstanceOf(ProviderError);
  });
});

describe("UniSMS delivery worker", () => {
  it("sends with workspace credentials, claims 1 sms unit, and honours Retry-After without double-charging", async () => {
    const u = await owner("pilot");
    await saveConnection(db, key, u, "unisms", { account: "LimDental", credential: SYNTH_WS_KEY, destination: { senderId: "LimDental" } });
    const { runId } = await newRun(u);
    const d = await smsDelivery(u, runId);

    fake.once("/api/sms", { status: 429, body: { error: "throttled" }, headers: { "retry-after": "15" } });
    await runDueDeliveries(db, key, urls);
    const throttled = await state(d.id);
    expect(throttled).toMatchObject({ state: "queued", errorKind: "quota", attempts: 1 });
    expect(throttled.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
    expect(await smsUsed(u)).toBe(0);

    await makeDue(d.id);
    await runDueDeliveries(db, key, urls);
    expect(await state(d.id)).toMatchObject({ state: "delivered", result: expect.objectContaining({ recipient: "+639171234567", senderId: "LimDental" }) });
    expect(await smsUsed(u)).toBe(1);
    expect(fake.unisms.messages).toHaveLength(1);
  });

  it("blocks preview plan (sms: 0) before sending even when SHARED_UNISMS_KEY=open", async () => {
    process.env.SHARED_UNISMS_KEY = "open";
    process.env.UNISMS_SECRET_KEY = SYNTH_OP_KEY;
    process.env.UNISMS_SENDER_ID = "Daloy";
    fake.unisms.secretKey = SYNTH_OP_KEY;

    const u = await owner("preview");
    const { runId } = await newRun(u);
    const d = await smsDelivery(u, runId);
    await runDueDeliveries(db, key, urls);

    expect(await state(d.id)).toMatchObject({ state: "failed", errorKind: "plan_quota" });
    expect(fake.unisms.messages).toHaveLength(0);
    expect(await smsUsed(u)).toBe(0);
  });

  it("uses operator fallback ONLY on paid plans with no workspace connection, and never falls back after failure or disconnect", async () => {
    process.env.SHARED_UNISMS_KEY = "open";
    process.env.UNISMS_SECRET_KEY = SYNTH_OP_KEY;
    process.env.UNISMS_SENDER_ID = "DaloyPH";
    fake.unisms.secretKey = SYNTH_OP_KEY;

    // Paid plan (pilot) without workspace connection -> uses operator fallback
    const paid = await owner("pilot");
    const dPaid = await smsDelivery(paid, (await newRun(paid)).runId);
    await runDueDeliveries(db, key, urls);
    expect(await state(dPaid.id)).toMatchObject({ state: "delivered", result: expect.objectContaining({ senderId: "DaloyPH" }) });
    expect(await smsUsed(paid)).toBe(1);

    // Unplanned (plan: null) -> never spends operator fallback
    const unplanned = await owner(null);
    const dNull = await smsDelivery(unplanned, (await newRun(unplanned)).runId);
    await runDueDeliveries(db, key, urls);
    expect(await state(dNull.id)).toMatchObject({ state: "failed", errorKind: "not_connected" });

    // Workspace with a FAILED connection -> never falls back to operator
    const broken = await owner("business");
    await saveConnection(db, key, broken, "unisms", { account: "ClinicA", credential: SYNTH_WS_KEY, destination: { senderId: "ClinicA" } });
    const conn = (await connectionCredential(db, key, broken, "unisms"))!;
    await markConnectionFailed(db, broken, "unisms", "UniSMS rejected the key.", conn.revision);
    const dBroken = await smsDelivery(broken, (await newRun(broken)).runId);
    await runDueDeliveries(db, key, urls);
    expect(await state(dBroken.id)).toMatchObject({ state: "failed", errorKind: "reconnect" });

    // Delivery queued under workspace connection that was then DISCONNECTED -> never falls back to operator
    const disc = await owner("business");
    await saveConnection(db, key, disc, "unisms", { account: "ClinicB", credential: SYNTH_WS_KEY, destination: { senderId: "ClinicB" } });
    const dDisc = await smsDelivery(disc, (await newRun(disc)).runId);
    await removeConnection(db, disc, "unisms");
    await runDueDeliveries(db, key, urls);
    expect(await state(dDisc.id)).toMatchObject({ state: "failed", errorKind: "not_connected" });

    // Only the paid workspace delivery actually hit UniSMS.
    expect(fake.unisms.messages).toHaveLength(1);
  });

  it("parks 5xx, timeouts, and stale worker takeovers in needs_review without double-sending, and does not double-charge on Send again", async () => {
    const u = await owner("pilot");
    await saveConnection(db, key, u, "unisms", { account: "Unisoft", credential: SYNTH_WS_KEY, destination: { senderId: "Unisoft" } });
    // Bring usage to 49 of 50 so a double-charge on Send again would hit the limit.
    await claimUsage(db, u, "sms", { n: 49 });

    const d = await smsDelivery(u, (await newRun(u)).runId);
    fake.once("/api/sms", "hang-after");
    await runDueDeliveries(db, key, urls);
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

  it("marks workspace connection failed on 401/403 fenced by credential IV, and leaves operator fallback untouched", async () => {
    const u = await owner("pilot");
    await saveConnection(db, key, u, "unisms", { account: "Clinic", credential: SYNTH_WS_KEY, destination: { senderId: "Clinic" } });
    const d = await smsDelivery(u, (await newRun(u)).runId);

    // Hold a 401 while owner replaces the key -> late 401 must NOT mark the replacement failed.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    fake.once("/api/sms", { heldUntil: held, status: 401, body: { error: "bad_key" } });
    const inFlight = runDueDeliveries(db, key, urls);
    // Wait until the worker has claimed the row and sent the request.
    while ((await state(d.id)).state !== "sending") await new Promise((r) => setTimeout(r, 10));
    await saveConnection(db, key, u, "unisms", { account: "Clinic", credential: SYNTH_WS_KEY_2, destination: { senderId: "Clinic" } });
    release();
    await inFlight;
    expect(await state(d.id)).toMatchObject({ state: "failed", errorKind: "auth" });
    expect((await connectionCredential(db, key, u, "unisms"))!.status).toBe("active");

    // A 403 against the current key DOES mark the connection failed.
    const d2 = await smsDelivery(u, (await newRun(u)).runId);
    fake.once("/api/sms", { status: 403, body: { error: "suspended" } });
    await runDueDeliveries(db, key, urls);
    expect(await state(d2.id)).toMatchObject({ state: "failed", errorKind: "auth" });
    expect((await connectionCredential(db, key, u, "unisms"))!.status).toBe("failed");

    // 401 on operator fallback fails the delivery without creating/mutating any workspace connection.
    process.env.SHARED_UNISMS_KEY = "open";
    process.env.UNISMS_SECRET_KEY = SYNTH_OP_KEY;
    process.env.UNISMS_SENDER_ID = "Daloy";
    const uOp = await owner("pilot");
    const dOp = await smsDelivery(uOp, (await newRun(uOp)).runId);
    fake.once("/api/sms", { status: 401, body: { error: "bad_op_key" } });
    await runDueDeliveries(db, key, urls);
    expect(await state(dOp.id)).toMatchObject({ state: "failed", errorKind: "auth" });
    expect(await connectionCredential(db, key, uOp, "unisms")).toBeNull();
  });

  it("stops a queued SMS delivery cleanly when its booking was cancelled or rescheduled (N2b)", async () => {
    const u = await owner("pilot");
    await saveConnection(db, key, u, "unisms", { account: "Clinic", credential: SYNTH_WS_KEY, destination: { senderId: "Clinic" } });
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
