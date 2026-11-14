import { randomInt } from "node:crypto";
import { formatZoned } from "@daloy/engine";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./index";
import { bookingChanges, bookingResults, bookings, resources, runs } from "./schema";

/**
 * Bookings (decision 0032). The exclusion constraint bookings_no_overlap (migration 0019) is the only availability
 * check: a change that would overlap an active booking of the same workspace, test scope and resource fails with
 * 23P01 inside a savepoint and is answered "taken". Every change raises the version and is logged in booking_changes.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof bookings.$inferSelect;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// shortcut: 32^6 random references; a collision fails that attempt (the step retries with a new one). Lengthen when volume grows.
const newReference = (test: boolean) => `${test ? "TEST" : "BK"}-${Array.from({ length: 6 }, () => ALPHABET[randomInt(32)]).join("")}`;

const isOverlap = (err: unknown) => {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) if ((e as { code?: string }).code === "23P01") return true;
  return false;
};

const range = (start: Date, end: Date) => sql`tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)')`;
const startOf = sql<Date>`lower(${bookings.during})`.mapWith((v: string | Date) => new Date(v));
const endOf = sql<Date>`upper(${bookings.during})`.mapWith((v: string | Date) => new Date(v));
const withTimes = { row: bookings, start: startOf, end: endOf, resourceName: resources.name };

export type BookingView = {
  id: string;
  reference: string;
  resource: { id: string; name: string };
  start: string;
  end: string;
  minutes: number;
  timezone: string;
  status: "active" | "cancelled";
  version: number;
};

function view(b: { row: Row; start: Date; end: Date; resourceName: string }): BookingView {
  const { row } = b;
  return {
    id: row.id,
    reference: row.reference,
    resource: { id: row.resourceId, name: b.resourceName },
    start: formatZoned(b.start, row.timezone),
    end: formatZoned(b.end, row.timezone),
    minutes: Math.round((b.end.getTime() - b.start.getTime()) / 60_000),
    timezone: row.timezone,
    status: row.status,
    version: row.version,
  };
}

/** Locks and reads one booking with its times. */
async function lockBooking(tx: Tx, where: ReturnType<typeof and>) {
  const [b] = await tx.select(withTimes).from(bookings).innerJoin(resources, eq(resources.id, bookings.resourceId)).where(where).for("update", { of: bookings });
  return b;
}

/** Inside a savepoint, so an overlap leaves the outer transaction usable. Returns false when the time is taken. */
async function unlessTaken(tx: Tx, write: (sp: Tx) => Promise<void>): Promise<boolean> {
  try {
    await tx.transaction(write);
    return true;
  } catch (err) {
    if (isOverlap(err)) return false;
    throw err;
  }
}

export type StepAction =
  | { action: "create"; resourceId: string; start: Date; minutes: number; timezone: string }
  | { action: "reschedule"; reference: string; start: Date; minutes?: number }
  | { action: "cancel"; reference: string };
export type StepBookingResult = { branch: "done" | "taken" | "not_found"; output: Record<string, unknown> };

/**
 * One booking step attempt, in one transaction: a stored result for this run and step is returned as it was (a retry
 * or takeover never books twice); otherwise the booking changes, the run is linked to the new version, and the result
 * is stored. A test run only sees and makes test bookings.
 */
