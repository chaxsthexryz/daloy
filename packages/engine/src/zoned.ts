/**
 * Zoned times for the datetime field and the delay's `until` (decision 0031). Built on Intl.DateTimeFormat, which
 * carries the IANA database in Node and browsers, so there is no date library to keep in step with it.
 */

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };

const formats = new Map<string, Intl.DateTimeFormat>();
function format(timeZone: string) {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formats.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone` at instant `ms`. */
function wallAt(timeZone: string, ms: number): Wall {
  const p = Object.fromEntries(format(timeZone).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

/** A wall time read as if it were UTC: the number to compare wall times by. */
const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

/** How far `timeZone` is ahead of UTC at instant `ms`, in ms. */
const offsetAt = (timeZone: string, ms: number) => wallMs(wallAt(timeZone, ms)) - Math.floor(ms / 1000) * 1000;

/**
 * Every instant at which `timeZone` shows wall time `w`: one normally, none in a spring-forward gap, two in a
 * fall-back overlap. Offsets a day either side are the ones in force before and after any change near `w`
 * (no zone changes its offset twice within two days).
 */
function instantsOf(timeZone: string, w: Wall): number[] {
  const local = wallMs(w);
  const found = new Set<number>();
  for (const probe of [local - 86_400_000, local + 86_400_000]) {
    const t = local - offsetAt(timeZone, probe);
    if (wallMs(wallAt(timeZone, t)) === local) found.add(t);
  }
  return [...found].sort((a, b) => a - b);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const offsetText = (ms: number) => {
  const m = Math.round(Math.abs(ms) / 60_000);
  return `${ms < 0 ? "-" : "+"}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
const wallText = (w: Wall) => `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;

/** True when the components name a real calendar date and a time of day from 00:00:00 to 23:59:59. */
function isReal(w: Wall) {
  const t = new Date(wallMs(w));
  return w.y >= 1000 && t.getUTCFullYear() === w.y && t.getUTCMonth() === w.mo - 1 && t.getUTCDate() === w.d && w.h < 24 && w.mi < 60 && w.s < 60;
}

// Seconds are optional. A fraction is read (toISOString() sends .000) so that a non-zero one gets the whole-minute error.
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

let zones: Set<string> | undefined;
/** An IANA zone name the runtime knows, or UTC. Offsets ("+08:00") and abbreviations ("PST") are refused. */
export function isTimeZone(tz: string): boolean {
  zones ??= new Set(Intl.supportedValuesOf("timeZone"));
  if (tz === "UTC" || zones.has(tz)) return true;
  // Older names the runtime still resolves (Asia/Calcutta) but does not list.
  if (!/^[A-Za-z]+(\/[A-Za-z0-9_+-]+)+$/.test(tz)) return false;
  try {
    format(tz);
    return true;
  } catch {
    return false;
  }
}

export type ZonedField = { timezone: string; slotMinutes?: number };
export type ZonedResult = { ok: true; value: string; at: Date } | { ok: false; error: string };

/**
 * Reads a datetime field value. Without an offset it is wall time in the field's zone (what a datetime-local input
 * sends); with Z or an offset it is that instant. Either way the time is then read in the field's zone, where the
 * slot grid applies, and stored as wall time with that zone's offset, e.g. 2027-01-20T14:00:00+08:00.
 */
export function parseZoned(input: string, field: ZonedField, now = Date.now()): ZonedResult {
  const m = DATETIME.exec(input);
  if (!m) return { ok: false, error: "must be a date and time like 2027-01-20T14:00" };
  const [, y, mo, d, h, mi, s, fraction, offset] = m;
  const given: Wall = { y: Number(y), mo: Number(mo), d: Number(d), h: Number(h), mi: Number(mi), s: Number(s ?? 0) };
  if (!isReal(given)) return { ok: false, error: "is not a real date and time" };
  const tz = field.timezone;

  let at: number;
  if (offset) {
    const [oh, om] = offset === "Z" ? [0, 0] : offset.slice(1).split(":").map(Number);
    if (oh! > 23 || om! > 59) return { ok: false, error: "is not a real date and time" };
    at = wallMs(given) - (offset.startsWith("-") ? -1 : 1) * (oh! * 60 + om!) * 60_000;
  } else {
    const found = instantsOf(tz, given);
    if (found.length === 0) return { ok: false, error: `does not exist in ${tz} (the clocks skip it)` };
    if (found.length > 1) {
      const example = `${wallText(given).slice(0, 16)}${offsetText(offsetAt(tz, found[0]!))}`;
      return { ok: false, error: `happens twice in ${tz} (the clocks go back); send it with its offset, like ${example}` };
    }
    at = found[0]!;
  }

  const local = wallAt(tz, at);
  if (local.s !== 0 || Number(fraction ?? 0) !== 0) return { ok: false, error: "must be on a whole minute" };
  if (at <= now) return { ok: false, error: "must be in the future" };
  const slot = field.slotMinutes;
  if (slot && (local.h * 60 + local.mi) % slot !== 0) return { ok: false, error: `must start on a ${slot}-minute slot, counted from midnight in ${tz}` };
  return { ok: true, value: `${wallText(local)}${offsetText(offsetAt(tz, at))}`, at: new Date(at) };
}

/** An instant as wall time in `timeZone` with that zone's offset, the form a datetime field stores. */
export const formatZoned = (at: Date, timeZone: string) => `${wallText(wallAt(timeZone, at.getTime()))}${offsetText(offsetAt(timeZone, at.getTime()))}`;

// What a datetime field stores, and what toISOString() gives: the offset is required.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO time with Z or an offset, as a Date. A time without one is refused: the server's zone would decide it. */
export function parseInstant(input: string): Date | undefined {
  const m = INSTANT.exec(input);
  if (!m || !isReal({ y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] ?? 0) })) return undefined;
  const t = Date.parse(input);
  return Number.isNaN(t) ? undefined : new Date(t);
}
