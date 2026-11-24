import { ASSISTANT_READ_SCOPES, DEFAULT_STAY_TIMEZONE, dayBounds, formatZoned, isTimeZone, type AssistantReadScope } from "@daloy/engine";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { connectionCredential } from "./connections";
import { withGoogle } from "./google-access";
import type { Db } from "./index";
import { GOOGLE_FEATURE_SCOPES } from "./oauth/google";
import { centavosToPesos } from "./paymongo";
import { calendarEventsBetween, ProviderError, type ProviderUrls } from "./providers";
import { bookings, connections, conversations, paymentDues, resources, runs, workflows, workflowVersions } from "./schema";

export const DEFAULT_ASSISTANT_TIMEZONE = DEFAULT_STAY_TIMEZONE;

const MAX_ITEMS = 50;
const MAX_PROBLEMS = 10;
const SUMMARY_MAX_CHARS = 12_000;

export type AssistantCalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string;
  allDay: boolean;
};

export type AssistantCalendarSummary = {
  connected: boolean;
  status: "ok" | "not_connected" | "reconnect_required" | "missing_scope" | "no_calendar" | "unsupported_auth" | "unavailable";
  calendarTitle?: string;
  reason?: string;
  events: AssistantCalendarEvent[];
};

export type AssistantBookingItem = {
  reference: string;
  resource: string;
  status: string;
  start: string;
  end: string;
  minutes: number;
  nights?: number;
  guestName?: string;
};

export type AssistantBookingsSummary = {
  count: number;
  items: AssistantBookingItem[];
};

export type AssistantPaymentItem = {
  reference: string;
  kind: string;
  amountPesos: string;
  totalPesos?: string;
  bookingReference?: string;
  createdAt: string;
};

export type AssistantPaymentsSummary = {
  count: number;
  totalPesos: string;
  items: AssistantPaymentItem[];
};

export type AssistantRunProblem = {
  workflowName: string;
  state: string;
  createdAt: string;
};

export type AssistantRunsSummary = {
  total: number;
  succeeded: number;
  failed: number;
  needsReview: number;
  waiting: number;
  running: number;
  pending: number;
  cancelled: number;
  problems: AssistantRunProblem[];
};

export type AssistantSnapshot = {
  date: string;
  timezone: string;
  what: AssistantReadScope;
  calendar?: AssistantCalendarSummary;
  bookings?: AssistantBookingsSummary;
  payments?: AssistantPaymentsSummary;
  runs?: AssistantRunsSummary;
  summaryText: string;
};

export function parseAssistantScope(what: string | undefined): AssistantReadScope | null {
  const normalized = (what ?? "all").trim().toLowerCase() || "all";
  return (ASSISTANT_READ_SCOPES as readonly string[]).includes(normalized) ? (normalized as AssistantReadScope) : null;
}

const wants = (what: AssistantReadScope, section: Exclude<AssistantReadScope, "all">) => what === "all" || what === section;