export async function bookFromStep(db: Db, at: { workspaceId: string; test: boolean; runId: string; stepId: string; workflowId: string }, a: StepAction): Promise<StepBookingResult> {
  return db.transaction(async (tx) => {
    const [stored] = await tx.select().from(bookingResults).where(and(eq(bookingResults.runId, at.runId), eq(bookingResults.stepId, at.stepId)));
    if (stored) return { branch: stored.branch as StepBookingResult["branch"], output: stored.output as Record<string, unknown> };
    if (a.action !== "cancel" && a.start.getTime() <= Date.now()) throw new Error(`The booking time has passed (${a.start.toISOString()}).`);

    let result: StepBookingResult;
    let bookingId: string | null = null;
    const link = async (w: Tx, id: string, version: number) => {
      await w.update(runs).set({ bookingId: id, bookingVersion: version }).where(eq(runs.id, at.runId));
      await w.update(bookings).set({ runId: at.runId }).where(eq(bookings.id, id));
    };

    if (a.action === "create") {
      // Checked here, in the transaction that books, so a resource archived a moment ago is not booked.
      const [resource] = await tx.select().from(resources).where(and(eq(resources.id, a.resourceId), eq(resources.userId, at.workspaceId), eq(resources.active, true)));
      if (!resource) {
        result = { branch: "not_found", output: { reason: "There is no active resource with that id in this workspace." } };
      } else {
        const end = new Date(a.start.getTime() + a.minutes * 60_000);
        let created: Row | undefined;
        const free = await unlessTaken(tx, async (sp) => {
          [created] = await sp
            .insert(bookings)
            .values({ userId: at.workspaceId, test: at.test, reference: newReference(at.test), resourceId: resource.id, during: range(a.start, end) as unknown as string, timezone: a.timezone, workflowId: at.workflowId })
            .returning();
          await sp.insert(bookingChanges).values({ bookingId: created!.id, fromVersion: 0, action: "create", start: a.start, runId: at.runId, actor: `run:${at.runId}`, result: { version: 1 } });
          await link(sp, created!.id, 1);
        });
        if (!free) result = { branch: "taken", output: { reason: "That time is already booked for this resource." } };
        else {
          bookingId = created!.id;
          result = { branch: "done", output: view({ row: created!, start: a.start, end, resourceName: resource.name }) };
        }
      }
    } else {
      const b = await lockBooking(tx, and(eq(bookings.userId, at.workspaceId), eq(bookings.test, at.test), eq(bookings.reference, a.reference)));
      if (!b || b.row.status !== "active") {
        result = { branch: "not_found", output: { reason: "There is no active booking with that reference." } };
      } else {
        bookingId = b.row.id;
        const version = b.row.version + 1;
        const start = a.action === "reschedule" ? a.start : b.start;
        const end = a.action === "reschedule" ? new Date(a.start.getTime() + (a.minutes !== undefined ? a.minutes * 60_000 : b.end.getTime() - b.start.getTime())) : b.end;
        const status = a.action === "cancel" ? ("cancelled" as const) : ("active" as const);
        const free = await unlessTaken(tx, async (sp) => {
          await sp.update(bookings).set({ during: range(start, end) as unknown as string, status, version, updatedAt: new Date() }).where(and(eq(bookings.id, b.row.id), eq(bookings.version, b.row.version)));
          await sp.insert(bookingChanges).values({ bookingId: b.row.id, fromVersion: b.row.version, action: a.action, start: a.action === "reschedule" ? start : null, runId: at.runId, actor: `run:${at.runId}`, result: { version } });
          await link(sp, b.row.id, version);
        });
        result = free
          ? { branch: "done", output: view({ row: { ...b.row, status, version }, start, end, resourceName: b.resourceName }) }
          : { branch: "taken", output: { reason: "That time is already booked for this resource." } };
      }
    }
    await tx.insert(bookingResults).values({ runId: at.runId, stepId: at.stepId, bookingId, branch: result.branch, output: result.output });
    return result;
  });
}

export type StaffRequest = { workspaceId: string; bookingId: string; version: number } & (
  | { action: "cancel" }
  // newRun starts the run for the new version, in the same transaction, and returns its id.
  | { action: "reschedule"; start: Date; newRun: (tx: Tx, booking: BookingView) => Promise<string> }
);
export type StaffResult = { result: "done" | "duplicate" | "conflict" | "taken" | "not_found"; booking?: BookingView; runId?: string };

/**
 * A change by staff or MCP, from the version they saw. The booking row is locked first, so concurrent requests take
 * turns. A change already logged from that version answers the request: the same action and time (compared as
 * instants) is a duplicate with the first result, anything else a conflict. Live bookings only.
 */
