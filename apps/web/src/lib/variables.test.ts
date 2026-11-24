import { describe, expect, it } from "vitest";
import type { StepRun } from "../api";
import { outputPaths, previewValue, sampleOutputs, parseSample, spliceAt, variableGroups } from "./variables";
import { upstreamIds } from "./editor";
import type { Draft } from "./graph";

const flow = {
  trigger: { type: "manual", config: {} },
  steps: [
    { id: "a", type: "delay", config: { seconds: 1 } },
    { id: "b", type: "delay", config: { seconds: 1 } },
    { id: "c", type: "delay", config: { seconds: 1 } },
    { id: "d", type: "delay", config: { seconds: 1 } },
    { id: "e", type: "delay", config: { seconds: 1 } },
  ],
  // a -> b -> d, a -> c -> d, d -> e. b and c are siblings; e is after everything.
  edges: [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
    { from: "b", to: "d" },
    { from: "c", to: "d" },
    { from: "d", to: "e" },
  ],
} as unknown as Draft;

describe("upstreamIds", () => {
  it("is every step reachable backwards along edges, and never the step itself", () => {
    expect([...upstreamIds(flow, "e")].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...upstreamIds(flow, "d")].sort()).toEqual(["a", "b", "c"]);
  });
  it("leaves out a sibling branch and anything after the step", () => {
    expect([...upstreamIds(flow, "b")]).toEqual(["a"]);
    expect(upstreamIds(flow, "a").size).toBe(0);
  });
  it("stops on a loop and still excludes the step itself", () => {
    const loop = { ...flow, edges: [...flow.edges, { from: "e", to: "a" }] } as Draft;
    expect([...upstreamIds(loop, "a")].sort()).toEqual(["b", "c", "d", "e"]);
  });
});

describe("outputPaths", () => {
  it("lists leaf paths with a short preview, in the order the values come", () => {
    expect(outputPaths({ amount: "250.00", store: "Mercury", saved: true, n: 3 })).toEqual([
      { path: "amount", preview: "250.00" },
      { path: "store", preview: "Mercury" },
      { path: "saved", preview: "true" },
      { path: "n", preview: "3" },
    ]);
  });
  it("walks objects and array positions, the way {{steps.x.output.items.0.sku}} resolves", () => {
    expect(outputPaths({ order: { id: 7 }, items: [{ sku: "A" }, { sku: "B" }] }).map((p) => p.path)).toEqual(["order.id", "items.0.sku", "items.1.sku"]);
  });
  it("has no paths for a scalar, null or an empty value, and the whole output is still insertable by the caller", () => {
    expect(outputPaths(null)).toEqual([]);
    expect(outputPaths("ok")).toEqual([]);
    expect(outputPaths({})).toEqual([]);
  });
  it("skips keys the template engine would reject", () => {
    expect(outputPaths({ "bad key": 1, "a.b": 2, constructor: 3, ok: 4 }).map((p) => p.path)).toEqual(["ok"]);
  });
  it("shows [secret] for a secret-looking key and never the value", () => {
    const paths = outputPaths({ api_key: "sk-live-123", headers: { Authorization: "Bearer abc" }, name: "Ana" });
    expect(paths).toEqual([
      { path: "api_key", preview: "[secret]" },
      { path: "headers.Authorization", preview: "[secret]" },
      { path: "name", preview: "Ana" },
    ]);
    expect(JSON.stringify(paths)).not.toContain("sk-live");
  });
  it("caps the list and the depth", () => {
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    expect(outputPaths(wide, 10)).toHaveLength(10);
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(outputPaths(deep).map((p) => p.path)).toEqual(["a.b.c.d.e.f"]);
  });
});

describe("previewValue", () => {
  it("shortens long text and one-lines objects", () => {
    expect(previewValue("x".repeat(100), 10)).toBe("xxxxxxxxx…");
    expect(previewValue("line one\nline two", 40)).toBe("line one line two");
    expect(previewValue({ a: 1 }, 40)).toBe('{"a":1}');
    expect(previewValue(null, 40)).toBe("null");
  });
});

describe("spliceAt", () => {
  it("inserts at the caret and puts the caret after the reference", () => {
    expect(spliceAt("Hi , welcome", "{{trigger.name}}", 3, 3)).toEqual({ value: "Hi {{trigger.name}}, welcome", caret: 19 });
  });
  it("replaces a selection", () => {
    expect(spliceAt("Hi NAME!", "{{trigger.name}}", 3, 7)).toEqual({ value: "Hi {{trigger.name}}!", caret: 19 });
  });
  it("appends when there is no caret", () => {
    expect(spliceAt("Hi ", "{{trigger.name}}", null, null)).toEqual({ value: "Hi {{trigger.name}}", caret: 19 });
  });
});

