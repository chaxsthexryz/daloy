import { generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { bookFromStep, staffChange, type StepAction } from "./bookings";
import { queueCalendarEvent } from "./calendar";
import { connectionCredential, saveConnection } from "./connections";
import { retryDelivery, runDueDeliveries } from "./deliveries";
import { DALOY_CALENDAR_TITLE, ensureCalendar } from "./google-calendar";
import type { Db } from "./index";
import { consumeFlow, finishFlow, googleCalendar, readTokenBlob, startFlow } from "./oauth";
import { calendarEventId, calendarInfo, calendarWriteTest, syncCalendarEvent, type ProviderUrls } from "./providers";
import { withGoogle } from "./google-access";
import { bookings, calendarEvents, connections, deliveries, resources, runs, users, workflows, workflowVersions } from "./schema";

// Decision 0064: Google Calendar through a Google sign-in (calendar.app.created) on the fake's Google OAuth app. The
// service account path keeps its own tests in calendar.test.ts, which this phase did not change.
const key = randomBytes(32);
const PUBLIC = "http://localhost:3000";
const ANA = { id: "google-ana", email: "ana@clinic.example" };
const BEN = { id: "google-ben", email: "ben@clinic.example" };
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

/** A workspace with a resource and a workflow to book against, as calendar.test.ts has one. */
async function workspace() {
  const [u] = await db.insert(users).values({ email: `cal${++seq}@test.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Spa", slug: `spa${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(resources).values({ userId: u!.id, name: "Ana" }).returning();
  return { id: u!.id, workflowId: wf!.id, versionId: v!.id, resourceId: r!.id };
}
type Ws = Awaited<ReturnType<typeof workspace>>;

/** The whole consent for Calendar: start, the fake's consent page, the one-time flow, the code exchange. */
async function connectCalendar(ws: string, who = ANA) {
  fake.oauth.google!.user = who;
  const back = new URL((await fetch(await startFlow(db, key, urls, PUBLIC, googleCalendar, { workspaceId: ws, memberId: ws }), { redirect: "manual" })).headers.get("location")!);
  const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: ws, memberId: ws });
  return finishFlow(db, key, urls, PUBLIC, googleCalendar, ws, back.searchParams.get("code")!, flow!.verifier);
}
/** Connect, then make Daloy's calendar, as the callback does. */
async function connectedWithCalendar(who = ANA) {
  const ws = await workspace();
  expect(await connectCalendar(ws.id, who)).toBe("connected");
  const made = await ensureCalendar(db, key, urls, ws.id);
  return { ws, made };
}
const conn = async (ws: string) => (await connectionCredential(db, key, ws, "google_calendar"))!;
const hour = (h: number, day = 20) => new Date(Date.UTC(2031, 0, day, h));
const deliver = () => runDueDeliveries(db, key, urls);
const newRun = async (ws: Ws) => (await db.insert(runs).values({ workflowVersionId: ws.versionId }).returning())[0]!.id;
const book = async (ws: Ws, a: StepAction, runId?: string) => {
  const id = runId ?? (await newRun(ws));
  const r = await bookFromStep(db, { workspaceId: ws.id, test: false, runId: id, stepId: "book", workflowId: ws.workflowId }, a);
  return { runId: id, ...r };
};
/** Books a slot and runs its calendar step, as the workflow does. */
async function bookedWithEvent(ws: Ws, day: number) {
  const b = await book(ws, { action: "create", resourceId: ws.resourceId, start: hour(6, day), minutes: 60, timezone: "Asia/Manila" });
  const reference = String(b.output.reference);
  const delivery = (await queueCalendarEvent(db, { userId: ws.id, runId: b.runId, stepId: "calendar", title: `Ana ${reference}`, description: "Massage" }))!;
  const [row] = await db.select().from(bookings).where(eq(bookings.reference, reference));
  return { ...b, reference, id: row!.id, delivery };
}
const delivery = async (reference: string, stepId: string) => (await db.select().from(deliveries).where(and(eq(deliveries.reference, reference), eq(deliveries.stepId, stepId))))[0]!;

describe("the Calendar definition", () => {
  it("connects with calendar.app.created and the account's stable id, and saves nothing on a decline or a narrower grant", async () => {
    const ws = await workspace();
    expect(await connectCalendar(ws.id)).toBe("connected");
    const [c] = await db.select().from(connections).where(eq(connections.userId, ws.id));
    expect(c).toMatchObject({ provider: "google_calendar", authMethod: "oauth", externalId: ANA.id, account: ANA.email, scopes: "openid email https://www.googleapis.com/auth/calendar.app.created", destination: null });

    expect(googleCalendar.outcome("access_denied", "")).toBe("declined");
    const narrow = await workspace();
    Object.assign(fake.oauth.google!, { consent: "narrow", grantScopes: ["openid", "email"] });
    expect(await connectCalendar(narrow.id)).toBe("missing_scope");
    expect(await db.select().from(connections).where(eq(connections.userId, narrow.id))).toEqual([]);
  });
});

describe("Daloy's own calendar", () => {
  it("is created once, named Daloy bookings, and reused on a reconnect with the same account", async () => {
    const { ws, made } = await connectedWithCalendar();
    expect(made.title).toBe(DALOY_CALENDAR_TITLE);
    expect(fake.calendar(made.calendarId)).toMatchObject({ title: "Daloy bookings", createdBy: ANA.email });
    expect(await ensureCalendar(db, key, urls, ws.id)).toEqual(made);
    expect(await connectCalendar(ws.id, ANA)).toBe("connected");
    expect(await ensureCalendar(db, key, urls, ws.id)).toEqual(made);
    expect((await conn(ws.id)).destination).toEqual(made);
  });

  it("is cleared by another Google account, which then gets a calendar of its own while the old one keeps its events", async () => {
    const { ws, made } = await connectedWithCalendar();
    expect(await connectCalendar(ws.id, BEN)).toBe("connected");
    expect((await conn(ws.id)).destination).toBeNull();
    const second = await ensureCalendar(db, key, urls, ws.id);
    expect(second.calendarId).not.toBe(made.calendarId);
    expect(fake.calendar(second.calendarId)).toMatchObject({ createdBy: BEN.email });
    expect(fake.calendar(made.calendarId)).toMatchObject({ createdBy: ANA.email });
  });

  it("makes a new one only when asked (the old one was deleted by hand), and refuses a service account", async () => {
    const { ws, made } = await connectedWithCalendar();
    const again = await ensureCalendar(db, key, urls, ws.id, { again: true });
    expect(again.calendarId).not.toBe(made.calendarId);
    expect((await conn(ws.id)).destination).toEqual(again);

    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = "calendar@clinic.iam.gserviceaccount.com";
    fake.addServiceAccount(sa, publicKey.export({ type: "spki", format: "pem" }).toString());
    const other = await workspace();
    await saveConnection(db, key, other.id, "google_calendar", { account: sa, credential: JSON.stringify({ client_email: sa, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }), destination: null });
    await expect(ensureCalendar(db, key, urls, other.id)).rejects.toMatchObject({ kind: "invalid" });
    await expect(ensureCalendar(db, key, urls, (await workspace()).id)).rejects.toMatchObject({ kind: "invalid" });
  });

  it("is reachable only for calendars Daloy created: another calendar of the same account answers as not found (calendar.app.created)", async () => {
    const { ws } = await connectedWithCalendar();
    fake.addCalendar("theirs@group.calendar.google.com", "Personal", [ANA.email]);
    const c = await conn(ws.id);
    await expect(withGoogle(db, key, urls, ws.id, "google_calendar", c, (auth) => calendarInfo(urls, auth, "theirs@group.calendar.google.com"))).rejects.toMatchObject({ kind: "permission", message: expect.stringMatching(/Create a new Daloy calendar/) });
  });
});

describe("events through the OAuth token", () => {
  it("proves write access with a test event and removes it", async () => {
    const { ws, made } = await connectedWithCalendar();
    const c = await conn(ws.id);
    expect(await withGoogle(db, key, urls, ws.id, "google_calendar", c, (auth) => calendarWriteTest(urls, auth, made.calendarId), { force: true })).toEqual({ created: true, deleted: true });
    expect([...fake.calendar(made.calendarId)!.events.values()].map((e) => e.status)).toEqual(["cancelled"]);
  });

  it("creates the event once, moves it when the booking is rescheduled, and deletes it when staff cancel", async () => {
    const { ws, made } = await connectedWithCalendar();
    const cal = fake.calendar(made.calendarId)!;
    const b = await bookedWithEvent(ws, 20);
    await deliver();
    const id = calendarEventId(b.id);
    expect(cal.events.get(id)).toMatchObject({ status: "confirmed", summary: `Ana ${b.reference}`, start: { dateTime: "2031-01-20T06:00:00.000Z", timeZone: "Asia/Manila" } });
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "delivered", result: { event: "created" } });
    // The step running again, and the delivery sent again, create nothing new.
    await queueCalendarEvent(db, { userId: ws.id, runId: b.runId, stepId: "calendar", title: "Ana", description: "Massage" });
    expect(cal.events.size).toBe(1);

    await book(ws, { action: "reschedule", reference: b.reference, start: hour(8, 20) });
    await deliver();
    expect(cal.events.get(id)).toMatchObject({ status: "confirmed", start: { dateTime: "2031-01-20T08:00:00.000Z" } });
    expect(await delivery(b.reference, "calendar:v2")).toMatchObject({ state: "delivered", result: { event: "updated" } });

    expect((await staffChange(db, { workspaceId: ws.id, bookingId: b.id, version: 2, action: "cancel" }, "user:test")).result).toBe("done");
    await deliver();
    expect(cal.events.get(id)!.status).toBe("cancelled");
    expect(await delivery(b.reference, "calendar:v3")).toMatchObject({ state: "delivered", result: { event: "deleted" } });
    // The event row remembers the account and calendar of its last write.
    expect((await db.select().from(calendarEvents).where(eq(calendarEvents.bookingId, b.id)))[0]).toMatchObject({ account: ANA.email, calendarId: made.calendarId });
  });

  it("refreshes once when Google refuses an access token that looked fresh", async () => {
    const { ws, made } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 21);
    fake.oauth.google!.accessTokens.clear();
    const calls = fake.oauth.google!.tokenCalls;
    await deliver();
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "delivered" });
    expect(fake.oauth.google!.tokenCalls).toBe(calls + 1);
    expect(fake.calendar(made.calendarId)!.events.size).toBe(1);
  });

  it("does not create a second event when the first request arrived but its answer was lost", async () => {
    const { ws, made } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 22);
    fake.once("/events", "hang-after");
    await deliver();
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "queued", errorKind: "ambiguous", checkFirst: true });
    await db.update(deliveries).set({ nextAttemptAt: new Date() }).where(eq(deliveries.id, b.delivery.id));
    await deliver();
    expect(fake.calendar(made.calendarId)!.events.size).toBe(1);
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "delivered", result: { event: "updated" } });
  });

  it("fails as a permission problem that says to create a new calendar when Daloy's calendar was deleted by hand, and keeps the connection", async () => {
    const { ws, made } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 23);
    fake.calendar(made.calendarId)!.editors.clear();
    await deliver();
    const d = await delivery(b.reference, "calendar");
    expect(d).toMatchObject({ state: "failed", errorKind: "permission" });
    expect(d.lastError).toMatch(/Create a new Daloy calendar/);
    expect((await conn(ws.id)).status).toBe("active");
  });

  it("marks the connection failed when Google refuses the grant itself", async () => {
    const { ws } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 24);
    fake.oauth.google!.refreshTokens.clear();
    fake.oauth.google!.accessTokens.clear();
    await deliver();
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "failed", errorKind: "auth" });
    expect((await conn(ws.id)).status).toBe("failed");
  });

  it("puts no token in a delivery, an error, the event row or the event Google holds", async () => {
    const { ws, made } = await connectedWithCalendar();
    const token = readTokenBlob((await conn(ws.id)).credential);
    const b = await bookedWithEvent(ws, 25);
    await deliver();
    fake.calendar(made.calendarId)!.editors.clear();
    const lost = await bookedWithEvent(ws, 26);
    await deliver();
    const seen = JSON.stringify([await db.select().from(deliveries).where(eq(deliveries.userId, ws.id)), await db.select().from(calendarEvents).where(eq(calendarEvents.userId, ws.id)), [...fake.calendar(made.calendarId)!.events.values()]]);
    expect(await delivery(lost.reference, "calendar")).toMatchObject({ state: "failed" });
    expect(b.reference).toBeTruthy();
    for (const secret of [token.accessToken, token.refreshToken]) expect(seen).not.toContain(secret);
    expect(seen).not.toMatch(/google-(access|refresh)-/);
  });
});

