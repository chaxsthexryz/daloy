import { definitionSchema } from "@daloy/engine";
import { describe, expect, it } from "vitest";
import { addStep, blankDraft, canMove, connectSteps, moveStep, removeStep, type Draft } from "./graph";
import { record, redo, startHistory, undo } from "./history";

const valid = (d: Draft) => {
  const r = definitionSchema.safeParse(d);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};
const chain = (...types: Parameters<typeof addStep>[1][]) => {
  let d = blankDraft();
  let last: string | undefined;
  for (const type of types) {
    const r = addStep(d, type, last ? { id: last } : undefined);
    d = r.draft;
    last = r.id;
  }
  return d;
};
const order = (d: Draft) => d.steps.map((s) => s.id);
/** The step ids in the order the flow runs them, from edges alone. */
const flowOrder = (d: Draft) => {
  const out: string[] = [];
  for (let at = d.steps.find((s) => !d.edges.some((e) => e.to === s.id))?.id; at; at = d.edges.find((e) => e.from === at)?.to) out.push(at);
  return out;
};

describe("moveStep", () => {
  it("moves a step down and up, rewiring the edges and numbering in flow order", () => {
    const d = chain("http", "delay", "email"); // http_1 -> delay_1 -> email_1
    const down = moveStep(d, "http_1", "down");
    expect(flowOrder(down)).toEqual(["delay_1", "http_1", "email_1"]);
    expect(order(down)).toEqual(["delay_1", "http_1", "email_1"]);
    expect(valid(down)).toEqual([]);
    const up = moveStep(d, "email_1", "up");
    expect(flowOrder(up)).toEqual(["http_1", "email_1", "delay_1"]);
    expect(valid(up)).toEqual([]);
  });

  it("keeps the branch label of the edge that leads into the moved stretch", () => {
    let d = addStep(blankDraft(), "condition").draft;
    d = addStep(d, "http", { id: "condition_1", on: "true" }).draft;
    d = addStep(d, "delay", { id: "http_1" }).draft;
    d = addStep(d, "email", { id: "condition_1", on: "false" }).draft;
    const moved = moveStep(d, "http_1", "down");
    expect(moved.edges).toContainEqual({ from: "condition_1", to: "delay_1", on: "true" });
    expect(moved.edges).toContainEqual({ from: "delay_1", to: "http_1" });
    expect(moved.edges).toContainEqual({ from: "condition_1", to: "email_1", on: "false" });
    expect(valid(moved)).toEqual([]);
  });

  it("changes nothing at the ends, for the first step going up and the last going down", () => {
    const d = chain("http", "delay");
    expect(moveStep(d, "http_1", "up")).toBe(d);
    expect(moveStep(d, "delay_1", "down")).toBe(d);
    expect(canMove(d, "http_1", "down")).toBe(true);
    expect(canMove(d, "http_1", "up")).toBe(false);
  });

  it("never moves a branching step or a step next to one", () => {
    let d = addStep(blankDraft(), "http").draft;
    d = addStep(d, "condition", { id: "http_1" }).draft;
    d = addStep(d, "email", { id: "condition_1", on: "true" }).draft;
    d = addStep(d, "delay", { id: "condition_1", on: "false" }).draft;
    for (const [id, dir] of [["condition_1", "up"], ["condition_1", "down"], ["http_1", "down"], ["email_1", "up"], ["email_1", "down"]] as const) {
      expect(moveStep(d, id, dir)).toBe(d);
    }
  });

  it("is undone exactly by undo, and by moving back", () => {
    const d = chain("http", "delay", "email");
    const h = record(startHistory(d), moveStep(d, "delay_1", "down"));
    expect(undo(h).present).toBe(d);
    expect(redo(undo(h)).present).toBe(h.present);
    expect(moveStep(moveStep(d, "delay_1", "down"), "delay_1", "up")).toEqual(d);
  });
});

describe("edits keep the graph valid and history restores it", () => {
  it("add, move and remove in a row stay valid, and undo walks back to each earlier definition", () => {
    const steps: Draft[] = [blankDraft()];
    const apply = (next: Draft) => steps.push(next);
    apply(addStep(steps.at(-1)!, "http").draft);
    apply(addStep(steps.at(-1)!, "delay", { id: "http_1" }).draft);
    apply(addStep(steps.at(-1)!, "email", { id: "delay_1" }).draft);
    apply(moveStep(steps.at(-1)!, "http_1", "down"));
    apply(removeStep(steps.at(-1)!, "delay_1"));
    let h = steps.slice(1).reduce((acc, d) => record(acc, d), startHistory(steps[0]!));
    for (const d of steps.slice(1)) expect(valid(d)).toEqual([]);
    for (let i = steps.length - 2; i >= 0; i--) {
      h = undo(h);
      expect(h.present).toBe(steps[i]);
      expect(JSON.stringify(h.present)).toBe(JSON.stringify(steps[i]));
    }
  });
});

describe("connectSteps", () => {
  it("points a step at another step, replacing the old path", () => {
    let d = chain("http", "delay", "email"); // http -> delay -> email
    d = addStep(d, "slack", { id: "email_1" }).draft; // email -> slack
    const r = connectSteps(d, "http_1", undefined, "slack_1");
    // delay_1 would lose its way in, so the change is refused and explained.
    expect(r).toEqual({ error: { id: "orphan", step: "delay_1" } });
  });

  it("joins two paths on one step and keeps the definition valid", () => {
    let d = addStep(blankDraft(), "condition").draft;
    d = addStep(d, "http", { id: "condition_1", on: "true" }).draft;
    d = addStep(d, "email", { id: "condition_1", on: "false" }).draft;
    const r = connectSteps(d, "email_1", undefined, "http_1");
    expect("draft" in r && valid(r.draft)).toEqual([]);
    expect("draft" in r && r.draft.edges).toContainEqual({ from: "email_1", to: "http_1" });
  });

  it("refuses a link to itself and a loop, with a reason", () => {
    const d = chain("http", "delay");
    expect(connectSteps(d, "http_1", undefined, "http_1")).toEqual({ error: { id: "self" } });
    expect(connectSteps(d, "delay_1", undefined, "http_1")).toMatchObject({ error: { id: "loop" } });
  });

  it("needs a branch for a branching step and refuses a branch it does not have", () => {
    let d = addStep(blankDraft(), "condition").draft;
    d = addStep(d, "http", { id: "condition_1", on: "true" }).draft;
    d = addStep(d, "email", { id: "condition_1", on: "false" }).draft;
    d = addStep(d, "delay", { id: "email_1" }).draft;
    expect(connectSteps(d, "condition_1", undefined, "delay_1")).toMatchObject({ error: { id: "branch" } });
    expect(connectSteps(d, "http_1", "true", "delay_1")).toMatchObject({ error: { id: "branch" } });
    const ok = connectSteps(d, "http_1", undefined, "delay_1");
    expect("draft" in ok && valid(ok.draft)).toEqual([]);
  });
});