/** Deterministic plain-text summary of the read snapshot, keeping secrets and tokens out. */
export function formatAssistantSummary(snap: Omit<AssistantSnapshot, "summaryText">): string {
  const lines: string[] = [`Today (${snap.date}, ${snap.timezone}):`];
  if (snap.calendar) {
    if (!snap.calendar.connected) {
      lines.push(`Google Calendar: ${snap.calendar.reason ?? "Not connected."}`);
    } else if (snap.calendar.status !== "ok") {
      lines.push(`Google Calendar: ${snap.calendar.reason ?? "Could not load events right now."}`);
    } else if (snap.calendar.events.length === 0) {
      lines.push(`Google Calendar (${snap.calendar.calendarTitle ?? "Calendar"}): No events today.`);
    } else {
      lines.push(`Google Calendar (${snap.calendar.calendarTitle ?? "Calendar"}, ${snap.calendar.events.length} event${snap.calendar.events.length === 1 ? "" : "s"}):`);
      for (const ev of snap.calendar.events) {
        const when = ev.allDay ? "All day" : `${ev.start} to ${ev.end}`;
        lines.push(`- ${ev.title} (${when})${ev.location ? ` at ${ev.location}` : ""}`);
      }
    }
  }
  if (snap.bookings) {
    if (snap.bookings.count === 0) {
      lines.push("kymavo bookings: No bookings today.");
    } else {
      lines.push(`kymavo bookings (${snap.bookings.count} today):`);
      for (const b of snap.bookings.items) {
        const who = b.guestName ? `, ${b.guestName}` : "";
        lines.push(`- ${b.reference} (${b.status}): ${b.resource}${who}, ${b.start} to ${b.end}`);
      }
      if (snap.bookings.count > snap.bookings.items.length) {
        lines.push(`...and ${snap.bookings.count - snap.bookings.items.length} more.`);
      }
    }
  }
  if (snap.payments) {
    if (snap.payments.count === 0) {
      lines.push("Open unpaid payments: None.");
    } else {
      lines.push(`Open unpaid payments (${snap.payments.count} pending, total PHP ${snap.payments.totalPesos}):`);
      for (const p of snap.payments.items) {
        const booking = p.bookingReference ? `, booking ${p.bookingReference}` : "";
        lines.push(`- ${p.reference} (${p.kind}): PHP ${p.amountPesos}${booking}`);
      }
      if (snap.payments.count > snap.payments.items.length) {
        lines.push(`...and ${snap.payments.count - snap.payments.items.length} more.`);
      }
    }
  }
  if (snap.runs) {
    const r = snap.runs;
    lines.push(`Today's runs (${r.total} total): ${r.succeeded} succeeded, ${r.failed} failed, ${r.needsReview} needs review, ${r.waiting} waiting, ${r.running + r.pending} active, ${r.cancelled} cancelled.`);
    for (const p of r.problems) {
      lines.push(`- ${p.workflowName}: ${p.state} (${p.createdAt})`);
    }
  }
  return lines.join("\n").slice(0, SUMMARY_MAX_CHARS);
}

/** Sample snapshot for mocked test runs without touching the database or calling Google. */
export function mockAssistantSnapshot(what: AssistantReadScope, timezone = DEFAULT_ASSISTANT_TIMEZONE, now = new Date()): AssistantSnapshot & { mocked: true } {
  const tz = isTimeZone(timezone) ? timezone : DEFAULT_ASSISTANT_TIMEZONE;
  const { date } = dayBounds(now, tz);
  const base: Omit<AssistantSnapshot, "summaryText"> = {
    date,
    timezone: tz,
    what,
    ...(wants(what, "calendar") && {
      calendar: {
        connected: true,
        status: "ok" as const,
        calendarTitle: "kymavo bookings",
        events: [],
      },
    }),
    ...(wants(what, "bookings") && {
      bookings: { count: 0, items: [] },
    }),
    ...(wants(what, "payments") && {
      payments: { count: 0, totalPesos: "0.00", items: [] },
    }),
    ...(wants(what, "runs") && {
      runs: { total: 0, succeeded: 0, failed: 0, needsReview: 0, waiting: 0, running: 0, pending: 0, cancelled: 0, problems: [] },
    }),
  };
  return { mocked: true, ...base, summaryText: formatAssistantSummary(base) };
}

