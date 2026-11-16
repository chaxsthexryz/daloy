import { describe, expect, it } from "vitest";
import { ago, lastEvent, plainState, runKind } from "./states";

const NOW = new Date("2026-11-16T12:00:00Z").getTime();
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const run = (over: Partial<Parameters<typeof plainState>[0]> = {}) => ({ state: "succeeded", createdAt: at(5), needsReview: false, ...over });

describe("plainState", () => {
  it("maps finished runs", () => {
    expect(plainState(run(), NOW)).toMatchObject({ key: "done", label: "Done" });
    expect(plainState(run({ state: "failed" }), NOW)).toMatchObject({ key: "problem", label: "Problem" });
    expect(plainState(run({ state: "cancelled" }), NOW)).toMatchObject({ key: "done", note: "Closed" });
  });
  it("maps a wait to Waiting", () => {
    expect(plainState(run({ state: "waiting" }), NOW)).toMatchObject({ key: "waiting", label: "Waiting" });
  });
  it("maps pending, queued and running to Working", () => {
    for (const state of ["pending", "queued", "running"]) expect(plainState(run({ state }), NOW)).toMatchObject({ key: "working", label: "Working" });
  });
  it("adds the slow note after 60 seconds only", () => {
    expect(plainState(run({ state: "running", createdAt: at(59) }), NOW).note).toBeUndefined();
    expect(plainState(run({ state: "running", createdAt: at(61) }), NOW).note).toBe("Taking longer than usual");
  });
  it("shows Needs you for a parked run or a delivery in review", () => {
    expect(plainState(run({ state: "needs_review", needsReview: true }), NOW)).toMatchObject({ key: "needs_you", label: "Needs you" });
    expect(plainState(run({ state: "succeeded", needsReview: true }), NOW)).toMatchObject({ key: "needs_you" });
  });
  it("lets Needs you beat Problem, and a failed delivery count as a Problem", () => {
    expect(plainState(run({ state: "failed", needsReview: true }), NOW).key).toBe("needs_you");
    expect(plainState(run({ deliveryFailed: true }), NOW).key).toBe("problem");
  });
  it("calls a superseded run Done with a booking note, unless a person still has to act", () => {
    expect(plainState(run({ state: "waiting", superseded: true }), NOW)).toMatchObject({ key: "done", note: "Closed: its booking changed" });
    expect(plainState(run({ state: "needs_review", needsReview: true, superseded: true }), NOW).key).toBe("needs_you");
  });
  it("never shows a raw state word", () => {
    for (const state of ["pending", "queued", "running", "waiting", "needs_review", "succeeded", "failed", "cancelled"]) {
      expect(plainState(run({ state, needsReview: state === "needs_review" }), NOW).label).toMatch(/^(Done|Waiting|Needs you|Problem|Working)$/);
    }
  });
});

describe("ago", () => {
  it("uses the largest whole unit", () => {
    expect(ago(at(10), NOW)).toBe("just now");
    expect(ago(at(60), NOW)).toBe("1 minute ago");
    expect(ago(at(5 * 60), NOW)).toBe("5 minutes ago");
    expect(ago(at(2 * 3600), NOW)).toBe("2 hours ago");
    expect(ago(at(3 * 86400), NOW)).toBe("3 days ago");
    expect(ago(at(70 * 86400), NOW)).toBe("2 months ago");
  });
  it("treats a clock skew in the future as just now", () => {
    expect(ago(at(-30), NOW)).toBe("just now");
  });
});

describe("lastEvent", () => {
  const base = { runId: "r", state: "succeeded", createdAt: at(2 * 3600), needsReview: false, deliveryFailed: false, superseded: false };
  it("names the request when there is one", () => {
    expect(lastEvent({ ...base, reference: "REQ-V7E6FW" }, NOW)).toBe("Request REQ-V7E6FW received 2 hours ago");
  });
  it("falls back to the last run, and to no activity", () => {
    expect(lastEvent({ ...base, reference: null }, NOW)).toBe("Last ran 2 hours ago");
    expect(lastEvent(null, NOW)).toBe("No activity yet");
  });
});

describe("runKind", () => {
  it("uses owner words", () => {
    expect(runKind({ test: false, live: true })).toBe("Real run");
    expect(runKind({ test: true, live: false })).toBe("Preview (nothing sent)");
    expect(runKind({ test: true, live: true })).toBe("Preview with real calls");
    expect(runKind({ test: true, live: false, aiLive: true })).toBe("Preview with real AI, other calls mocked");
  });
});
