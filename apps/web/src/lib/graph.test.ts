import { definitionSchema } from "@daloy/engine";
import { describe, expect, it } from "vitest";
import { addStep, blankDraft, layout, removeStep, toFlow, type Draft } from "./graph";

const valid = (d: Draft) => {
  const r = definitionSchema.safeParse(d);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("addStep", () => {
  it("adds the first step with a valid default config", () => {
    const { draft, id } = addStep(blankDraft(), "http");
    expect(id).toBe("http_1");
    expect(draft.steps).toHaveLength(1);
    expect(valid(draft)).toEqual([]);
  });

  it("appends after a step and inserts between a step and its successor", () => {
    let d = addStep(blankDraft(), "http").draft;
    d = addStep(d, "email", { id: "http_1" }).draft;
    expect(d.edges).toEqual([{ from: "http_1", to: "email_1" }]);
    d = addStep(d, "delay", { id: "http_1" }).draft;
    expect(d.edges).toEqual([
      { from: "http_1", to: "delay_1" },
      { from: "delay_1", to: "email_1" },
    ]);
    expect(valid(d)).toEqual([]);
  });

  it("fills the free branches of a condition in order, then inserts on the chosen one", () => {
    let d = addStep(blankDraft(), "condition").draft;
    d = addStep(d, "http", { id: "condition_1" }).draft;
    d = addStep(d, "email", { id: "condition_1" }).draft;
    expect(d.edges).toEqual([
      { from: "condition_1", to: "http_1", on: "true" },
      { from: "condition_1", to: "email_1", on: "false" },
    ]);
    d = addStep(d, "delay", { id: "condition_1", on: "true" }).draft;
    expect(d.edges).toContainEqual({ from: "condition_1", to: "delay_1", on: "true" });
    expect(d.edges).toContainEqual({ from: "delay_1", to: "http_1" });
    expect(valid(d)).toEqual([]);
  });

  it("gives an approval its approved, rejected and timeout branches, and valid default configs to ai and approval", () => {
    let d = addStep(blankDraft(), "approval").draft;
    d = addStep(d, "ai", { id: "approval_1" }).draft;
    d = addStep(d, "email", { id: "approval_1" }).draft;
    d = addStep(d, "delay", { id: "approval_1" }).draft;
    expect(d.edges).toEqual([
      { from: "approval_1", to: "ai_1", on: "approved" },
      { from: "approval_1", to: "email_1", on: "rejected" },
      { from: "approval_1", to: "delay_1", on: "timeout" },
    ]);
    expect(valid(d)).toEqual([]);
  });

  it("gives an inserted condition the true branch to the old successor", () => {
    let d = addStep(blankDraft(), "http").draft;
    d = addStep(d, "email", { id: "http_1" }).draft;
    d = addStep(d, "condition", { id: "http_1" }).draft;
    expect(d.edges).toContainEqual({ from: "condition_1", to: "email_1", on: "true" });
    expect(valid(d)).toEqual([]);
  });

  it("adds a new entry step in front of the current one when no step is given", () => {
    let d = addStep(blankDraft(), "http").draft;
    d = addStep(d, "delay").draft;
    expect(d.edges).toEqual([{ from: "delay_1", to: "http_1" }]);
    expect(valid(d)).toEqual([]);
  });
});

describe("removeStep", () => {
  it("reconnects the parent to the child, keeping the branch label", () => {
    let d = addStep(blankDraft(), "condition").draft;
    d = addStep(d, "delay", { id: "condition_1" }).draft;
    d = addStep(d, "email", { id: "delay_1" }).draft;
    d = removeStep(d, "delay_1");
    expect(d.steps.map((s) => s.id)).toEqual(["condition_1", "email_1"]);
    expect(d.edges).toEqual([{ from: "condition_1", to: "email_1", on: "true" }]);
  });

  it("lets the child become the entry when the entry step is removed", () => {
    let d = addStep(blankDraft(), "http").draft;
    d = addStep(d, "email", { id: "http_1" }).draft;
    d = removeStep(d, "http_1");
    expect(d.edges).toEqual([]);
    expect(valid(d)).toEqual([]);
  });
});

describe("layout and toFlow", () => {
  it("puts each step one row below its deepest parent and centres branches", () => {
    let d = addStep(blankDraft(), "condition").draft;
    d = addStep(d, "http", { id: "condition_1" }).draft;
    d = addStep(d, "email", { id: "condition_1" }).draft;
    const pos = layout(d);
    expect(pos.condition_1!.y).toBeLessThan(pos.http_1!.y);
    expect(pos.http_1!.y).toBe(pos.email_1!.y);
    expect(pos.http_1!.x).toBe(-pos.email_1!.x);
  });

  it("makes a trigger node, one node per step, and labelled branch edges", () => {
    let d = addStep(blankDraft(), "condition").draft;
    d = addStep(d, "http", { id: "condition_1" }).draft;
    const flow = toFlow(d, "http_1");
    expect(flow.nodes.map((n) => n.id)).toEqual(["trigger", "condition_1", "http_1"]);
    expect(flow.nodes.find((n) => n.id === "http_1")!.selected).toBe(true);
    expect(flow.nodes.find((n) => n.id === "condition_1")!.ariaLabel).toBe("condition step condition_1, on true goes to http_1");
    expect(flow.edges).toContainEqual(expect.objectContaining({ source: "trigger", target: "condition_1" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ source: "condition_1", target: "http_1", sourceHandle: "true", label: "true" }));
  });
});