describe("sampleOutputs", () => {
  const at = (stepId: string, attempt: number, output: unknown, state = "succeeded"): StepRun => ({ id: `${stepId}${attempt}`, stepId, attempt, state, output, input: null, error: null, branch: null, inputTokens: null, outputTokens: null, outcome: null, resolvedBy: null, resolvedAt: null, createdAt: "", finishedAt: null });
  it("keeps the last attempt that produced an output, for upstream steps only", () => {
    const steps = [at("a", 1, { v: 1 }), at("a", 2, { v: 2 }), at("b", 1, { v: 3 }), at("e", 1, { v: 9 }), at("c", 1, null)];
    const got = sampleOutputs(steps, new Set(["a", "b", "c"]));
    expect([...got.entries()]).toEqual([["a", { v: 2 }], ["b", { v: 3 }]]);
  });
  it("ignores an attempt that failed", () => {
    expect(sampleOutputs([at("a", 1, { v: 1 }, "failed")], new Set(["a"])).size).toBe(0);
  });
});

describe("variableGroups", () => {
  const attempt = (stepId: string, output: unknown): StepRun => ({ id: stepId, stepId, attempt: 1, state: "succeeded", output, input: null, error: null, branch: null, inputTokens: null, outputTokens: null, outcome: null, resolvedBy: null, resolvedAt: null, createdAt: "", finishedAt: null });
  const refs = ["{{trigger.email}}", "{{steps.read.output.amount}}", "{{steps.save.output}}", "{{steps.later.output}}"];
  const ids = new Set(["read", "save", "later"]);

  it("lists the known fields with no preview before any test", () => {
    const groups = variableGroups(refs, [], undefined, ids);
    expect(groups.map((g) => [g.id, g.sampled, g.items.map((i) => i.ref)])).toEqual([
      ["trigger", false, ["{{trigger.email}}"]],
      ["read", false, ["{{steps.read.output.amount}}"]],
      ["save", false, ["{{steps.save.output}}"]],
      ["later", false, ["{{steps.later.output}}"]],
    ]);
    expect(groups.flatMap((g) => g.items).every((i) => i.preview === undefined)).toBe(true);
  });
  it("adds previews and the paths found in the real sample output", () => {
    const groups = variableGroups(refs, [attempt("read", { amount: "250.00", store: "Mercury" }), attempt("save", { fileId: "f1" })], { email: "ana@example.com", name: "Ana" }, ids);
    const by = Object.fromEntries(groups.map((g) => [g.id, g]));
    expect(by.trigger!.items).toEqual([{ ref: "{{trigger.email}}", label: "email", preview: "ana@example.com" }, { ref: "{{trigger.name}}", label: "name", preview: "Ana" }]);
    expect(by.read!.items.map((i) => [i.ref, i.preview])).toEqual([["{{steps.read.output.amount}}", "250.00"], ["{{steps.read.output.store}}", "Mercury"]]);
    // The whole output chip gives way to the real fields once they are known.
    expect(by.save!.items.map((i) => i.ref)).toEqual(["{{steps.save.output.fileId}}"]);
    expect(by.later!.sampled).toBe(false);
  });
  it("keeps the whole-output reference for a scalar output, and shows [secret] for a secret key", () => {
    const groups = variableGroups(["{{steps.save.output}}", "{{steps.read.output.amount}}"], [attempt("save", "ok"), attempt("read", { amount: "1", token: "abc" })], undefined, ids);
    expect(groups[0]!.items).toEqual([{ ref: "{{steps.save.output}}", label: "output", preview: "ok" }]);
    expect(groups[1]!.items.find((i) => i.label === "token")).toEqual({ ref: "{{steps.read.output.token}}", label: "token", preview: "[secret]" });
  });
});

describe("parseSample", () => {
  it("returns the typed trigger data, or undefined when it is empty or not JSON", () => {
    expect(parseSample('{"email":"a@b.c"}')).toEqual({ email: "a@b.c" });
    expect(parseSample("{}")).toBeUndefined();
    expect(parseSample("not json")).toBeUndefined();
    expect(parseSample("5")).toBeUndefined();
  });
});
