/**
 * Day agenda for Bookings (O4). A booking's `start` is zoned ("2027-01-20T14:00:00+08:00"), so its date and time are
 * read from the string as the customer chose them, never converted to the viewer's zone.
 */
export function byDay<T extends { start: string }>(list: T[]): { day: string; items: T[] }[] {
  const days = new Map<string, T[]>();
  for (const b of [...list].sort((x, y) => x.start.localeCompare(y.start))) {
    const day = b.start.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), b]);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, items]) => ({ day, items }));
}

/** "14:00" -> "2:00 PM". */
export function ampm(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
