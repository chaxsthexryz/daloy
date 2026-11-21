import { parseZoned } from "@daloy/engine";

/**
 * Open times for the public booking form (Doop row E9, decision 0080). A form has no opening hours of its own, so a day
 * offers starts between 9 am and 5 pm on the datetime field's slot grid, and a slot is as long as the grid. A slot is
 * taken when an active booking of that resource overlaps it. This only tells the visitor what is left: the booking
 * step's exclusion constraint stays the check that counts.
 * shortcut: fixed hours; per-form opening hours when an owner needs them.
 */
export const OPEN_FROM = 9 * 60;
export const OPEN_TO = 17 * 60;

export type Busy = { start: Date; end: Date };
export type DaySlot = { value: string; label: string; taken: boolean };

const pad = (n: number) => String(n).padStart(2, "0");

/** Minutes after midnight as "9:00 am". */
export function clock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${((h + 11) % 12) + 1}:${pad(minutes % 60)} ${h < 12 ? "am" : "pm"}`;
}

export const isTaken = (start: Date, slotMinutes: number, busy: Busy[]) => {
  const from = start.getTime();
  const to = from + slotMinutes * 60_000;
  return busy.some((b) => b.start.getTime() < to && b.end.getTime() > from);
};

export function daySlots({ date, timezone, slotMinutes, busy, now }: { date: string; timezone: string; slotMinutes: number; busy: Busy[]; now: number }): DaySlot[] {
  const slots: DaySlot[] = [];
  for (let m = Math.ceil(OPEN_FROM / slotMinutes) * slotMinutes; m + slotMinutes <= OPEN_TO; m += slotMinutes) {
    const value = `${date}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    // now = 0 so the "must be in the future" rule does not hide a past slot; it is shown as taken below.
    const read = parseZoned(value, { timezone }, 0);
    if (!read.ok) continue; // a wall time the clocks skip
    slots.push({ value, label: clock(m), taken: read.at.getTime() <= now || isTaken(read.at, slotMinutes, busy) });
  }
  return slots;
}

export const nextDay = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** The instants a calendar day starts and ends in the zone. */
export function dayWindow(date: string, timezone: string): { from: Date; to: Date } {
  const read = (d: string) => {
    const r = parseZoned(`${d}T00:00`, { timezone }, 0);
    // A zone that skips midnight is not one of ours; fall back to UTC midnight rather than failing the page.
    return r.ok ? r.at : new Date(`${d}T00:00:00Z`);
  };
  return { from: read(date), to: read(nextDay(date)) };
}

/** "Wed, 20 Jan", read in the field's zone. */
export function dayLabel(date: string, timezone: string, language: "en" | "tl"): string {
  const parts = new Intl.DateTimeFormat(language === "tl" ? "fil-PH" : "en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).formatToParts(new Date(`${date}T12:00:00Z`));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  void timezone; // the date is already a calendar date in the zone; UTC noon keeps it from shifting
  return `${get("weekday")}, ${get("day")} ${get("month")}`;
}
