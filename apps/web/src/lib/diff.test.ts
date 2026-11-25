import { describe, expect, it } from "vitest";
import { canRollbackVersion, describeChange, jsonDiff } from "./diff";

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

describe("describeChange and canRollbackVersion", () => {
  const baseDef = {
    trigger: { type: "manual", config: {} },
    steps: [
      { id: "condition_1", type: "condition", config: { condition: { left: "250", op: "gt", right: 100 } } },
      { id: "wait_1", type: "delay", config: { seconds: 3600 } },
    ],
    edges: [{ from: "condition_1", to: "wait_1", on: "true" }],
  };

  it("formats condition operators, durations, onError policies, and step changes cleanly", () => {
    const afterDef = {
      ...baseDef,
      steps: [
        { id: "condition_1", type: "condition", config: { condition: { left: "250", op: "lt", right: 100 } }, onError: "skip" },
        { id: "wait_1", type: "delay", config: { seconds: 21_600 } },
        { id: "sms_1", type: "sms", config: { to: "+639171234567", message: "Hi" } },
      ],
    };
    const opDesc = describeChange({ path: "steps[condition_1].config.condition.op", kind: "changed", before: "gt", after: "lt" }, baseDef, afterDef, "en");
    expect(opDesc.headline).toContain("Condition");
    expect(opDesc.beforeText).toBe("is greater than");
    expect(opDesc.afterText).toBe("is less than");
    const opTl = describeChange({ path: "steps[condition_1].config.condition.op", kind: "changed", before: "gt", after: "lt" }, baseDef, afterDef, "tl");
    expect(opTl.beforeText).toBe("ay higit sa");
    expect(opTl.afterText).toBe("ay mas maliit sa");

    const waitDesc = describeChange({ path: "steps[wait_1].config.seconds", kind: "changed", before: 3600, after: 21_600 }, baseDef, afterDef, "en");
    expect(waitDesc.beforeText).toBe("1 hour");
    expect(waitDesc.afterText).toBe("6 hours");

    const errDesc = describeChange({ path: "steps[condition_1].onError", kind: "added", after: "skip" }, baseDef, afterDef, "en");
    expect(errDesc.afterText).toBe("Skip and carry on");

    const stepAdded = describeChange({ path: "steps[sms_1]", kind: "added", after: afterDef.steps[2] }, baseDef, afterDef, "en");
    expect(stepAdded.headline).toContain("Send an SMS");
  });

  it("forbids rolling back to the latest version, the live version, or unpublished drafts", () => {
    expect(canRollbackVersion({ version: 3, latestVersion: 3, liveVersion: 1, published: true })).toBe(false);
    expect(canRollbackVersion({ version: 2, latestVersion: 2, liveVersion: 1, published: false })).toBe(false);
    expect(canRollbackVersion({ version: 2, latestVersion: 3, liveVersion: 2, published: true })).toBe(false);
    expect(canRollbackVersion({ version: 2, latestVersion: 3, liveVersion: 1, published: false })).toBe(false);
    expect(canRollbackVersion({ version: 1, latestVersion: 3, liveVersion: 2, published: true })).toBe(true);
  });
});
