import { describe, expect, it } from "vitest";
import { stepStates } from "./guided";

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
