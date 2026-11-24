import { randomInt } from "node:crypto";
import { formatZoned, rescheduleStayRange } from "@daloy/engine";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { queueCalendarSync } from "./calendar";
import type { Db } from "./index";
import { cancelRun } from "./runs";
import { bookingChanges, bookingResults, bookings, conversations, paymentDues, paymentHistory, payments, resources, runs } from "./schema";

/**
 * Bookings (decision 0032, stays in decision 0120). The exclusion constraint bookings_no_overlap (migration 0019) is
 * the only availability check: a change that would overlap an active booking of the same workspace, test scope and
 * resource fails with 23P01 inside a savepoint and is answered "taken". Every change raises the version and is logged
 * in booking_changes.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof bookings.$inferSelect;
type ConvoRow = { channel: "messenger" | "instagram" | "email" | "telegram"; externalId: string; fields: Record<string, string> };

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
const withTimes = {
  row: bookings,
  start: startOf,
  end: endOf,
  resourceName: resources.name,
  resourceLabel: resources.label,
  convoChannel: conversations.channel,
  convoExternalId: conversations.externalId,
  convoFields: conversations.fields,
};

export type BookingGuest = {
  channel: "messenger" | "instagram" | "email" | "telegram";
  externalId: string;
  name?: string;
  email?: string;
  phone?: string;
};

export type BookingView = {
  id: string;
  reference: string;
  resource: { id: string; name: string; label?: string };
  start: string;
  end: string;
  minutes: number;
  timezone: string;
  status: "active" | "cancelled" | "no_show";
  version: number;
  nights?: number;
  checkIn?: string;
  checkOut?: string;
  conversationId?: string;
  guest?: BookingGuest;
};

function guestOf(c: ConvoRow | null | undefined): BookingGuest | undefined {
  if (!c) return undefined;
  const f = c.fields ?? {};
  const name = f.name?.trim() || undefined;
  const email = f.email?.trim() || (c.channel === "email" ? c.externalId : undefined);
  const phone = f.phone?.trim() || undefined;
  return {
    channel: c.channel,
    externalId: c.externalId,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  };
}

function convoFrom(b: { convoChannel?: ConvoRow["channel"] | null; convoExternalId?: string | null; convoFields?: Record<string, string> | null }): ConvoRow | null {
  if (!b.convoChannel || !b.convoExternalId) return null;
  return { channel: b.convoChannel, externalId: b.convoExternalId, fields: b.convoFields ?? {} };
}

function view(
  b: { row: Row; start: Date; end: Date; resourceName: string; resourceLabel?: string | null; convo?: ConvoRow | null },
  includeGuest = true,
): BookingView {
  const { row } = b;
  const start = formatZoned(b.start, row.timezone);
  const end = formatZoned(b.end, row.timezone);
  const guest = includeGuest ? guestOf(b.convo) : undefined;
  return {
    id: row.id,
    reference: row.reference,
    resource: { id: row.resourceId, name: b.resourceName, ...(b.resourceLabel ? { label: b.resourceLabel } : {}) },
    start,
    end,
    minutes: Math.round((b.end.getTime() - b.start.getTime()) / 60_000),
    timezone: row.timezone,
    status: row.status,
    version: row.version,
    ...(row.nights !== null ? { nights: row.nights, checkIn: start.slice(0, 10), checkOut: end.slice(0, 10) } : {}),
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    ...(guest ? { guest } : {}),
  };
}

/** Locks and reads one booking with its times, resource and optional linked conversation. */
async function lockBooking(tx: Tx, where: ReturnType<typeof and>) {
  const [b] = await tx
    .select(withTimes)
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .leftJoin(conversations, eq(conversations.id, bookings.conversationId))
    .where(where)
    .for("update", { of: bookings });
  return b && { ...b, convo: convoFrom(b) };
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
  | { action: "create"; resourceId: string; start: Date; minutes?: number; end?: Date; nights?: number; timezone: string; conversationId?: string }
  | { action: "reschedule"; reference: string; start?: Date; minutes?: number; checkIn?: string }
  | { action: "cancel"; reference: string };
export type StepBookingResult = { branch: "done" | "taken" | "not_found"; output: Record<string, unknown> };

/**
 * S3: Cancels open pending payment_dues belonging to a cancelled booking, expires their pending checkouts, and clears
 * any conversation open_due_id pointing to them. Confirmed and refunded dues stay untouched.
 */
async function cancelDuesForBooking(
  tx: Tx,
  o: { workspaceId: string; bookingId: string; reference: string; test: boolean; marker: string; source: "staff" | "workflow"; actorId?: string | null },
) {
  const now = sql`clock_timestamp()`;
  const cancelled = await tx
    .update(paymentDues)
    .set({ status: "cancelled", cancelledBy: o.marker, updatedAt: now as unknown as Date })
    .where(
      and(
        eq(paymentDues.userId, o.workspaceId),
        eq(paymentDues.test, o.test),
        eq(paymentDues.status, "pending"),
        or(eq(paymentDues.bookingId, o.bookingId), and(isNull(paymentDues.bookingId), eq(paymentDues.reference, o.reference))),
      ),
    )
    .returning({ id: paymentDues.id, userId: paymentDues.userId });
  if (cancelled.length === 0) return;
  const ids = cancelled.map((d) => d.id);
  await tx.update(conversations).set({ openDueId: null }).where(and(eq(conversations.userId, o.workspaceId), inArray(conversations.openDueId, ids)));
  await tx.update(payments).set({ status: "expired", updatedAt: now as unknown as Date }).where(and(inArray(payments.dueId, ids), eq(payments.status, "pending")));
  for (const d of cancelled) {
    await tx.insert(paymentHistory).values({
      userId: d.userId,
      dueId: d.id,
      event: "cancelled",
      source: o.source,
      actorId: o.actorId ?? null,
      detail: { reason: "booking_cancelled" },
      at: now as unknown as Date,
    });
  }
}

/**
 * One booking step attempt, in one transaction: a stored result for this run and step is returned as it was (a retry
 * or takeover never books twice); otherwise the booking changes, the run is linked to the new version, and the result
 * is stored. A test run only sees and makes test bookings. Attempts of the same run and step take turns on an
 * advisory lock, so a takeover that overlaps a still-running attempt reads that attempt's result (Astra, 7c73879).
 */
export async function bookFromStep(db: Db, at: { workspaceId: string; test: boolean; runId: string; stepId: string; workflowId: string }, a: StepAction): Promise<StepBookingResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`booking:${at.runId}:${at.stepId}`}, 0))`);
    const [stored] = await tx.select().from(bookingResults).where(and(eq(bookingResults.runId, at.runId), eq(bookingResults.stepId, at.stepId)));
    if (stored) return { branch: stored.branch as StepBookingResult["branch"], output: stored.output as Record<string, unknown> };
    if (a.action === "create" && a.start.getTime() <= Date.now()) throw new Error(`The booking time has passed (${a.start.toISOString()}).`);
    if (a.action === "reschedule" && a.start && a.start.getTime() <= Date.now()) throw new Error(`The booking time has passed (${a.start.toISOString()}).`);

    let result: StepBookingResult;
    let bookingId: string | null = null;
    const link = async (w: Tx, id: string, version: number) => {
      await w.update(runs).set({ bookingId: id, bookingVersion: version }).where(eq(runs.id, at.runId));
      await w.update(bookings).set({ runId: at.runId }).where(eq(bookings.id, id));
    };

    if (a.action === "create") {
      // Checked here, in the transaction that books, so a resource archived a moment ago is not booked.
      const [resource] = await tx.select().from(resources).where(and(eq(resources.id, a.resourceId), eq(resources.userId, at.workspaceId), eq(resources.active, true)));
      let convo: ConvoRow | null = null;
      let missingConvo = false;
      if (a.conversationId) {
        const [c] = await tx
          .select({ channel: conversations.channel, externalId: conversations.externalId, fields: conversations.fields })
          .from(conversations)
          .where(and(eq(conversations.id, a.conversationId), eq(conversations.userId, at.workspaceId)));
        if (!c) missingConvo = true;
        else convo = c;
      }
      if (!resource) {
        result = { branch: "not_found", output: { reason: "There is no active resource with that id in this workspace." } };
      } else if (missingConvo) {
        result = { branch: "not_found", output: { reason: "There is no conversation with that id in this workspace." } };
      } else {
        const end = a.end ?? new Date(a.start.getTime() + a.minutes! * 60_000);
        let created: Row | undefined;
        const free = await unlessTaken(tx, async (sp) => {
          [created] = await sp
            .insert(bookings)
            .values({
              userId: at.workspaceId,
              test: at.test,
              reference: newReference(at.test),
              resourceId: resource.id,
              during: range(a.start, end) as unknown as string,
              timezone: a.timezone,
              nights: a.nights ?? null,
              conversationId: a.conversationId ?? null,
              workflowId: at.workflowId,
            })
            .returning();
          await sp.insert(bookingChanges).values({ bookingId: created!.id, fromVersion: 0, action: "create", start: a.start, runId: at.runId, actor: `run:${at.runId}`, result: { version: 1 } });
          await link(sp, created!.id, 1);
        });
        if (!free) result = { branch: "taken", output: { reason: "That time is already booked for this resource." } };
        else {
          bookingId = created!.id;
          result = { branch: "done", output: view({ row: created!, start: a.start, end, resourceName: resource.name, resourceLabel: resource.label, convo }) };
        }
      }
    } else {
      const b = await lockBooking(tx, and(eq(bookings.userId, at.workspaceId), eq(bookings.test, at.test), eq(bookings.reference, a.reference)));
      if (!b || b.row.status !== "active") {
        result = { branch: "not_found", output: { reason: "There is no active booking with that reference." } };
      } else {
        bookingId = b.row.id;
        const version = b.row.version + 1;
        let start = b.start;
        let end = b.end;
        if (a.action === "reschedule") {
          if (a.checkIn !== undefined) {
            if (b.row.nights === null) throw new Error("This booking is not a multi-night stay; reschedule it with a datetime start.");
            const moved = rescheduleStayRange({ start: b.start, end: b.end, nights: b.row.nights, timezone: b.row.timezone }, a.checkIn);
            if (!moved.ok) throw new Error(moved.error);
            start = moved.start;
            end = moved.end;
          } else if (b.row.nights !== null && a.minutes === undefined) {
            const moved = rescheduleStayRange({ start: b.start, end: b.end, nights: b.row.nights, timezone: b.row.timezone }, a.start!.toISOString());
            if (!moved.ok) throw new Error(moved.error);
            start = moved.start;
            end = moved.end;
          } else {
            start = a.start!;
            end = new Date(a.start!.getTime() + (a.minutes !== undefined ? a.minutes * 60_000 : b.end.getTime() - b.start.getTime()));
          }
        }
        const status = a.action === "cancel" ? ("cancelled" as const) : ("active" as const);
        const nextPublic = view({ row: { ...b.row, status, version }, start, end, resourceName: b.resourceName, resourceLabel: b.resourceLabel, convo: b.convo });
        const nextLogged = view({ row: { ...b.row, status, version }, start, end, resourceName: b.resourceName, resourceLabel: b.resourceLabel, convo: b.convo }, false);
        const free = await unlessTaken(tx, async (sp) => {
          await sp.update(bookings).set({ during: range(start, end) as unknown as string, status, version, updatedAt: new Date() }).where(and(eq(bookings.id, b.row.id), eq(bookings.version, b.row.version)));
          await sp.insert(bookingChanges).values({ bookingId: b.row.id, fromVersion: b.row.version, action: a.action, start: a.action === "reschedule" ? start : null, runId: at.runId, actor: `run:${at.runId}`, result: { version, booking: nextLogged } });
          if (a.action === "cancel") {
            await cancelDuesForBooking(sp, {
              workspaceId: at.workspaceId,
              bookingId: b.row.id,
              reference: b.row.reference,
              test: at.test,
              marker: `${at.runId}:${at.stepId}`,
              source: "workflow",
            });
          }
          await link(sp, b.row.id, version);
          await queueCalendarSync(sp, b.row.id, version, at.runId);
        });
        result = free ? { branch: "done", output: nextPublic } : { branch: "taken", output: { reason: "That time is already booked for this resource." } };
      }
    }
    await tx.insert(bookingResults).values({ runId: at.runId, stepId: at.stepId, bookingId, branch: result.branch, output: result.output });
    return result;
  });
}

export type ConfirmStayRequest = {
  workspaceId: string;
  resourceId: string;
  start: Date;
  end: Date;
  nights: number;
  timezone: string;
  conversationId?: string;
  idempotencyKey?: string;
};
export type ConfirmStayResult = {
  result: "done" | "duplicate" | "taken" | "resource_not_found" | "conversation_not_found";
  booking?: BookingView;
};

/**
 * Staff Confirm stay (C5, decision 0120): creates a live multi-night stay booking outside a workflow run, optionally
 * linked to a conversation for guest contact. An idempotencyKey makes double-clicks and retries return the same stay.
 */
export async function confirmStay(db: Db, req: ConfirmStayRequest, actor: string): Promise<ConfirmStayResult> {
  return db.transaction(async (tx) => {
    if (req.idempotencyKey) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stay:${req.workspaceId}:${req.idempotencyKey}`}, 0))`);
      const [existing] = await tx
        .select(withTimes)
        .from(bookings)
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .leftJoin(conversations, eq(conversations.id, bookings.conversationId))
        .where(and(eq(bookings.userId, req.workspaceId), eq(bookings.idempotencyKey, req.idempotencyKey)));
      if (existing) return { result: "duplicate", booking: view({ ...existing, convo: convoFrom(existing) }) };
    }

    const [resource] = await tx
      .select()
      .from(resources)
      .where(and(eq(resources.id, req.resourceId), eq(resources.userId, req.workspaceId), eq(resources.active, true)));
    if (!resource) return { result: "resource_not_found" };

    let convo: ConvoRow | null = null;
    if (req.conversationId) {
      const [c] = await tx
        .select({ channel: conversations.channel, externalId: conversations.externalId, fields: conversations.fields })
        .from(conversations)
        .where(and(eq(conversations.id, req.conversationId), eq(conversations.userId, req.workspaceId)));
      if (!c) return { result: "conversation_not_found" };
      convo = c;
    }

    let created: Row | undefined;
    const free = await unlessTaken(tx, async (sp) => {
      [created] = await sp
        .insert(bookings)
        .values({
          userId: req.workspaceId,
          test: false,
          reference: newReference(false),
          resourceId: resource.id,
          during: range(req.start, req.end) as unknown as string,
          timezone: req.timezone,
          nights: req.nights,
          conversationId: req.conversationId ?? null,
          idempotencyKey: req.idempotencyKey ?? null,
        })
        .returning();
      const logged = view({ row: created!, start: req.start, end: req.end, resourceName: resource.name, resourceLabel: resource.label, convo }, false);
      await sp.insert(bookingChanges).values({ bookingId: created!.id, fromVersion: 0, action: "create", start: req.start, actor, result: { version: 1, booking: logged } });
    });
    if (!free) return { result: "taken" };
    return { result: "done", booking: view({ row: created!, start: req.start, end: req.end, resourceName: resource.name, resourceLabel: resource.label, convo }) };
  });
}

/** Finds an earlier staff Confirm stay by idempotencyKey before validating time/resource (for safe replays). */
export async function stayByIdempotencyKey(db: Db, workspaceId: string, idempotencyKey: string): Promise<BookingView | undefined> {
  const [existing] = await db
    .select(withTimes)
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .leftJoin(conversations, eq(conversations.id, bookings.conversationId))
    .where(and(eq(bookings.userId, workspaceId), eq(bookings.idempotencyKey, idempotencyKey)));
  return existing && view({ ...existing, convo: convoFrom(existing) });
}

export type StaffRequest = { workspaceId: string; bookingId: string; version: number } & (
  | { action: "cancel" }
  // A booking whose time has passed. newRun starts the follow-up in the same transaction; it is not linked to the booking.
  | { action: "no_show"; newRun: (tx: Tx, booking: BookingView) => Promise<string> }
  // Back to active, only while the follow-up of the no_show change it undoes can still be cancelled.
  | { action: "undo_no_show" }
  // newRun starts the run for the new version, in the same transaction, and returns its id (omitted for staff-confirmed stays with no workflow).
  | { action: "reschedule"; start: Date; end?: Date; newRun?: (tx: Tx, booking: BookingView) => Promise<string | undefined> }
);
export type StaffReplay = { workspaceId: string; bookingId: string; version: number } & ({ action: "cancel" | "no_show" | "undo_no_show" } | { action: "reschedule"; start: Date });
export type StaffResult = { result: "done" | "duplicate" | "conflict" | "taken" | "not_found" | "started" | "not_yet"; booking?: BookingView; runId?: string };

/** The stored answer when the logged change is this same one (same action, same start as an instant), else undefined. */
function replayOf(prior: typeof bookingChanges.$inferSelect | undefined, req: StaffReplay): StaffResult | undefined {
  if (!prior || prior.action !== req.action || (req.action === "reschedule" && prior.start?.getTime() !== req.start.getTime())) return undefined;
  const r = prior.result as { runId?: string; booking?: BookingView };
  return { result: "duplicate", booking: r.booking, runId: r.runId };
}

/**
 * The stored answer to a change already made from this version, looked up before the new time is checked, so an
 * identical replay works after the booking moved on or its time has passed. Live bookings of the workspace only.
 */
export async function staffReplay(db: Db, req: StaffReplay): Promise<StaffResult | undefined> {
  const [prior] = await db
    .select({ change: bookingChanges })
    .from(bookingChanges)
    .innerJoin(bookings, eq(bookings.id, bookingChanges.bookingId))
    .where(and(eq(bookingChanges.bookingId, req.bookingId), eq(bookingChanges.fromVersion, req.version), eq(bookings.userId, req.workspaceId), eq(bookings.test, false)));
  return replayOf(prior?.change, req);
}

/**
 * A change by staff or MCP, from the version they saw. The booking row is locked first, so concurrent requests take
 * turns. A change already logged from that version answers the request: the same action and time (compared as
 * instants) is a duplicate with the stored result of that change, anything else a conflict. Live bookings only.
 */
export async function staffChange(db: Db, req: StaffRequest, actor: string): Promise<StaffResult> {
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, and(eq(bookings.id, req.bookingId), eq(bookings.userId, req.workspaceId), eq(bookings.test, false)));
    if (!b) return { result: "not_found" };
    const [prior] = await tx.select().from(bookingChanges).where(and(eq(bookingChanges.bookingId, b.row.id), eq(bookingChanges.fromVersion, req.version)));
    if (prior) return replayOf(prior, req) ?? { result: "conflict", booking: view(b) };
    if (b.row.version !== req.version || b.row.status !== (req.action === "undo_no_show" ? "no_show" : "active")) return { result: "conflict", booking: view(b) };
    if (req.action === "no_show" && b.start > new Date()) return { result: "not_yet", booking: view(b) };

    const version = b.row.version + 1;
    const start = req.action === "reschedule" ? req.start : b.start;
    let end = b.end;
    if (req.action === "reschedule") {
      if (req.end) end = req.end;
      else if (b.row.nights !== null) {
        const moved = rescheduleStayRange({ start: b.start, end: b.end, nights: b.row.nights, timezone: b.row.timezone }, req.start.toISOString(), -Infinity);
        if (!moved.ok) throw new Error(moved.error);
        end = moved.end;
      } else {
        end = new Date(req.start.getTime() + (b.end.getTime() - b.start.getTime()));
      }
    }
    const status = req.action === "cancel" ? ("cancelled" as const) : req.action === "no_show" ? ("no_show" as const) : ("active" as const);
    const nextPublic = view({ row: { ...b.row, status, version }, start, end, resourceName: b.resourceName, resourceLabel: b.resourceLabel, convo: b.convo });
    const nextLogged = view({ row: { ...b.row, status, version }, start, end, resourceName: b.resourceName, resourceLabel: b.resourceLabel, convo: b.convo }, false);
    let runId: string | undefined;
    let started = false;
    const free = await unlessTaken(tx, async (sp) => {
      if (req.action === "undo_no_show") {
        // The follow-up of the change this one undoes, which must still be waiting or pending.
        const [mark] = await sp.select({ runId: bookingChanges.runId }).from(bookingChanges).where(and(eq(bookingChanges.bookingId, b.row.id), eq(bookingChanges.fromVersion, b.row.version - 1), eq(bookingChanges.action, "no_show")));
        if (mark?.runId && !(await cancelRun(sp, req.workspaceId, mark.runId, actor))) {
          started = true;
          return;
        }
      }
      await sp.update(bookings).set({ during: range(start, end) as unknown as string, status, version, updatedAt: new Date() }).where(and(eq(bookings.id, b.row.id), eq(bookings.version, b.row.version)));
      if (req.action === "reschedule" && req.newRun) {
        runId = await req.newRun(sp, nextPublic);
        if (runId) {
          await sp.update(runs).set({ bookingId: b.row.id, bookingVersion: version }).where(eq(runs.id, runId));
          await sp.update(bookings).set({ runId }).where(eq(bookings.id, b.row.id));
        }
      }
      if (req.action === "no_show") runId = await req.newRun(sp, nextPublic);
      await sp.insert(bookingChanges).values({ bookingId: b.row.id, fromVersion: b.row.version, action: req.action, start: req.action === "reschedule" ? start : null, runId, actor, result: { version, ...(runId ? { runId } : {}), booking: nextLogged } });
      if (req.action === "cancel") {
        const actorId = /^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor) ? actor.slice(5) : null;
        await cancelDuesForBooking(sp, {
          workspaceId: req.workspaceId,
          bookingId: b.row.id,
          reference: b.row.reference,
          test: false,
          marker: actor,
          source: "staff",
          actorId,
        });
      }
      // The calendar event stays for a no-show: the booking was made and not kept, not cancelled.
      if (req.action === "cancel" || req.action === "reschedule") await queueCalendarSync(sp, b.row.id, version, runId ?? b.row.runId);
    });
    if (started) return { result: "started", booking: view(b) };
    if (!free) return { result: "taken", booking: view(b) };
    return { result: "done", booking: nextPublic, runId };
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
    .leftJoin(conversations, eq(conversations.id, bookings.conversationId))
    .leftJoin(runs, eq(runs.id, bookings.runId))
    .where(and(eq(bookings.userId, workspaceId), eq(bookings.test, false)))
    .orderBy(asc(startOf), desc(bookings.createdAt))
    .limit(500);
  return rows.map((r) => ({
    ...view({ ...r, convo: convoFrom(r) }),
    workflowId: r.row.workflowId,
    runId: r.row.runId,
    updatedAt: r.row.updatedAt,
    attention: r.row.status === "active" && r.runState !== null && ["failed", "needs_review"].includes(r.runState),
  }));
}

/** A live booking by reference, for MCP. */
export async function bookingByReference(db: Db, workspaceId: string, reference: string) {
  const [b] = await db
    .select(withTimes)
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .leftJoin(conversations, eq(conversations.id, bookings.conversationId))
    .where(and(eq(bookings.userId, workspaceId), eq(bookings.test, false), eq(bookings.reference, reference)));
  return b && { ...view({ ...b, convo: convoFrom(b) }), workflowId: b.row.workflowId, runId: b.row.runId };
}

/** A live booking by id, for staff. */
export async function bookingById(db: Db, workspaceId: string, id: string): Promise<ListedBooking | undefined> {
  const [b] = await db
    .select({ ...withTimes, runState: runs.state })
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .leftJoin(conversations, eq(conversations.id, bookings.conversationId))
    .leftJoin(runs, eq(runs.id, bookings.runId))
    .where(and(eq(bookings.userId, workspaceId), eq(bookings.test, false), eq(bookings.id, id)));
  return (
    b && {
      ...view({ ...b, convo: convoFrom(b) }),
      workflowId: b.row.workflowId,
      runId: b.row.runId,
      updatedAt: b.row.updatedAt,
      attention: b.row.status === "active" && b.runState !== null && ["failed", "needs_review"].includes(b.runState),
    }
  );
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

/**
 * Active, real (not test) bookings of one resource that overlap [from, to). The public booking form uses it to show
 * which open times are taken. It reads only times, never a reference or a person, and only for one workspace's resource.
 */
export async function busyBetween(db: Db, workspaceId: string, resourceId: string, from: Date, to: Date): Promise<{ start: Date; end: Date }[]> {
  return db
    .select({ start: startOf, end: endOf })
    .from(bookings)
    .where(and(eq(bookings.userId, workspaceId), eq(bookings.resourceId, resourceId), eq(bookings.test, false), eq(bookings.status, "active"), sql`${bookings.during} && ${range(from, to)}`));
}