async function readTodayCalendar(
  db: Db,
  secretsKey: Buffer,
  urls: ProviderUrls,
  userId: string,
  start: Date,
  end: Date,
): Promise<AssistantCalendarSummary> {
  const [meta] = await db
    .select({ status: connections.status, authMethod: connections.authMethod, scopes: connections.scopes, destination: connections.destination })
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.provider, "google_calendar")));
  if (!meta) {
    return { connected: false, status: "not_connected", reason: "Google Calendar is not connected. Connect it in Apps.", events: [] };
  }
  if (meta.status !== "active") {
    return { connected: false, status: "reconnect_required", reason: "Google Calendar stopped accepting kymavo's access. Reconnect Google Calendar in Apps.", events: [] };
  }
  if (meta.authMethod !== "oauth") {
    return { connected: false, status: "unsupported_auth", reason: "Connect Google Calendar with Google sign-in in Apps to read today's events.", events: [] };
  }
  if (meta.scopes !== null) {
    const have = meta.scopes.split(/[\s,]+/);
    if (GOOGLE_FEATURE_SCOPES.calendar.some((s) => !have.includes(s))) {
      return { connected: false, status: "missing_scope", reason: "Reconnect Google Calendar in Apps and allow calendar access.", events: [] };
    }
  }
  const calendarId = meta.destination?.calendarId;
  if (!calendarId) {
    return { connected: false, status: "no_calendar", reason: "No calendar is chosen for Google Calendar. Reconnect Google Calendar in Apps.", events: [] };
  }
  const conn = await connectionCredential(db, secretsKey, userId, "google_calendar");
  if (!conn || conn.status !== "active" || conn.authMethod !== "oauth" || !conn.destination?.calendarId) {
    return { connected: false, status: "reconnect_required", reason: "Google Calendar needs to be reconnected in Apps.", events: [] };
  }
  try {
    const raw = await withGoogle(db, secretsKey, urls, userId, "google_calendar", conn, (auth) =>
      calendarEventsBetween(urls, auth, conn.destination!.calendarId!, start.toISOString(), end.toISOString()),
    );
    const events: AssistantCalendarEvent[] = raw
      .filter((e) => e.status !== "cancelled")
      .slice(0, MAX_ITEMS)
      .map((e) => ({
        id: e.id,
        title: (e.summary ?? "(Untitled)").slice(0, 200),
        start: e.start?.dateTime ?? e.start?.date ?? "",
        end: e.end?.dateTime ?? e.end?.date ?? "",
        location: (e.location ?? "").slice(0, 200),
        allDay: Boolean(e.start?.date && !e.start?.dateTime),
      }));
    return {
      connected: true,
      status: "ok",
      calendarTitle: conn.destination.title ?? "kymavo bookings",
      events,
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      if (err.kind === "auth") {
        return { connected: false, status: "reconnect_required", reason: "Google Calendar stopped accepting kymavo's access. Reconnect Google Calendar in Apps.", events: [] };
      }
      if (err.kind === "permission") {
        return { connected: false, status: "missing_scope", reason: "Google Calendar refused access. Reconnect Google Calendar in Apps.", events: [] };
      }
      return { connected: true, status: "unavailable", reason: "Google Calendar could not be reached right now.", events: [] };
    }
    throw err;
  }
}

async function readTodayBookings(db: Db, userId: string, start: Date, end: Date): Promise<AssistantBookingsSummary> {
  const startOf = sql<Date>`lower(${bookings.during})`.mapWith((v: string | Date) => new Date(v));
  const endOf = sql<Date>`upper(${bookings.during})`.mapWith((v: string | Date) => new Date(v));
  const range = sql`tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)')`;
  const rows = await db
    .select({
      reference: bookings.reference,
      status: bookings.status,
      timezone: bookings.timezone,
      nights: bookings.nights,
      start: startOf,
      end: endOf,
      resourceName: resources.name,
      convoFields: conversations.fields,
    })
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .leftJoin(conversations, eq(conversations.id, bookings.conversationId))
    .where(and(eq(bookings.userId, userId), eq(bookings.test, false), sql`${bookings.during} && ${range}`))
    .orderBy(asc(startOf), desc(bookings.createdAt));

  return {
    count: rows.length,
    items: rows.slice(0, MAX_ITEMS).map((r) => {
      const guestName = r.convoFields?.name?.trim().slice(0, 100);
      return {
        reference: r.reference,
        resource: r.resourceName,
        status: r.status,
        start: formatZoned(r.start, r.timezone),
        end: formatZoned(r.end, r.timezone),
        minutes: Math.round((r.end.getTime() - r.start.getTime()) / 60_000),
        ...(r.nights !== null ? { nights: r.nights } : {}),
        ...(guestName ? { guestName } : {}),
      };
    }),
  };
}

