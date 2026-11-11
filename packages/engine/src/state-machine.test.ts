import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, IllegalTransitionError } from "./state-machine";
import transitions from "./transitions.json";

const tables: Record<string, Record<string, string[]>> = transitions;

describe("transition table", () => {
  it("has exactly the states from the spec", () => {
    expect(Object.keys(tables.run!).sort()).toEqual(
      ["cancelled", "failed", "pending", "running", "succeeded", "waiting"],
    );
    expect(Object.keys(tables.step!).sort()).toEqual(
      ["failed", "pending", "running", "skipped", "succeeded", "waiting"],
    );
  });

  it("only points at known states", () => {
    for (const table of Object.values(tables)) {
      for (const targets of Object.values(table)) {
        for (const to of targets) expect(Object.keys(table)).toContain(to);
      }
    }
  });
});

// One test per (kind, from, to) pair, generated from the data file.
for (const [kind, table] of Object.entries(tables)) {
  const states = Object.keys(table);
  const cases = states.flatMap((from) => states.map((to) => [from, to, table[from]!.includes(to)] as const));

  describe(`${kind} transitions`, () => {
    it.each(cases)("%s -> %s legal=%s", (from, to, legal) => {
      const k = kind as "run" | "step";
      expect(canTransition(k, from, to)).toBe(legal);
      if (legal) {
        expect(() => assertTransition(k, from, to)).not.toThrow();
      } else {
        expect(() => assertTransition(k, from, to)).toThrow(IllegalTransitionError);
      }
    });
  });
}

describe("assertTransition", () => {
  it("rejects unknown states, including inherited object keys", () => {
    expect(() => assertTransition("run", "paused", "running")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("run", "running", "paused")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("step", "constructor", "running")).toThrow(IllegalTransitionError);
  });

  it("carries kind, from and to on the error", () => {
    try {
      assertTransition("step", "succeeded", "running");
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ name: "IllegalTransitionError", kind: "step", from: "succeeded", to: "running" });
    }
  });
});