describe("M11: an event stays tied to the calendar it was written to", () => {
  it("holds a reschedule for review when another Google account reconnected, and writes nothing to its new calendar", async () => {
    const { ws, made } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 10);
    await deliver();
    const id = calendarEventId(b.id);
    await connectCalendar(ws.id, BEN);
    const second = await ensureCalendar(db, key, urls, ws.id);
    await book(ws, { action: "reschedule", reference: b.reference, start: hour(8, 10) });
    await deliver();
    const held = await delivery(b.reference, "calendar:v2");
    expect(held).toMatchObject({ state: "needs_review", errorKind: "destination_changed" });
    expect(held.lastError).toContain("still in");
    expect(fake.calendar(second.calendarId)!.events.size).toBe(0);
    expect(fake.calendar(made.calendarId)!.events.get(id)).toMatchObject({ status: "confirmed", start: { dateTime: "2031-01-10T06:00:00.000Z" } });
    // Post again binds the event to the new calendar, on the owner's say-so.
    await retryDelivery(db, ws.id, held.id, { postAgain: true });
    await deliver();
    expect(fake.calendar(second.calendarId)!.events.size).toBe(1);
    expect((await db.select().from(calendarEvents).where(eq(calendarEvents.bookingId, b.id)))[0]).toMatchObject({ account: BEN.email, calendarId: second.calendarId });
  });

  it("holds a cancel the same way", async () => {
    const { ws, made } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 11);
    await deliver();
    await connectCalendar(ws.id, BEN);
    await ensureCalendar(db, key, urls, ws.id);
    await staffChange(db, { workspaceId: ws.id, bookingId: b.id, version: 1, action: "cancel" }, "user:test");
    await deliver();
    expect(await delivery(b.reference, "calendar:v2")).toMatchObject({ state: "needs_review", errorKind: "destination_changed" });
    expect(fake.calendar(made.calendarId)!.events.get(calendarEventId(b.id))!.status).toBe("confirmed");
  });

  it("holds a delivery when the owner replaces a deleted calendar with a new one", async () => {
    const { ws } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 12);
    await ensureCalendar(db, key, urls, ws.id, { again: true });
    await deliver();
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "needs_review", errorKind: "destination_changed" });
  });
});