export async function staffChange(db: Db, req: StaffRequest, actor: string): Promise<StaffResult> {
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, and(eq(bookings.id, req.bookingId), eq(bookings.userId, req.workspaceId), eq(bookings.test, false)));
    if (!b) return { result: "not_found" };
    const [prior] = await tx.select().from(bookingChanges).where(and(eq(bookingChanges.bookingId, b.row.id), eq(bookingChanges.fromVersion, req.version)));
    if (prior) {
      const same = prior.action === req.action && (req.action === "cancel" || prior.start?.getTime() === req.start.getTime());
      return same ? { result: "duplicate", booking: view(b), runId: (prior.result as { runId?: string }).runId } : { result: "conflict", booking: view(b) };
    }
    if (b.row.version !== req.version || b.row.status !== "active") return { result: "conflict", booking: view(b) };

    const version = b.row.version + 1;
    const start = req.action === "reschedule" ? req.start : b.start;
    const end = req.action === "reschedule" ? new Date(req.start.getTime() + (b.end.getTime() - b.start.getTime())) : b.end;
    const status = req.action === "cancel" ? ("cancelled" as const) : ("active" as const);
    const next = view({ row: { ...b.row, status, version }, start, end, resourceName: b.resourceName });
    let runId: string | undefined;
    const free = await unlessTaken(tx, async (sp) => {
      await sp.update(bookings).set({ during: range(start, end) as unknown as string, status, version, updatedAt: new Date() }).where(and(eq(bookings.id, b.row.id), eq(bookings.version, b.row.version)));
      if (req.action === "reschedule") {
        runId = await req.newRun(sp, next);
        await sp.update(runs).set({ bookingId: b.row.id, bookingVersion: version }).where(eq(runs.id, runId));
        await sp.update(bookings).set({ runId }).where(eq(bookings.id, b.row.id));
      }
      await sp.insert(bookingChanges).values({ bookingId: b.row.id, fromVersion: b.row.version, action: req.action, start: req.action === "reschedule" ? start : null, runId, actor, result: { version, ...(runId ? { runId } : {}) } });
    });
    if (!free) return { result: "taken", booking: view(b) };
    return { result: "done", booking: next, runId };
  });
}

export type ListedBooking = BookingView & { workflowId: string | null; runId: string | null; attention: boolean; updatedAt: Date };

/**
 * A workspace's live bookings, soonest first, with the latest 500. attention is set while the run linked to the
 * current version has failed or waits for review: the booking stays active and staff should look (decision 0032).
 */
export async function listBookings(db: Db, workspaceId: string): Promise<ListedBooking[]> {
  const rows = await db
    .select({ ...withTimes, runState: runs.state })
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .leftJoin(runs, eq(runs.id, bookings.runId))
    .where(and(eq(bookings.userId, workspaceId), eq(bookings.test, false)))
    .orderBy(asc(startOf), desc(bookings.createdAt))
    .limit(500);
  return rows.map((r) => ({ ...view(r), workflowId: r.row.workflowId, runId: r.row.runId, updatedAt: r.row.updatedAt, attention: r.row.status === "active" && r.runState !== null && ["failed", "needs_review"].includes(r.runState) }));
}

/** A live booking by reference, for MCP. */
export async function bookingByReference(db: Db, workspaceId: string, reference: string) {
  const [b] = await db.select(withTimes).from(bookings).innerJoin(resources, eq(resources.id, bookings.resourceId)).where(and(eq(bookings.userId, workspaceId), eq(bookings.test, false), eq(bookings.reference, reference)));
  return b && { ...view(b), workflowId: b.row.workflowId, runId: b.row.runId };
}

/** A live booking by id, for staff. */
export async function bookingById(db: Db, workspaceId: string, id: string) {
  const [b] = await db.select(withTimes).from(bookings).innerJoin(resources, eq(resources.id, bookings.resourceId)).where(and(eq(bookings.userId, workspaceId), eq(bookings.test, false), eq(bookings.id, id)));
  return b && { ...view(b), workflowId: b.row.workflowId, runId: b.row.runId };
}

/** True when the run belongs to a booking version that a later change replaced. */
export async function bookingSuperseded(db: Pick<Db, "select">, run: { bookingId: string | null; bookingVersion: number | null }, lock = false): Promise<boolean> {
  if (!run.bookingId) return false;
  const q = db.select({ version: bookings.version }).from(bookings).where(eq(bookings.id, run.bookingId));
  const [b] = lock ? await q.for("share") : await q;
  return !b || b.version !== run.bookingVersion;
}

/** SQL for "this run's booking moved on", for run lists. */
export const supersededSql = sql<boolean>`(${runs.bookingId} is not null and exists (select 1 from ${bookings} where ${bookings.id} = ${runs.bookingId} and ${bookings.version} <> ${runs.bookingVersion}))`;

