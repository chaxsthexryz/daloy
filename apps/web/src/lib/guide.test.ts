import { describe, expect, it } from "vitest";
import { guideSteps, testState } from "./guide";

describe("testState", () => {
  const sample = { key: "A", runId: "r1" };
  it("is none before any sample test", () => expect(testState("A", null, null)).toBe("none"));
  it("marks a result out of date once the draft changes", () => expect(testState("B", sample, "succeeded")).toBe("stale"));
  it("follows the run for the same draft", () => {
    expect(testState("A", sample, null)).toBe("running");
    expect(testState("A", sample, "running")).toBe("running");
    expect(testState("A", sample, "succeeded")).toBe("passed");
    expect(testState("A", sample, "failed")).toBe("failed");
  });
});

describe("guideSteps", () => {
  const base = { missingApps: 0, problems: 0, explained: false, test: "none" as const, live: false };
  it("marks each step on its own facts", () => {
    expect(guideSteps(base).map((s) => s.done)).toEqual([true, true, false, false, false]);
    expect(guideSteps({ ...base, missingApps: 1, problems: 2, explained: true, test: "passed", live: true }).map((s) => s.done)).toEqual([false, false, true, true, true]);
  });
  it("does not count a stale or failed test as tried", () => {
    expect(guideSteps({ ...base, test: "stale" })[3]!.done).toBe(false);
    expect(guideSteps({ ...base, test: "failed" })[3]!.done).toBe(false);
  });
});
