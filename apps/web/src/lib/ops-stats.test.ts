import { describe, expect, it } from "vitest";
import { dayBars, runStats, type RunLite } from "./ops-stats";

// Local times throughout, so the test gives the same answer in any time zone.
const NOW = new Date(2026, 10, 20, 15, 0).getTime();
const at = (daysAgo: number, hour = 9) => new Date(2026, 10, 20 - daysAgo, hour, 0).toISOString();
const run = (id: string, workflowId: string, state: string, daysAgo: number, hour = 9): RunLite => ({ id, workflowId, state, createdAt: at(daysAgo, hour) });

describe("runStats", () => {
  const runs = [run("1", "a", "succeeded", 0), run("2", "a", "failed", 0, 10), run("3", "b", "succeeded", 1), run("4", "b", "succeeded", 6), run("5", "b", "succeeded", 7), run("6", "a", "needs_review", 0, 11)];
  it("counts today and the last seven calendar days, today included", () => {
    const s = runStats(runs, NOW);
    expect(s.today).toBe(3);
    expect(s.week).toBe(5);
  });
  it("rates success over finished runs only, so a run waiting for a person does not count against it", () => {
    expect(runStats(runs, NOW).rate).toBeCloseTo(3 / 4);
  });
  it("has no rate when nothing finished", () => {
    expect(runStats([], NOW).rate).toBeNull();
    expect(runStats([run("1", "a", "running", 0)], NOW).rate).toBeNull();
    expect(runStats([run("1", "a", "cancelled", 0)], NOW).rate).toBeNull();
  });
  it("is exact when fewer runs than the limit came back", () => {
    expect(runStats(runs, NOW, 50)).toMatchObject({ cappedToday: false, cappedWeek: false });
  });
  it("says the figures are partial when the limit came back and the oldest run is still inside the window", () => {
    const full = Array.from({ length: 50 }, (_, i) => run(String(i), "a", "succeeded", i < 10 ? 0 : 3));
    expect(runStats(full, NOW, 50)).toMatchObject({ cappedToday: false, cappedWeek: true });
    const onlyToday = Array.from({ length: 50 }, (_, i) => run(String(i), "a", "succeeded", 0));
    expect(runStats(onlyToday, NOW, 50)).toMatchObject({ cappedToday: true, cappedWeek: true });
  });
  it("is exact when the limit came back but the oldest run is already before the window", () => {
    const full = [...Array.from({ length: 49 }, (_, i) => run(String(i), "a", "succeeded", 0)), run("old", "a", "succeeded", 9)];
    expect(runStats(full, NOW, 50)).toMatchObject({ cappedToday: false, cappedWeek: false });
  });
});

describe("dayBars", () => {
  const runs = [run("1", "a", "succeeded", 0), run("2", "a", "failed", 0, 10), run("3", "a", "succeeded", 2), run("4", "b", "succeeded", 1)];
  it("gives seven days, oldest first, for one automation", () => {
    const bars = dayBars(runs, "a", NOW);
    expect(bars).toHaveLength(7);
    expect(bars.map((b) => b.total)).toEqual([0, 0, 0, 0, 1, 0, 2]);
  });
  it("marks a day with a failed run", () => {
    const bars = dayBars(runs, "a", NOW);
    expect(bars.map((b) => b.failed)).toEqual([false, false, false, false, false, false, true]);
  });
  it("is all empty for an automation without runs", () => {
    expect(dayBars(runs, "none", NOW).every((b) => b.total === 0)).toBe(true);
  });
});
