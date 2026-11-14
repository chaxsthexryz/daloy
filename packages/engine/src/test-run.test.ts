import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { choiceProblems, testChoicesSchema } from "./test-run";

const def = definitionSchema.parse({
  trigger: { type: "manual", config: {} },
  steps: [
    { id: "classify", type: "ai", config: { task: "classify", input: "x", labels: { refund: "r", other: "o" } } },
    { id: "sum", type: "ai", config: { task: "summarize", input: "x" } },
    { id: "ask", type: "approval", config: { to: "a@example.com", subject: "s", message: "m", timeoutSeconds: 60 } },
    { id: "log", type: "sheets", config: { columns: ["a"] } },
    { id: "gate", type: "condition", config: { condition: { left: "1", op: "eq", right: "1" } } },
  ],
  edges: [
    { from: "classify", to: "sum" },
    { from: "sum", to: "ask" },
    { from: "ask", to: "log", on: "approved" },
    { from: "log", to: "gate" },
  ],
});

describe("booking choices", () => {
  const booking = definitionSchema.parse({
    trigger: { type: "form", config: { fields: [{ name: "at", label: "At", type: "datetime", timezone: "UTC" }, { name: "who", label: "Who", type: "resource" }] } },
    steps: [
      { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.who}}", start: "{{trigger.at}}", minutes: 30 } },
      { id: "note", type: "sheets", config: { columns: ["a"] } },
    ],
    edges: [{ from: "book", to: "note", on: "done" }],
  });
  it("lets a faked run choose taken or not_found on a booking step only", () => {
    expect(choiceProblems(booking, testChoicesSchema.parse({ book: { booking: "taken" } }), "mock")).toEqual([]);
    expect(choiceProblems(booking, testChoicesSchema.parse({ book: { booking: "not_found" } }), "ai")).toEqual([]);
    expect(choiceProblems(booking, testChoicesSchema.parse({ note: { booking: "taken" } }), "mock")).toEqual(["choices.note: only a booking step takes a booking outcome"]);
    expect(testChoicesSchema.safeParse({ book: { booking: "done" } }).success).toBe(false);
  });
});

describe("choiceProblems", () => {
  it("accepts a label, a decision and a mocked failure on the right steps", () => {
    const choices = testChoicesSchema.parse({ classify: { label: "refund" }, ask: { decision: "timeout" }, log: { fail: "retryable" } });
    expect(choiceProblems(def, choices, "mock")).toEqual([]);
    expect(choiceProblems(def, choices, "ai")).toEqual([]);
    expect(choiceProblems(def, testChoicesSchema.parse({ log: { fail: "unknown" } }), "mock")).toEqual([]);
  });
  it("names each choice that does not fit its step", () => {
    const choices = testChoicesSchema.parse({ classify: { label: "nope" }, sum: { label: "x" }, gate: { fail: "permanent" }, log: { decision: "approved" }, missing: { label: "x" } });
    expect(choiceProblems(def, choices, "mock")).toEqual([
      'choices.classify: "nope" is not a label of this classify step',
      "choices.sum: only a classify step takes a label",
      "choices.gate: only a step that reaches outside Daloy can be set to fail",
      "choices.log: only an approval step takes a decision",
      'choices.missing: there is no step "missing"',
    ]);
  });
  it("refuses choices on a live test run, which makes real calls", () => {
    expect(choiceProblems(def, { ask: { decision: "rejected" } }, "live")).toEqual(["choices: a live test run makes real calls, so its outcomes cannot be chosen"]);
    expect(choiceProblems(def, {}, "live")).toEqual([]);
  });
  it("refuses a choice with an unknown shape or extra keys", () => {
    expect(testChoicesSchema.safeParse({ ask: { decision: "maybe" } }).success).toBe(false);
    expect(testChoicesSchema.safeParse({ ask: { decision: "approved", label: "x" } }).success).toBe(false);
  });
});