describe("pinned deliveries across re-authorization (R7)", () => {
  it("same account: the calendar is kept, the queued event goes in with the new token, and the old token is gone", async () => {
    const { ws, made } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 13);
    const before = readTokenBlob((await conn(ws.id)).credential).refreshToken;
    expect(await connectCalendar(ws.id, ANA)).toBe("connected");
    expect(readTokenBlob((await conn(ws.id)).credential).refreshToken).not.toBe(before);
    expect((await conn(ws.id)).destination).toEqual(made);
    await deliver();
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "delivered" });
    expect(fake.calendar(made.calendarId)!.events.size).toBe(1);
  });

  it("same account whose email changed: still the same calendar, so it goes in", async () => {
    const { ws, made } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 14);
    // The fake keys a calendar's owner by address (Google keys it by account), so it follows the rename.
    Object.assign(fake.calendar(made.calendarId)!, { createdBy: "ana.new@clinic.example" }).editors.add("ana.new@clinic.example");
    expect(await connectCalendar(ws.id, { id: ANA.id, email: "ana.new@clinic.example" })).toBe("connected");
    expect(await conn(ws.id)).toMatchObject({ account: "ana.new@clinic.example", destination: made });
    await deliver();
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "delivered" });
  });

  it("another account: a new calendar, so the queued event goes to review", async () => {
    const { ws } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 15);
    await connectCalendar(ws.id, BEN);
    await ensureCalendar(db, key, urls, ws.id);
    await deliver();
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "needs_review", errorKind: "destination_changed" });
  });

  it("another account before its calendar exists: the delivery waits as 'no calendar chosen', nothing is written", async () => {
    const { ws, made } = await connectedWithCalendar();
    const b = await bookedWithEvent(ws, 16);
    await connectCalendar(ws.id, BEN);
    await deliver();
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "failed", errorKind: "no_destination" });
    expect(fake.calendar(made.calendarId)!.events.size).toBe(0);
  });
});

