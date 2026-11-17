import { generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { bookFromStep, staffChange, type StepAction } from "./bookings";
import { queueCalendarEvent } from "./calendar";
import { saveConnection } from "./connections";
import { deliveryBookingMoved, retryDelivery, runDueDeliveries } from "./deliveries";
import type { Db } from "./index";
import { calendarEventId, calendarIdFrom, type ProviderUrls } from "./providers";
import { bookings, deliveries, resources, runs, users, workflows, workflowVersions } from "./schema";

// Decision 0043: one Google Calendar event per booking, with an id derived from the booking, kept equal to the booking
// by sync deliveries that can be repeated without harm.
const key = randomBytes(32);
const CAL = "clinic@group.calendar.google.com";
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let cal: ReturnType<FakeProviders["addCalendar"]>;
let userId: string;
let workflowVersionId: string;
let resourceId: string;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  urls = { ...fake.urls, timeoutMs: 300 };
  const email = "daloy@project.iam.gserviceaccount.com";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fake.addServiceAccount(email, publicKey.export({ type: "spki", format: "pem" }).toString());
  cal = fake.addCalendar(CAL, "Clinic", [email]);
  const [u] = await db.insert(users).values({ email: "owner@test.local", passwordHash: "x" }).returning();
  userId = u!.id;
  const [wf] = await db.insert(workflows).values({ userId, name: "Spa", slug: "spa" }).returning();
  workflowVersionId = (await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning())[0]!.id;
  resourceId = (await db.insert(resources).values({ userId, name: "Ana" }).returning())[0]!.id;
  await saveConnection(db, key, userId, "google_calendar", {
    account: email,
    credential: JSON.stringify({ client_email: email, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }),
    destination: { calendarId: CAL, title: "Clinic" },
  });
  workflowId = wf!.id;
}, 120_000);
let workflowId: string;
afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

const newRun = async () => (await db.insert(runs).values({ workflowVersionId }).returning())[0]!.id;
const book = async (a: StepAction, runId?: string) => {
  const id = runId ?? (await newRun());
  const r = await bookFromStep(db, { workspaceId: userId, test: false, runId: id, stepId: "book", workflowId }, a);
  return { runId: id, ...r };
};
const hour = (h: number, day = 20) => new Date(Date.UTC(2031, 0, day, h));
const deliver = () => runDueDeliveries(db, key, urls);
const events = () => [...cal.events.values()];
const bookingId = async (reference: string) => (await db.select().from(bookings).where(eq(bookings.reference, reference)))[0]!.id;
/** Books a slot and runs its calendar step, as the workflow does. */
async function bookedWithEvent(day: number) {
  const b = await book({ action: "create", resourceId, start: hour(6, day), minutes: 60, timezone: "Asia/Manila" });
  const reference = String(b.output.reference);
  const d = await queueCalendarEvent(db, { userId, runId: b.runId, stepId: "calendar", title: `Ana ${reference}`, description: "Massage" });
  return { ...b, reference, id: await bookingId(reference), delivery: d! };
}

describe("the event id", () => {
  it("is the same for a booking every time, and a valid Calendar id (a-v and 0-9, 5 to 1024 characters)", () => {
    const id = "6f1c0c1e-8a62-4f0e-b3a3-0d4d3c6c2a11";
    expect(calendarEventId(id)).toBe(calendarEventId(id));
    expect(calendarEventId(id)).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(calendarEventId(id)).not.toBe(calendarEventId("6f1c0c1e-8a62-4f0e-b3a3-0d4d3c6c2a12"));
  });
  it("accepts a calendar id and refuses a link or text", () => {
    expect(calendarIdFrom(" clinic@group.calendar.google.com ")).toBe(CAL);
    expect(calendarIdFrom("ana@gmail.com")).toBe("ana@gmail.com");
    expect(calendarIdFrom("https://calendar.google.com/calendar/u/0?cid=abc")).toBeNull();
    expect(calendarIdFrom("not an id")).toBeNull();
  });
});

