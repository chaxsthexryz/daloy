import { definitionSchema } from "@daloy/engine";
import { describe, expect, it } from "vitest";
import { addStep, blankDraft, duplicateStep, layout, readCopiedStep, removeStep, toFlow, type Draft } from "./graph";

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
    expect(flow.nodes.find((n) => n.id === "condition_1")!.ariaLabel).toBe("Condition step condition_1, on true goes to http_1");
    expect(flow.edges).toContainEqual(expect.objectContaining({ source: "trigger", target: "condition_1" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ source: "condition_1", target: "http_1", sourceHandle: "true", label: "true" }));
  });
});


describe("localized diagram labels", () => {
  it("keeps graph ids and branch handles stable", () => {
    const draft = addStep(blankDraft(), "condition").draft;
    const withEmail = addStep(draft, "email", { id: "condition_1", on: "true" }).draft;
    const translated = toFlow(withEmail, null, undefined, "tl");
    expect(translated.nodes[0]?.ariaLabel).toBe("Simula: Ikaw ang magpapatakbo");
    expect(translated.edges[1]).toMatchObject({ sourceHandle: "true", label: "oo" });
    expect(translated.nodes[1]?.id).toBe("condition_1");
    expect(toFlow(withEmail, null).edges[1]?.label).toBe("true");
  });
});


it("localizes newly added defaults while keeping config identifiers stable", () => {
  const draft = addStep(blankDraft(), "email", undefined, "tl").draft;
  expect(draft.steps[0]?.config).toMatchObject({ to: "{{trigger.email}}", subject: "Kumusta", text: "Kumusta, salamat sa pakikipag-ugnayan." });
  expect(addStep(blankDraft(), "email").draft.steps[0]?.config).toMatchObject({ subject: "Hello" });
});

describe("duplicateStep (U2)", () => {
  const straight = (): Draft => ({
    trigger: { type: "manual", config: {} },
    steps: [
      { id: "post", type: "http", config: { method: "POST", url: "https://example.com/a", headers: {}, body: "{}" } },
      { id: "mail", type: "email", config: { to: "ana@example.com", subject: "Hi", text: "Hello" } },
    ],
    edges: [{ from: "post", to: "mail" }],
  });

  it("copies the type and config under a new id and puts the copy right after the original", () => {
    const r = duplicateStep(straight(), "post");
    if (!("draft" in r)) throw new Error("refused");
    expect(r.id).toBe("post_copy");
    const copy = r.draft.steps.find((s) => s.id === "post_copy")!;
    expect(copy).toEqual({ ...straight().steps[0], id: "post_copy" });
    expect(r.draft.edges).toEqual([
      { from: "post", to: "post_copy" },
      { from: "post_copy", to: "mail" },
    ]);
    expect(valid(r.draft)).toEqual([]);
  });

  it("numbers later copies _copy_2, _copy_3 and copies the last step onto the end", () => {
    let d = straight();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = duplicateStep(d, "mail");
      if (!("draft" in r)) throw new Error("refused");
      d = r.draft;
      ids.push(r.id);
    }
    expect(ids).toEqual(["mail_copy", "mail_copy_2", "mail_copy_3"]);
    expect(d.edges).toContainEqual({ from: "mail", to: "mail_copy_3" });
    expect(valid(d)).toEqual([]);
  });

  it("keeps a long id inside the 64 character limit", () => {
    const long = "a".repeat(64);
    const d: Draft = { trigger: { type: "manual", config: {} }, steps: [{ id: long, type: "delay", config: { seconds: 5 } }], edges: [] };
    const r = duplicateStep(d, long);
    if (!("draft" in r)) throw new Error("refused");
    expect(r.id.length).toBeLessThanOrEqual(64);
    expect(valid(r.draft)).toEqual([]);
  });

  it("refuses a step with branches, and a step that is not there, with a reason", () => {
    const d = addStep(blankDraft(), "condition").draft;
    expect(duplicateStep(d, "condition_1")).toEqual({ error: { id: "branching", step: "condition_1" } });
    expect(duplicateStep(d, "nope")).toEqual({ error: { id: "missing", step: "nope" } });
  });
});

describe("readCopiedStep (U2 paste check)", () => {
  const copied = (v: unknown) => JSON.stringify(v);

  it("reads a copied step and drops keys the step schema does not know", () => {
    expect(readCopiedStep(copied({ type: "delay", config: { seconds: 30, extra: "x" } }))).toEqual({ type: "delay", config: { seconds: 30 } });
  });

  it("refuses text that is not a step Daloy can add", () => {
    expect(readCopiedStep("hello")).toBeNull();
    expect(readCopiedStep("null")).toBeNull();
    expect(readCopiedStep(copied({ type: "teleport", config: {} }))).toBeNull();
    // Payment steps need links to other steps, so they are not in the add menu and cannot be pasted either.
    expect(readCopiedStep(copied({ type: "payment_expire", config: { due: "pay" } }))).toBeNull();
    expect(readCopiedStep(copied({ type: "delay", config: { seconds: "soon" } }))).toBeNull();
    expect(readCopiedStep(copied({ type: "email" }))).toBeNull();
  });

  it("pastes through addStep after the chosen step, and the draft stays valid", () => {
    const base = addStep(blankDraft(), "http").draft;
    const step = readCopiedStep(copied({ type: "email", config: { to: "{{trigger.email}}", subject: "Hi", text: "Hello" } }))!;
    const r = addStep(base, step.type, { id: "http_1" }, "en", step.config);
    expect(r.id).toBe("email_1");
    expect(r.draft.steps.find((s) => s.id === "email_1")!.config).toEqual(step.config);
    expect(r.draft.edges).toEqual([{ from: "http_1", to: "email_1" }]);
    expect(valid(r.draft)).toEqual([]);
  });
});
