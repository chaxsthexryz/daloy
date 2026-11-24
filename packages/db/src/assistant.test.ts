import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { formatAssistantSummary, mockAssistantSnapshot, parseAssistantScope, readAssistantSnapshot } from "./assistant";
import { bookFromStep } from "./bookings";
import { connectionCredential } from "./connections";
import { conversationPayload, recordInbound, recordOutboundReply } from "./conversations";
import { ensureCalendar } from "./google-calendar";
import type { Db } from "./index";
import { consumeFlow, finishFlow, googleCalendar, startFlow } from "./oauth";
import { createDue } from "./payment-review";
import { deleteCustomer, exportCustomer, purgeConversations } from "./privacy";
import type { ProviderUrls } from "./providers";
import { bookings, connections, conversationMessages, conversations, paymentDues, resources, runs, users, workflows, workflowVersions } from "./schema";

// Decision 0135: the assistant reads today's calendar, kymavo bookings, open unpaid dues and today's runs, for one workspace only.
const key = randomBytes(32);
const PUBLIC = "http://localhost:3000";
const ANA = { id: "google-assistant-ana", email: "ana@assistant.example" };
// 2031-01-20 12:00 in Asia/Manila.
const NOW = new Date("2031-01-20T04:00:00Z");
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let seq = 0;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  const app = fake.addOAuthApp("google", { rotation: "none" });
  urls = { ...fake.urls, timeoutMs: 2000, googleOAuth: { clientId: app.clientId, clientSecret: app.clientSecret, ...fake.oauthUrls("google") } };
}, 120_000);
afterAll(async () => {
  await fake?.close();
  await pool?.end();
});
beforeEach(() => {
  Object.assign(fake.oauth.google!, { consent: "grant", user: ANA });
});

