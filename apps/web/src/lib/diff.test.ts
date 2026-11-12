import { describe, expect, it } from "vitest";
import { jsonDiff } from "./diff";

describe("jsonDiff", () => {
  it("returns nothing for equal values, whatever the key order", () => {
    expect(jsonDiff({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toEqual([]);
  });

  it("reports added, removed and changed keys with their paths", () => {
    expect(jsonDiff({ a: 1, b: 2, n: { x: "old" } }, { a: 1, c: 3, n: { x: "new" } })).toEqual([
      { path: "b", kind: "removed", before: 2 },
      { path: "n.x", kind: "changed", before: "old", after: "new" },
      { path: "c", kind: "added", after: 3 },
    ]);
  });

  it("matches arrays of objects by id, so inserting a step does not shift every later one", () => {
    const before = { steps: [{ id: "a", type: "http" }, { id: "b", type: "email" }] };
    const after = { steps: [{ id: "a", type: "http" }, { id: "new", type: "delay" }, { id: "b", type: "condition" }] };
    expect(jsonDiff(before, after)).toEqual([
      { path: "steps[b].type", kind: "changed", before: "email", after: "condition" },
      { path: "steps[new]", kind: "added", after: { id: "new", type: "delay" } },
    ]);
  });

  it("compares other arrays by index", () => {
    expect(jsonDiff({ e: [{ from: "a" }] }, { e: [{ from: "b" }, { from: "c" }] })).toEqual([
      { path: "e[0].from", kind: "changed", before: "a", after: "b" },
      { path: "e[1]", kind: "added", after: { from: "c" } },
    ]);
  });

  it("treats a type change as one change", () => {
    expect(jsonDiff({ a: [1] }, { a: { 0: 1 } })).toEqual([{ path: "a", kind: "changed", before: [1], after: { 0: 1 } }]);
    expect(jsonDiff(null, { a: 1 })).toEqual([{ path: "", kind: "changed", before: null, after: { a: 1 } }]);
  });
});
