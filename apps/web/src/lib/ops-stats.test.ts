import { describe, expect, it } from "vitest";
import { successRate, totals, type RunCounts } from "./ops-stats";

const counts = (over: Partial<RunCounts> = {}): RunCounts => ({ today: 0, week: 0, succeeded: 0, failed: 0, days: Array.from({ length: 7 }, () => ({ total: 0, failed: false })), ...over });

describe("totals", () => {
  it("adds today and seven day runs over every automation, however many there are", () => {
    const t = totals([counts({ today: 100, week: 400, succeeded: 300, failed: 50 }), counts({ today: 20, week: 20, succeeded: 20 }), counts()]);
    expect(t).toMatchObject({ today: 120, week: 420 });
    expect(t.rate).toBeCloseTo(320 / 370);
  });
  it("has no rate when nothing finished, and zero counts for no automations", () => {
    expect(totals([]).rate).toBeNull();
    expect(totals([counts({ today: 2, week: 2 })])).toMatchObject({ today: 2, week: 2, rate: null });
  });
});

describe("successRate", () => {
  it("rates succeeded over finished runs only, so a run waiting for a person does not count against it", () => {
    expect(successRate({ succeeded: 3, failed: 1 })).toBeCloseTo(0.75);
    expect(successRate({ succeeded: 0, failed: 2 })).toBe(0);
  });
  it("is null when no run finished", () => {
    expect(successRate({ succeeded: 0, failed: 0 })).toBeNull();
  });
});
