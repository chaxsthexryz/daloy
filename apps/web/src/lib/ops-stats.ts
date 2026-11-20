/** The few fields of a run the Automations table needs. */
export type RunLite = { id: string; workflowId: string; state: string; createdAt: string };

/** GET /runs returns this many of the newest runs and no more. */
export const RUN_LIMIT = 50;

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const DAY = 86_400_000;
const daysBack = (from: number, n: number) => {
  const d = new Date(startOfDay(from));
  d.setDate(d.getDate() - n);
  return d.getTime();
};

/**
 * Runs today and over the last seven calendar days (today included), and the success rate of the finished ones.
 * The API sends only the newest RUN_LIMIT runs. When it sent that many and the oldest is still inside a window, older
 * runs may be missing, so that window's figure is flagged as partial instead of presented as a total.
 */
export function runStats(runs: RunLite[], now: number, limit = RUN_LIMIT) {
  const today = startOfDay(now);
  const weekStart = daysBack(now, 6);
  const times = runs.map((r) => Date.parse(r.createdAt));
  const inWeek = runs.filter((_, i) => times[i]! >= weekStart);
  const succeeded = inWeek.filter((r) => r.state === "succeeded").length;
  const failed = inWeek.filter((r) => r.state === "failed").length;
  const full = runs.length >= limit;
  const oldest = times.length ? Math.min(...times) : Infinity;
  return {
    today: times.filter((t) => t >= today).length,
    week: inWeek.length,
    rate: succeeded + failed === 0 ? null : succeeded / (succeeded + failed),
    cappedToday: full && oldest >= today,
    cappedWeek: full && oldest >= weekStart,
  };
}

/** Seven days of runs for one automation, oldest first: how many, and whether any failed. */
export function dayBars(runs: RunLite[], workflowId: string, now: number) {
  const first = daysBack(now, 6);
  const bars = Array.from({ length: 7 }, () => ({ total: 0, failed: false }));
  for (const r of runs) {
    if (r.workflowId !== workflowId) continue;
    const i = Math.floor((startOfDay(Date.parse(r.createdAt)) - first + DAY / 2) / DAY);
    const bar = bars[i];
    if (!bar) continue;
    bar.total += 1;
    if (r.state === "failed") bar.failed = true;
  }
  return bars;
}