async function workspace() {
  const [u] = await db.insert(users).values({ email: `asst${++seq}@test.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: `Front desk ${seq}`, slug: `front${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(resources).values({ userId: u!.id, name: `Room ${seq}` }).returning();
  return { id: u!.id, workflowId: wf!.id, versionId: v!.id, resourceId: r!.id };
}
type Ws = Awaited<ReturnType<typeof workspace>>;
const newRun = async (ws: Ws, values: Partial<typeof runs.$inferInsert> = {}) => (await db.insert(runs).values({ workflowVersionId: ws.versionId, ...values }).returning())[0]!;
const read = (ws: Ws, what: Parameters<typeof readAssistantSnapshot>[0]["what"], extra: { timezone?: string } = {}) =>
  readAssistantSnapshot({ db, secretsKey: key, urls, userId: ws.id, what, now: NOW, ...extra });

async function book(ws: Ws, hourUtc: number, day: number, test = false) {
  const run = await newRun(ws);
  const r = await bookFromStep(db, { workspaceId: ws.id, test, runId: run.id, stepId: "book", workflowId: ws.workflowId }, { action: "create", resourceId: ws.resourceId, start: new Date(Date.UTC(2031, 0, day, hourUtc)), minutes: 60, timezone: "Asia/Manila" });
  return String(r.output.reference);
}

async function connectCalendar(ws: Ws) {
  const back = new URL((await fetch(await startFlow(db, key, urls, PUBLIC, googleCalendar, { workspaceId: ws.id, memberId: ws.id }), { redirect: "manual" })).headers.get("location")!);
  const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: ws.id, memberId: ws.id });
  expect(await finishFlow(db, key, urls, PUBLIC, googleCalendar, ws.id, back.searchParams.get("code")!, flow!.verifier)).toBe("connected");
  return ensureCalendar(db, key, urls, ws.id);
}

describe("scope and summary text", () => {
  it("accepts the five scopes, trims and lowercases, and refuses anything else", () => {
    expect(parseAssistantScope(undefined)).toBe("all");
    expect(parseAssistantScope(" Calendar ")).toBe("calendar");
    expect(parseAssistantScope("payments")).toBe("payments");
    expect(parseAssistantScope("passwords")).toBeNull();
  });

  it("builds a mocked snapshot for a test run with no database", () => {
    const snap = mockAssistantSnapshot("bookings", "Asia/Manila", NOW);
    expect(snap).toMatchObject({ mocked: true, date: "2031-01-20", timezone: "Asia/Manila", what: "bookings", bookings: { count: 0, items: [] } });
    expect(snap.calendar).toBeUndefined();
    expect(snap.summaryText).toContain("kymavo bookings: No bookings today.");
    expect(formatAssistantSummary({ date: "2031-01-20", timezone: "UTC", what: "runs" })).toBe("Today (2031-01-20, UTC):");
    expect(snap.summaryText).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("today's kymavo bookings", () => {
  it("lists today's bookings only, for this workspace, and leaves out test bookings", async () => {
    const ws = await workspace();
    const other = await workspace();
    const today = await book(ws, 6, 20);
    await book(ws, 6, 21);
    await book(ws, 7, 20, true);
    const theirs = await book(other, 6, 20);
    const snap = await read(ws, "bookings");
    expect(snap.bookings?.count).toBe(1);
    expect(snap.bookings?.items[0]).toMatchObject({ reference: today, minutes: 60 });
    expect(snap.calendar).toBeUndefined();
    expect(snap.payments).toBeUndefined();
    expect(snap.runs).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain(theirs);
    expect(snap.summaryText).toContain(`kymavo bookings (1 today):`);
  });

  it("reads today in the zone given, so a late-evening booking lands on the right day", async () => {
    const ws = await workspace();
    await book(ws, 15, 20); // 23:00 on the 20th in Manila, 15:00 UTC the same day
    expect((await read(ws, "bookings", { timezone: "Asia/Manila" })).bookings?.count).toBe(1);
    // In Los Angeles, "now" is the 19th at 20:00, so the 20th 15:00 UTC booking is tomorrow.
    expect((await read(ws, "bookings", { timezone: "America/Los_Angeles" })).bookings?.count).toBe(0);
  });
});

describe("open unpaid payments", () => {
  it("lists pending live dues of this workspace, never their payment link token", async () => {
    const ws = await workspace();
    const other = await workspace();
    const mk = async (w: Ws, ref: string, amountCentavos: number, test = false) => {
      const run = await newRun(w);
      return createDue(db, { userId: w.id, test, workflowId: w.workflowId, runId: run.id, stepId: "ask", reference: ref, kind: "deposit", amountCentavos });
    };
    const open = await mk(ws, `D-OPEN-${seq}`, 150_000);
    const paid = await mk(ws, `D-PAID-${seq}`, 99_900);
    await db.update(paymentDues).set({ status: "confirmed", confirmedSource: "transfer", confirmedAt: NOW }).where(eq(paymentDues.id, paid.id));
    await mk(ws, `D-TEST-${seq}`, 1_000, true);
    await mk(other, `D-OTHER-${seq}`, 500_000);
    const snap = await read(ws, "payments");
    expect(snap.payments).toMatchObject({ count: 1, totalPesos: "1500.00" });
    expect(snap.payments?.items[0]).toMatchObject({ reference: open.reference, kind: "deposit", amountPesos: "1500.00" });
    const text = JSON.stringify(snap);
    expect(text).not.toContain(open.token);
    expect(text).not.toContain("D-OTHER");
    expect(text).not.toContain("D-PAID");
    expect(snap.summaryText).toContain("Open unpaid payments (1 pending, total PHP 1500.00):");
  });
});

describe("today's runs", () => {
  it("counts this workspace's live runs of today by state and names the problems, without payloads or errors", async () => {
    const ws = await workspace();
    const other = await workspace();
    const at = (h: number, day = 20) => new Date(Date.UTC(2031, 0, day, h));
    await newRun(ws, { state: "succeeded", createdAt: at(1) });
    await newRun(ws, { state: "succeeded", createdAt: at(2) });
    await newRun(ws, { state: "failed", createdAt: at(3), error: "boom sk_live_supersecret", triggerPayload: { card: "4111111111111111" } });
    await newRun(ws, { state: "needs_review", createdAt: at(3) });
    await newRun(ws, { state: "waiting", createdAt: at(3) });
    await newRun(ws, { state: "succeeded", createdAt: at(3), test: true });
    await newRun(ws, { state: "failed", createdAt: at(3, 18) });
    await newRun(other, { state: "failed", createdAt: at(3) });
    const snap = await read(ws, "runs");
    expect(snap.runs).toMatchObject({ total: 5, succeeded: 2, failed: 1, needsReview: 1, waiting: 1 });
    expect(snap.runs?.problems.map((p) => p.state).sort()).toEqual(["failed", "needs_review"]);
    expect(snap.runs?.problems[0]?.workflowName).toContain("Front desk");
    const text = JSON.stringify(snap);
    expect(text).not.toContain("sk_live_supersecret");
    expect(text).not.toContain("4111111111111111");
    expect(text).not.toContain("boom");
  });
});

describe("today's Google Calendar", () => {
  it("says it is not connected when the workspace has no Google Calendar", async () => {
    const ws = await workspace();
    const snap = await read(ws, "calendar");
    expect(snap.calendar).toMatchObject({ connected: false, status: "not_connected", events: [] });
    expect(snap.summaryText).toContain("Google Calendar is not connected");
  });

  it("reads confirmed events through the workspace's own sign-in, and never another workspace's calendar", async () => {
    const ws = await workspace();
    const made = await connectCalendar(ws);
    const cal = fake.calendar(made.calendarId)!;
    cal.events.set("e1", { id: "e1", status: "confirmed", summary: "Facial with Ben", start: { dateTime: "2031-01-20T06:00:00Z" }, end: { dateTime: "2031-01-20T07:00:00Z" }, created: "2031-01-01T00:00:00Z", updated: "2031-01-01T00:00:00Z" });
    cal.events.set("e2", { id: "e2", status: "cancelled", summary: "Cancelled thing", start: { dateTime: "2031-01-20T08:00:00Z" }, end: { dateTime: "2031-01-20T09:00:00Z" } });
    cal.events.set("e3", { id: "e3", status: "confirmed", summary: "Holiday", start: { date: "2031-01-20" }, end: { date: "2031-01-21" }, created: "2031-01-01T00:00:00Z", updated: "2031-01-01T00:00:00Z" });

    const snap = await read(ws, "calendar");
    expect(snap.calendar).toMatchObject({ connected: true, status: "ok", calendarTitle: "kymavo bookings" });
    expect(snap.calendar?.events.map((e) => e.title).sort()).toEqual(["Facial with Ben", "Holiday"]);
    expect(snap.calendar?.events.find((e) => e.title === "Holiday")?.allDay).toBe(true);
    expect(snap.summaryText).toContain("Facial with Ben");
    expect(snap.summaryText).not.toContain("Cancelled thing");

    const stranger = await workspace();
    expect((await read(stranger, "calendar")).calendar?.status).toBe("not_connected");

    // No token or secret ever reaches the snapshot.
    const conn = (await connectionCredential(db, key, ws.id, "google_calendar"))!;
    const text = JSON.stringify(snap);
    expect(text).not.toContain(conn.credential);
    for (const secret of Object.values(JSON.parse(conn.credential) as Record<string, unknown>)) {
      if (typeof secret === "string" && secret.length > 8) expect(text).not.toContain(secret);
    }
  });

  it("asks for a reconnect when the connection failed, lacks scopes, uses a service account, or has no calendar chosen", async () => {
    const ws = await workspace();
    await connectCalendar(ws);
    await db.update(connections).set({ status: "failed" }).where(eq(connections.userId, ws.id));
    expect((await read(ws, "calendar")).calendar).toMatchObject({ connected: false, status: "reconnect_required" });

    await db.update(connections).set({ status: "active", scopes: "openid email" }).where(eq(connections.userId, ws.id));
    expect((await read(ws, "calendar")).calendar).toMatchObject({ connected: false, status: "missing_scope" });

    await db.update(connections).set({ authMethod: "service_account" }).where(eq(connections.userId, ws.id));
    expect((await read(ws, "calendar")).calendar).toMatchObject({ connected: false, status: "unsupported_auth" });

    const noCal = await workspace();
    expect(await (async () => {
      const back = new URL((await fetch(await startFlow(db, key, urls, PUBLIC, googleCalendar, { workspaceId: noCal.id, memberId: noCal.id }), { redirect: "manual" })).headers.get("location")!);
      const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: noCal.id, memberId: noCal.id });
      return finishFlow(db, key, urls, PUBLIC, googleCalendar, noCal.id, back.searchParams.get("code")!, flow!.verifier);
    })()).toBe("connected");
    expect((await read(noCal, "calendar")).calendar).toMatchObject({ connected: false, status: "no_calendar" });
  });
});

describe("telegram conversations (C1 channel, R6)", () => {
  it("keeps both sides of the thread, drops a replayed update, and is exported, deleted and purged like other channels", async () => {
    const ws = await workspace();
    const chat = `${700000000 + seq}`;
    const first = await db.transaction((tx) => recordInbound(tx, { userId: ws.id, channel: "telegram", externalId: chat, mid: `tg:${chat}:1`, text: "What is on today?", at: NOW }));
    expect(first).toMatchObject({ channel: "telegram", externalId: chat, replayed: false, version: 1 });
    const replay = await db.transaction((tx) => recordInbound(tx, { userId: ws.id, channel: "telegram", externalId: chat, mid: `tg:${chat}:1`, text: "What is on today?", at: NOW }));
    expect(replay.replayed).toBe(true);
    expect(await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, first.id))).toHaveLength(1);

    const run = await newRun(ws, { conversationId: first.id, conversationVersion: first.version });
    await recordOutboundReply(db, { conversationId: first.id, runId: run.id, text: "You have one booking at 2 pm." });
    const second = await db.transaction((tx) => recordInbound(tx, { userId: ws.id, channel: "telegram", externalId: chat, mid: `tg:${chat}:2`, text: "And tomorrow?", at: new Date(NOW.getTime() + 1000) }));
    expect(second.version).toBe(2);
    const payload = await conversationPayload(db, second);
    expect(payload.history.map((h) => `${h.direction}: ${h.text}`)).toEqual(["in: What is on today?", "out: You have one booking at 2 pm.", "in: And tomorrow?"]);

    // R6: found by what the guest said, exported, then erased with the conversation.
    const exported = await exportCustomer(db, ws.id, ws.id, { email: "x@none.test" });
    expect(exported.counts.conversations).toBe(0);
    await db.update(conversations).set({ fields: { name: "Ana Reyes", email: "ana.tg@privacy.test" } }).where(eq(conversations.id, first.id));
    const found = await exportCustomer(db, ws.id, ws.id, { email: "ana.tg@privacy.test" });
    expect(found.counts).toMatchObject({ conversations: 1, conversationMessages: 3 });
    const deleted = await deleteCustomer(db, ws.id, ws.id, { email: "ana.tg@privacy.test" });
    expect(deleted.counts.conversations).toBe(1);
    expect(await db.select().from(conversations).where(eq(conversations.id, first.id))).toHaveLength(0);
    expect(await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, first.id))).toHaveLength(0);

    // The retention sweep treats a Telegram chat like any other.
    const old = new Date(NOW.getTime() - 400 * 86_400_000);
    const [stale] = await db.insert(conversations).values({ userId: ws.id, channel: "telegram", externalId: `${chat}9`, lastInboundAt: old, createdAt: old }).returning();
    expect(await purgeConversations(db, NOW)).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(conversations).where(eq(conversations.id, stale!.id))).toHaveLength(0);
  });

  it("refuses a channel outside the check constraint", async () => {
    const ws = await workspace();
    await expect(db.insert(conversations).values({ userId: ws.id, channel: "sms" as never, externalId: "1" })).rejects.toThrow();
    await db.insert(conversations).values({ userId: ws.id, channel: "telegram", externalId: "1" });
    expect((await db.select().from(bookings).where(eq(bookings.userId, ws.id))).length).toBe(0);
  });
});