describe("the service account path does not change", () => {
  it("still signs with the key, and a delivery with a service account still compares the account", async () => {
    const email = "daloy@clinic.iam.gserviceaccount.com";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    fake.addServiceAccount(email, publicKey.export({ type: "spki", format: "pem" }).toString());
    const calendarId = `sa${++seq}@group.calendar.google.com`;
    const cal = fake.addCalendar(calendarId, "Clinic", [email]);
    const credential = JSON.stringify({ client_email: email, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    const ws = await workspace();
    await saveConnection(db, key, ws.id, "google_calendar", { account: email, credential, destination: { calendarId, title: "Clinic" } });
    const b = await bookedWithEvent(ws, 17);
    // A different service account address with the same calendar: the account differs, so it is held, as before.
    const other = "other@clinic.iam.gserviceaccount.com";
    await saveConnection(db, key, ws.id, "google_calendar", { account: other, credential, destination: { calendarId, title: "Clinic" } });
    await deliver();
    expect(await delivery(b.reference, "calendar")).toMatchObject({ state: "needs_review", errorKind: "destination_changed" });
    expect(cal.events.size).toBe(0);
    await saveConnection(db, key, ws.id, "google_calendar", { account: email, credential, destination: { calendarId, title: "Clinic" } });
    await retryDelivery(db, ws.id, b.delivery.id, { postAgain: true });
    await deliver();
    expect(cal.events.size).toBe(1);
    const c = await conn(ws.id);
    expect(c.authMethod).toBe("service_account");
    expect(await syncCalendarEvent(urls, JSON.parse(c.credential), calendarId, b.id, { status: "cancelled", start: hour(6), end: hour(7), timezone: "Asia/Manila" }, { title: "", description: "" })).toMatchObject({ event: "deleted" });
  });
});
