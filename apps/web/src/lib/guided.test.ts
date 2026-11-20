import { describe, expect, it } from "vitest";
import { needsAttention, requestCounts, requestKind, stepStates } from "./guided";

describe("stepStates", () => {
  it("marks earlier steps complete, the open one current and the rest upcoming", () => {
    expect(stepStates(4, 0)).toEqual(["current", "upcoming", "upcoming", "upcoming"]);
    expect(stepStates(4, 2)).toEqual(["complete", "complete", "current", "upcoming"]);
    expect(stepStates(4, 3)).toEqual(["complete", "complete", "complete", "current"]);
  });
  it("has exactly one current step and as many states as steps", () => {
    for (const n of [4, 5]) for (let i = 0; i < n; i++) {
      const s = stepStates(n, i);
      expect(s).toHaveLength(n);
      expect(s.filter((x) => x === "current")).toHaveLength(1);
    }
  });
  it("gives a step index outside the list no current step instead of a wrong one", () => {
    expect(stepStates(3, -1)).toEqual(["upcoming", "upcoming", "upcoming"]);
    expect(stepStates(3, 7)).toEqual(["complete", "complete", "complete"]);
  });
});

const at = (h: number, day = 20) => new Date(2026, 10, day, h, 0).toISOString();
const NOW = new Date(2026, 10, 20, 15, 0).getTime();

describe("requestKind", () => {
  it("maps the run state of a request to what the live page shows", () => {
    expect(requestKind({ runState: "succeeded", createdAt: at(9) }, NOW)).toBe("done");
    expect(requestKind({ runState: "failed", createdAt: at(9) }, NOW)).toBe("failed");
    expect(requestKind({ runState: "waiting", createdAt: at(9) }, NOW)).toBe("waiting");
  });
  it("says sending for work that just started and slow once it passes 60 seconds", () => {
    const start = new Date(NOW - 30_000).toISOString();
    expect(requestKind({ runState: "running", createdAt: start }, NOW)).toBe("sending");
    expect(requestKind({ runState: "running", createdAt: new Date(NOW - 61_000).toISOString() }, NOW)).toBe("slow");
  });
});

describe("requestCounts", () => {
  const rows = [
    { runState: "succeeded", createdAt: at(10) },
    { runState: "waiting", createdAt: at(11) },
    { runState: "succeeded", createdAt: at(8, 19) },
    { runState: "failed", createdAt: at(9) },
  ];
  it("counts today's requests, the ones waiting for a person and the ones completed", () => {
    expect(requestCounts(rows, NOW)).toEqual({ today: 3, waiting: 1, completed: 2 });
  });
  it("counts yesterday's late request as not today, even a minute before midnight", () => {
    const late = [{ runState: "succeeded", createdAt: new Date(2026, 10, 19, 23, 59).toISOString() }];
    expect(requestCounts(late, NOW).today).toBe(0);
  });
  it("is all zero for no requests", () => {
    expect(requestCounts([], NOW)).toEqual({ today: 0, waiting: 0, completed: 0 });
  });
});

describe("needsAttention", () => {
  it("is true when a delivery failed or needs a person to check it", () => {
    expect(needsAttention([{ state: "delivered" }, { state: "failed" }])).toBe(true);
    expect(needsAttention([{ state: "needs_review" }])).toBe(true);
  });
  it("is false for delivered, queued and sending deliveries and for none", () => {
    expect(needsAttention([{ state: "delivered" }, { state: "queued" }, { state: "sending" }])).toBe(false);
    expect(needsAttention([])).toBe(false);
  });
});