async function readOpenPayments(db: Db, userId: string, timezone: string): Promise<AssistantPaymentsSummary> {
  const rows = await db
    .select({
      reference: paymentDues.reference,
      kind: paymentDues.kind,
      amountCentavos: paymentDues.amountCentavos,
      totalCentavos: paymentDues.totalCentavos,
      bookingReference: bookings.reference,
      createdAt: paymentDues.createdAt,
    })
    .from(paymentDues)
    .leftJoin(bookings, eq(bookings.id, paymentDues.bookingId))
    .where(and(eq(paymentDues.userId, userId), eq(paymentDues.test, false), eq(paymentDues.status, "pending")))
    .orderBy(asc(paymentDues.createdAt));

  const totalCentavos = rows.reduce((sum, r) => sum + r.amountCentavos, 0);
  return {
    count: rows.length,
    totalPesos: centavosToPesos(totalCentavos),
    items: rows.slice(0, MAX_ITEMS).map((r) => ({
      reference: r.reference,
      kind: r.kind,
      amountPesos: centavosToPesos(r.amountCentavos),
      ...(r.totalCentavos !== null ? { totalPesos: centavosToPesos(r.totalCentavos) } : {}),
      ...(r.bookingReference ? { bookingReference: r.bookingReference } : {}),
      createdAt: formatZoned(r.createdAt, timezone),
    })),
  };
}

async function readTodayRuns(db: Db, userId: string, start: Date, end: Date, timezone: string): Promise<AssistantRunsSummary> {
  const rows = await db
    .select({
      state: runs.state,
      workflowName: workflows.name,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(and(eq(workflows.userId, userId), eq(runs.test, false), gte(runs.createdAt, start), lt(runs.createdAt, end)))
    .orderBy(desc(runs.createdAt));

  const counts = { total: rows.length, succeeded: 0, failed: 0, needsReview: 0, waiting: 0, running: 0, pending: 0, cancelled: 0 };
  const problems: AssistantRunProblem[] = [];
  for (const r of rows) {
    if (r.state === "succeeded") counts.succeeded++;
    else if (r.state === "failed") counts.failed++;
    else if (r.state === "needs_review") counts.needsReview++;
    else if (r.state === "waiting") counts.waiting++;
    else if (r.state === "running") counts.running++;
    else if (r.state === "pending") counts.pending++;
    else if (r.state === "cancelled") counts.cancelled++;
    if ((r.state === "failed" || r.state === "needs_review") && problems.length < MAX_PROBLEMS) {
      problems.push({ workflowName: r.workflowName.slice(0, 120), state: r.state, createdAt: formatZoned(r.createdAt, timezone) });
    }
  }
  return { ...counts, problems };
}

/**
 * Strictly read-only assistant snapshot for today, scoped to `userId`.
 * Never discloses secrets, OAuth tokens, payment tokens, or raw run payloads/errors.
 */
export async function readAssistantSnapshot(opts: {
  db: Db;
  secretsKey: Buffer;
  urls: ProviderUrls;
  userId: string;
  what: AssistantReadScope;
  timezone?: string;
  now?: Date;
}): Promise<AssistantSnapshot> {
  const timezone = opts.timezone && isTimeZone(opts.timezone) ? opts.timezone : DEFAULT_ASSISTANT_TIMEZONE;
  const now = opts.now ?? new Date();
  const { date, start, end } = dayBounds(now, timezone);

  const [calendar, bookingsData, payments, runsData] = await Promise.all([
    wants(opts.what, "calendar") ? readTodayCalendar(opts.db, opts.secretsKey, opts.urls, opts.userId, start, end) : Promise.resolve(undefined),
    wants(opts.what, "bookings") ? readTodayBookings(opts.db, opts.userId, start, end) : Promise.resolve(undefined),
    wants(opts.what, "payments") ? readOpenPayments(opts.db, opts.userId, timezone) : Promise.resolve(undefined),
    wants(opts.what, "runs") ? readTodayRuns(opts.db, opts.userId, start, end, timezone) : Promise.resolve(undefined),
  ]);

  const partial: Omit<AssistantSnapshot, "summaryText"> = {
    date,
    timezone,
    what: opts.what,
    ...(calendar ? { calendar } : {}),
    ...(bookingsData ? { bookings: bookingsData } : {}),
    ...(payments ? { payments } : {}),
    ...(runsData ? { runs: runsData } : {}),
  };
  return { ...partial, summaryText: formatAssistantSummary(partial) };
}
