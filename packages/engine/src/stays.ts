import { CLOCK_TIME_RE, STAY_TIME_KINDS, type KnowledgeEntry } from "./knowledge";
import { formatZoned, isTimeZone, parseZoned } from "./zoned";

/**
 * Multi-night resort stays (C5, decision 0120). A stay spans 1 to 30 nights from local checkIn at checkInTime to
 * local (checkIn + nights days) at checkOutTime in the stay's IANA timezone, so DST changes never shift wall clock times.
 */

export const DEFAULT_CHECK_IN_TIME = "14:00";
export const DEFAULT_CHECK_OUT_TIME = "12:00";
export const DEFAULT_STAY_TIMEZONE = "Asia/Manila";
export const MAX_STAY_NIGHTS = 30;

export const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses YYYY-MM-DD as a UTC midnight Date, or null when the calendar date is not real (e.g. 2031-02-30). */
export function parseCalendarDate(input: string): Date | null {
  const m = ISO_DATE_RE.exec(input);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1000) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
}

/** Shifts a valid YYYY-MM-DD calendar date by `days` whole calendar days. */
export function addCalendarDays(date: string, days: number): string | null {
  const base = parseCalendarDate(date);
  if (!base) return null;
  const shifted = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Reads resort check-in and check-out times from published knowledge entries.
 * Priority: arrival entries first, then policy, then room; missing sides fall back to 14:00 / 12:00.
 */
export function stayTimesFromKnowledge(entries: readonly KnowledgeEntry[]): { checkInTime: string; checkOutTime: string } {
  let checkInTime: string | undefined;
  let checkOutTime: string | undefined;
  for (const kind of STAY_TIME_KINDS) {
    for (const e of entries) {
      if (e.kind !== kind) continue;
      if (!checkInTime && e.fields.checkInTime && CLOCK_TIME_RE.test(e.fields.checkInTime)) checkInTime = e.fields.checkInTime;
      if (!checkOutTime && e.fields.checkOutTime && CLOCK_TIME_RE.test(e.fields.checkOutTime)) checkOutTime = e.fields.checkOutTime;
    }
  }
  return {
    checkInTime: checkInTime ?? DEFAULT_CHECK_IN_TIME,
    checkOutTime: checkOutTime ?? DEFAULT_CHECK_OUT_TIME,
  };
}

export type StayRangeInput = {
  checkIn: string;
  nights: number;
  timezone?: string;
  checkInTime?: string;
  checkOutTime?: string;
};

export type StayRangeResult =
  | {
      ok: true;
      start: Date;
      end: Date;
      startZoned: string;
      endZoned: string;
      checkIn: string;
      checkOut: string;
      nights: number;
      timezone: string;
      checkInTime: string;
      checkOutTime: string;
    }
  | { ok: false; error: string };

/** Computes the exact zoned [start, end) range of a multi-night stay. */
export function stayRange(req: StayRangeInput, now = Date.now()): StayRangeResult {
  const timezone = req.timezone ?? DEFAULT_STAY_TIMEZONE;
  if (!isTimeZone(timezone)) return { ok: false, error: "timezone: use an IANA timezone name such as Asia/Manila" };
  const checkIn = req.checkIn.trim();
  if (!parseCalendarDate(checkIn)) return { ok: false, error: `checkIn: must be a real date as YYYY-MM-DD, not ${JSON.stringify(req.checkIn)}` };
  if (!Number.isInteger(req.nights) || req.nights < 1 || req.nights > MAX_STAY_NIGHTS) {
    return { ok: false, error: `nights: must be a whole number from 1 to ${MAX_STAY_NIGHTS}` };
  }
  const checkInTime = (req.checkInTime ?? DEFAULT_CHECK_IN_TIME).trim();
  const checkOutTime = (req.checkOutTime ?? DEFAULT_CHECK_OUT_TIME).trim();
  if (!CLOCK_TIME_RE.test(checkInTime)) return { ok: false, error: "checkInTime: must be a 24-hour time as HH:MM" };
  if (!CLOCK_TIME_RE.test(checkOutTime)) return { ok: false, error: "checkOutTime: must be a 24-hour time as HH:MM" };

  const checkOut = addCalendarDays(checkIn, req.nights)!;
  const start = parseZoned(`${checkIn}T${checkInTime}`, { timezone }, now);
  if (!start.ok) return { ok: false, error: `checkIn: ${start.error}` };
  const end = parseZoned(`${checkOut}T${checkOutTime}`, { timezone }, -Infinity);
  if (!end.ok) return { ok: false, error: `checkOut: ${end.error}` };
  if (end.at.getTime() <= start.at.getTime()) return { ok: false, error: "checkOut must be after checkIn" };

  return {
    ok: true,
    start: start.at,
    end: end.at,
    startZoned: start.value,
    endZoned: end.value,
    checkIn,
    checkOut,
    nights: req.nights,
    timezone,
    checkInTime,
    checkOutTime,
  };
}

/**
 * Moves an existing stay booking to a new check-in date (YYYY-MM-DD) or full datetime while preserving its nights
 * and local check-out wall clock time in the booking's timezone.
 */
export function rescheduleStayRange(
  existing: { start: Date; end: Date; nights: number; timezone: string },
  input: string,
  now = Date.now(),
): StayRangeResult {
  const trimmed = input.trim();
  const existingCheckInTime = formatZoned(existing.start, existing.timezone).slice(11, 16);
  const existingCheckOutTime = formatZoned(existing.end, existing.timezone).slice(11, 16);

  if (ISO_DATE_RE.test(trimmed)) {
    return stayRange(
      { checkIn: trimmed, nights: existing.nights, timezone: existing.timezone, checkInTime: existingCheckInTime, checkOutTime: existingCheckOutTime },
      now,
    );
  }

  const start = parseZoned(trimmed, { timezone: existing.timezone }, now);
  if (!start.ok) return { ok: false, error: `start: ${start.error}` };
  const checkIn = start.value.slice(0, 10);
  const checkInTime = start.value.slice(11, 16);
  const checkOut = addCalendarDays(checkIn, existing.nights);
  if (!checkOut) return { ok: false, error: "start: is not a real date and time" };
  const end = parseZoned(`${checkOut}T${existingCheckOutTime}`, { timezone: existing.timezone }, -Infinity);
  if (!end.ok) return { ok: false, error: `checkOut: ${end.error}` };
  if (end.at.getTime() <= start.at.getTime()) return { ok: false, error: "checkOut must be after checkIn" };

  return {
    ok: true,
    start: start.at,
    end: end.at,
    startZoned: start.value,
    endZoned: end.value,
    checkIn,
    checkOut,
    nights: existing.nights,
    timezone: existing.timezone,
    checkInTime,
    checkOutTime: existingCheckOutTime,
  };
}

/** Extracts prefill checkIn and nights from a conversation's saved fields (used by Confirm stay). */
export function stayDraftFromFields(fields: Record<string, string | undefined>): { checkIn?: string; nights?: number } {
  const rawIn = fields.check_in?.trim();
  const rawOut = fields.check_out?.trim();
  const inDate = rawIn ? parseCalendarDate(rawIn) : null;
  if (!inDate) return {};
  const outDate = rawOut ? parseCalendarDate(rawOut) : null;
  if (!outDate) return { checkIn: rawIn };
  const diffDays = Math.round((outDate.getTime() - inDate.getTime()) / 86_400_000);
  if (diffDays >= 1 && diffDays <= MAX_STAY_NIGHTS) return { checkIn: rawIn, nights: diffDays };
  return { checkIn: rawIn };
}
