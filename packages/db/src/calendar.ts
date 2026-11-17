import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./index";
import { bookings, calendarEvents, connections, deliveries, runs } from "./schema";

/**
 * Google Calendar events for bookings (decision 0043). A calendar step records that a booking has an event; after that,
 * every change to the booking queues one sync delivery for its new version. Each delivery makes the calendar match the
 * booking as it is when the delivery is sent, so the order they arrive in never matters.
 */
type Q = Pick<Db, "select" | "insert">;

/** Queues a delivery pinned to the calendar connection as it is now (empty pin: nothing connected yet, pinned on first send). */
async function queueSync(q: Q, d: { userId: string; runId: string; stepId: string; reference: string; bookingId: string }) {
  const [conn] = await q.select({ account: connections.account, destination: connections.destination }).from(connections).where(and(eq(connections.userId, d.userId), eq(connections.provider, "google_calendar")));
  await q
    .insert(deliveries)
    .values({ userId: d.userId, runId: d.runId, stepId: d.stepId, provider: "google_calendar", reference: d.reference, payload: { bookingId: d.bookingId }, pinnedAccount: conn?.account ?? "", pinnedDestination: conn?.destination ?? null })
    .onConflictDoNothing({ target: [deliveries.runId, deliveries.stepId] });
  const [row] = await q.select().from(deliveries).where(and(eq(deliveries.runId, d.runId), eq(deliveries.stepId, d.stepId)));
  return row!;
}

/**
 * The calendar step: remembers the event's title and description for the run's booking and queues its first sync. A
 * run with no booking, or a booking of another workspace, queues nothing and returns null. A step that runs again
 * (a rescheduled run) updates the text and gets the first delivery back.
 */
export async function queueCalendarEvent(db: Db, a: { userId: string; runId: string; stepId: string; title: string; description: string }) {
  return db.transaction(async (tx) => {
    const [run] = await tx.select({ bookingId: runs.bookingId }).from(runs).where(eq(runs.id, a.runId));
    if (!run?.bookingId) return null;
    const [b] = await tx.select({ reference: bookings.reference }).from(bookings).where(and(eq(bookings.id, run.bookingId), eq(bookings.userId, a.userId)));
    if (!b) return null;
    await tx
      .insert(calendarEvents)
      .values({ bookingId: run.bookingId, userId: a.userId, title: a.title, description: a.description })
      .onConflictDoUpdate({ target: calendarEvents.bookingId, set: { title: a.title, description: a.description, updatedAt: sql`now()` } });
    return queueSync(tx, { userId: a.userId, runId: a.runId, stepId: a.stepId, reference: b.reference, bookingId: run.bookingId });
  });
}

/**
 * Called inside the transaction that reschedules or cancels a booking: when it has a calendar event, one sync for the
 * new version rides on the run that made the change (a cancel by staff has none of its own, so the booking's last run).
 */
export async function queueCalendarSync(q: Q, bookingId: string, version: number, runId: string | null) {
  if (!runId) return; // shortcut: a booking whose run was deleted gets no sync; its event stays until someone removes it
  const [ev] = await q.select({ userId: calendarEvents.userId }).from(calendarEvents).where(eq(calendarEvents.bookingId, bookingId));
  if (!ev) return;
  const [b] = await q.select({ reference: bookings.reference }).from(bookings).where(eq(bookings.id, bookingId));
  await queueSync(q, { userId: ev.userId, runId, stepId: `calendar:v${version}`, reference: b!.reference, bookingId });
}

/** The booking as the calendar should show it, with its event text. Undefined: no such booking of this workspace, or no event recorded. */
export async function bookingForCalendar(db: Db, userId: string, bookingId: string) {
  const [r] = await db
    .select({
      status: bookings.status,
      timezone: bookings.timezone,
      start: sql<Date>`lower(${bookings.during})`.mapWith((v: string | Date) => new Date(v)),
      end: sql<Date>`upper(${bookings.during})`.mapWith((v: string | Date) => new Date(v)),
      title: calendarEvents.title,
      description: calendarEvents.description,
    })
    .from(bookings)
    .innerJoin(calendarEvents, eq(calendarEvents.bookingId, bookings.id))
    .where(and(eq(bookings.id, bookingId), eq(bookings.userId, userId)));
  return r;
}
