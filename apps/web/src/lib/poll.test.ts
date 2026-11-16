import { describe, expect, it } from "vitest";
import { pollDelay, takingLonger } from "./poll";

describe("pollDelay", () => {
  it("polls every second while work is moving", () => {
    for (const s of ["pending", "running", "queued"]) expect(pollDelay(s)).toBe(1000);
  });
  it("slows to 10 s while a person must act", () => {
    for (const s of ["waiting", "needs_review"]) expect(pollDelay(s)).toBe(10_000);
  });
  it("stops once finished", () => {
    for (const s of ["succeeded", "failed", "cancelled"]) expect(pollDelay(s)).toBeNull();
  });
});

describe("takingLonger", () => {
  const now = Date.parse("2026-11-16T12:01:00Z");
  it("is false at 59 s and true at 61 s", () => {
    expect(takingLonger("2026-11-16T12:00:01Z", now)).toBe(false);
    expect(takingLonger("2026-11-16T11:59:59Z", now)).toBe(true);
  });
});