describe("create, update and cancel", () => {
  it("creates the event once, in the booking's own zone, however often the step or the delivery is repeated", async () => {
    const b = await bookedWithEvent(20);
    // The step running again (a retry) gets the first delivery back.
    const again = await queueCalendarEvent(db, { userId, runId: b.runId, stepId: "calendar", title: "Ana", description: "Massage" });
    expect(again!.id).toBe(b.delivery.id);
    await deliver();
    expect(events()).toHaveLength(1);
    const e = cal.events.get(calendarEventId(b.id))!;
    expect(e).toMatchObject({ status: "confirmed", summary: "Ana", description: "Massage", start: { dateTime: "2031-01-20T06:00:00.000Z", timeZone: "Asia/Manila" }, end: { dateTime: "2031-01-20T07:00:00.000Z", timeZone: "Asia/Manila" } });
    expect((await db.select().from(deliveries).where(eq(deliveries.id, b.delivery.id)))[0]).toMatchObject({ state: "delivered", result: { event: "created" } });
  });

  it("does not create a second event when the first request arrived but its answer was lost", async () => {
    const b = await bookedWithEvent(21);
    fake.once("/events", "hang-after");
    await deliver();
    const lost = (await db.select().from(deliveries).where(eq(deliveries.id, b.delivery.id)))[0]!;
    expect(lost).toMatchObject({ state: "queued", errorKind: "ambiguous", checkFirst: true });
    expect(events().filter((x) => x.id === calendarEventId(b.id))).toHaveLength(1);
    await db.update(deliveries).set({ nextAttemptAt: new Date() }).where(eq(deliveries.id, b.delivery.id));
    await deliver();
    expect(events().filter((x) => x.id === calendarEventId(b.id))).toHaveLength(1);
    expect((await db.select().from(deliveries).where(eq(deliveries.id, b.delivery.id)))[0]).toMatchObject({ state: "delivered", result: { event: "updated" } });
  });

  it("moves the event when the booking is rescheduled, by a step or by staff, and the old time never lingers", async () => {
    const b = await bookedWithEvent(22);
    await deliver();
    const id = calendarEventId(b.id);
    // A reschedule step on another run.
    await book({ action: "reschedule", reference: b.reference, start: hour(8, 22) });
    await deliver();
    expect(cal.events.get(id)!.start).toMatchObject({ dateTime: "2031-01-22T08:00:00.000Z" });
    // Staff reschedule: a new run is made for it.
    const staff = await staffChange(
      db,
      { workspaceId: userId, bookingId: b.id, version: 2, action: "reschedule", start: hour(9, 22), newRun: () => newRun() },
      "user:test",
    );
    expect(staff.result).toBe("done");
    await deliver();
    expect(cal.events.get(id)).toMatchObject({ status: "confirmed", start: { dateTime: "2031-01-22T09:00:00.000Z" }, end: { dateTime: "2031-01-22T10:00:00.000Z" } });
    expect(events().filter((x) => x.id === id)).toHaveLength(1);
  });

  it("queues exactly one sync per booking version and none for a booking with no event", async () => {
    const b = await bookedWithEvent(23);
    await deliver();
    await book({ action: "reschedule", reference: b.reference, start: hour(8, 23) });
    const syncs = async () => (await db.select({ stepId: deliveries.stepId }).from(deliveries).where(and(eq(deliveries.provider, "google_calendar"), eq(deliveries.reference, b.reference)))).map((d) => d.stepId).sort();
    expect(await syncs()).toEqual(["calendar", "calendar:v2"]);
    const plain = await book({ action: "create", resourceId, start: hour(6, 24), minutes: 60, timezone: "Asia/Manila" });
    await book({ action: "cancel", reference: String(plain.output.reference) });
    expect(await db.select().from(deliveries).where(eq(deliveries.reference, String(plain.output.reference)))).toEqual([]);
  });

  it("deletes the event when the booking is cancelled, whether or not the event was ever created, and again is harmless", async () => {
    const made = await bookedWithEvent(25);
    await deliver();
    const id = calendarEventId(made.id);
    expect(cal.events.get(id)!.status).toBe("confirmed");
    const cancelled = await staffChange(db, { workspaceId: userId, bookingId: made.id, version: 1, action: "cancel" }, "user:test");
    expect(cancelled.result).toBe("done");
    await deliver();
    expect(cal.events.get(id)!.status).toBe("cancelled");
    const [sync] = await db.select().from(deliveries).where(and(eq(deliveries.reference, made.reference), eq(deliveries.stepId, "calendar:v2")));
    expect(sync).toMatchObject({ state: "delivered", result: { event: "deleted" } });
    // Retry on a sync of a cancelled booking is allowed, and deleting what is already gone is a success.
    await db.update(deliveries).set({ state: "failed" }).where(eq(deliveries.id, sync!.id));
    expect(await deliveryBookingMoved(db, userId, sync!.id)).toBe(false);
    expect(await retryDelivery(db, userId, sync!.id)).toBe(true);
    await deliver();
    expect((await db.select().from(deliveries).where(eq(deliveries.id, sync!.id)))[0]).toMatchObject({ state: "delivered", result: { event: "deleted" } });

    // Cancelled before the first delivery was sent: nothing is created at all.
    const early = await bookedWithEvent(26);
    await staffChange(db, { workspaceId: userId, bookingId: early.id, version: 1, action: "cancel" }, "user:test");
    await deliver();
    expect(cal.events.get(calendarEventId(early.id))).toBeUndefined();
    expect((await db.select().from(deliveries).where(eq(deliveries.id, early.delivery.id)))[0]).toMatchObject({ state: "delivered", result: { event: "deleted" } });
  });

  it("says what to do when the calendar is not shared with the service account", async () => {
    const b = await bookedWithEvent(27);
    cal.editors.clear();
    await deliver();
    const d = (await db.select().from(deliveries).where(eq(deliveries.id, b.delivery.id)))[0]!;
    expect(d).toMatchObject({ state: "failed", errorKind: "permission" });
    expect(d.lastError).toContain("daloy@project.iam.gserviceaccount.com");
    cal.editors.add("daloy@project.iam.gserviceaccount.com");
  });
});
