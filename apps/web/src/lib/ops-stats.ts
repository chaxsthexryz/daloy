/** What GET /workflows/overview counts for one automation: real runs, in the viewer's time zone, with no cap. */
export type RunCounts = { today: number; week: number; succeeded: number; failed: number; days: { total: number; failed: boolean }[] };

/** One entry of GET /workflows/overview. */
export type OverviewEntry = { id: string; trigger: string | null; owner: { email: string }; apps: string[]; runs: RunCounts };

/** How many runs GET /runs sends: the "needs you" list and an automation's recent runs. The Automations figures no longer depend on it. */
export const RUN_LIMIT = 50;

/** Succeeded over finished runs. A run waiting for a person or still going does not count either way. Null when none finished. */
export const successRate = (c: Pick<RunCounts, "succeeded" | "failed">) => (c.succeeded + c.failed === 0 ? null : c.succeeded / (c.succeeded + c.failed));

/** The strip above the table: runs today, runs in the last seven days and the seven day success rate, over every automation. */
export function totals(all: RunCounts[]) {
  const sum = (pick: (c: RunCounts) => number) => all.reduce((n, c) => n + pick(c), 0);
  return { today: sum((c) => c.today), week: sum((c) => c.week), rate: successRate({ succeeded: sum((c) => c.succeeded), failed: sum((c) => c.failed) }) };
}
