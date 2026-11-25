import { describe, expect, it } from "vitest";
import { definitionSchema, OUTSIDE_STEPS, stepBranches } from "./definition";
import { switchBranch } from "./expressions";
import { nextStep } from "./graph";
import { lintDefinition, lintFindings } from "./lint";

const manual = { type: "manual", config: {} };
const mail = (id: string, extra: object = {}) => ({ id, type: "email", config: { to: "a@example.com", subject: "s", text: "t" }, ...extra });
const sw = (cases: { label: string; equals: unknown }[] = [{ label: "billing", equals: "billing" }, { label: "support", equals: "support" }]) => ({ id: "route", type: "switch", config: { value: "{{steps.sort.output.label}}", cases } });
const issues = (def: unknown) => {
  const r = definitionSchema.safeParse(def);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("switch step", () => {
  const def = {
    trigger: manual,
    steps: [sw(), mail("a"), mail("b"), mail("c")],
    edges: [
      { from: "route", to: "a", on: "billing" },
      { from: "route", to: "b", on: "support" },
      { from: "route", to: "c", on: "default" },
    ],
  };

  it("accepts case labels and default as edge labels", () => {
    expect(issues(def)).toEqual([]);
    expect(stepBranches(definitionSchema.parse(def).steps[0]!)).toEqual(["billing", "support", "default"]);
  });

  it("refuses an edge that is not a case label, and one with no label", () => {
    expect(issues({ ...def, edges: [{ from: "route", to: "a", on: "nope" }] }).join()).toMatch(/not a branch of switch/);
    expect(issues({ ...def, edges: [{ from: "route", to: "a" }] }).join()).toMatch(/needs a branch label/);
  });

  it("refuses more than 10 cases, none, duplicates, the reserved default and bad labels", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ label: `c${i}`, equals: i }));
    expect(issues({ trigger: manual, steps: [sw(many)], edges: [] }).length).toBeGreaterThan(0);
    expect(issues({ trigger: manual, steps: [sw(many.slice(0, 10))], edges: [] })).toEqual([]);
    expect(issues({ trigger: manual, steps: [sw([])], edges: [] }).length).toBeGreaterThan(0);
    expect(issues({ trigger: manual, steps: [sw([{ label: "x", equals: 1 }, { label: "x", equals: 2 }])], edges: [] }).join()).toMatch(/duplicate branch label/);
    expect(issues({ trigger: manual, steps: [sw([{ label: "default", equals: 1 }])], edges: [] }).join()).toMatch(/reserved/);
    expect(issues({ trigger: manual, steps: [sw([{ label: "Bad Label", equals: 1 }])], edges: [] }).length).toBeGreaterThan(0);
  });

  it("cannot be turned off, since a skipped step has no branch", () => {
    expect(issues({ trigger: manual, steps: [{ ...sw(), disabled: true }], edges: [] }).join()).toMatch(/cannot be turned off/);
  });

  it("walks to the matching step with nextStep", () => {
    const parsed = definitionSchema.parse(def);
    expect(nextStep(parsed, "route", "support")?.id).toBe("b");
    expect(nextStep(parsed, "route", "default")?.id).toBe("c");
    expect(() => nextStep(parsed, "route")).toThrow(/needs a branch/);
  });
});

describe("switchBranch", () => {
  const ctx = { trigger: { n: "5", kind: "Gold", ok: true }, steps: {} };
  const config = { value: "{{trigger.kind}}", cases: [{ label: "gold", equals: "Gold" }, { label: "five", equals: 5 }, { label: "yes", equals: true }] };
  it("takes the first matching case, comparing numbers loosely, else default", () => {
    expect(switchBranch(config, ctx)).toBe("gold");
    expect(switchBranch({ ...config, value: "{{trigger.n}}" }, ctx)).toBe("five");
    expect(switchBranch({ ...config, value: "{{trigger.ok}}" }, ctx)).toBe("yes");
    expect(switchBranch({ ...config, value: "{{trigger.missing}}" }, ctx)).toBe("default");
    expect(switchBranch({ ...config, value: "silver" }, ctx)).toBe("default");
  });
});

describe("onError (T3)", () => {
  const base = (onError: unknown, edges: object[] = []) => ({ trigger: manual, steps: [mail("a", { onError }), mail("b"), mail("c")], edges });

  it("accepts stop, skip and failed_edge on an action step, and none", () => {
    for (const p of ["stop", "skip", "failed_edge"]) expect(issues(base(p, [{ from: "a", to: "b" }, { from: "b", to: "c" }]))).toEqual([]);
    expect(issues(base(undefined, [{ from: "a", to: "b" }, { from: "b", to: "c" }]))).toEqual([]);
    expect(issues(base("retry"))).not.toEqual([]);
  });

  it("allows a failed edge only with failed_edge", () => {
    const edges = [{ from: "a", to: "b" }, { from: "a", to: "c", on: "failed" }];
    expect(issues(base("failed_edge", edges))).toEqual([]);
    expect(issues(base("skip", edges)).join()).toMatch(/failed_edge/);
    expect(issues(base(undefined, edges)).join()).toMatch(/failed_edge/);
  });

  it("is refused on a step that does not reach outside kymavo", () => {
    const fmt = { id: "fmt", type: "transform", onError: "skip", config: { op: "uppercase", value: "x" } };
    expect(issues({ trigger: manual, steps: [fmt], edges: [] }).join()).toMatch(/only a step that reaches outside kymavo/);
    expect(issues({ trigger: manual, steps: [{ ...fmt, onError: undefined }], edges: [] })).toEqual([]);
    expect(OUTSIDE_STEPS.has("email") && !OUTSIDE_STEPS.has("transform")).toBe(true);
  });

  it("warns when failed_edge has no failed edge drawn, and not once it has one", () => {
    const lone = definitionSchema.parse(base("failed_edge", [{ from: "a", to: "b" }, { from: "b", to: "c" }]));
    expect(lintFindings(lone).map((f) => f.rule)).toEqual(["failed_path_no_edge"]);
    const wired = definitionSchema.parse(base("failed_edge", [{ from: "a", to: "b" }, { from: "a", to: "c", on: "failed" }]));
    expect(lintFindings(wired)).toEqual([]);
    expect(lintFindings(definitionSchema.parse(base("skip", [{ from: "a", to: "b" }, { from: "b", to: "c" }])))).toEqual([]);
  });

  it("is refused on a branching step", () => {
    const cond = { id: "k", type: "condition", onError: "skip", config: { condition: { left: "1", op: "eq", right: "1" } } };
    expect(issues({ trigger: manual, steps: [cond], edges: [] }).length).toBeGreaterThan(0);
    expect(issues({ trigger: manual, steps: [{ ...sw(), onError: "skip" }], edges: [] }).length).toBeGreaterThan(0);
  });
});

describe("transform step config", () => {
  const t = (config: object) => ({ trigger: manual, steps: [{ id: "fmt", type: "transform", config }], edges: [] });
  it("accepts each operation with its own settings", () => {
    expect(issues(t({ op: "format_date", value: "{{trigger.at}}", timezone: "Asia/Manila", format: "readable" }))).toEqual([]);
    expect(issues(t({ op: "format_peso", value: "{{trigger.amount}}" }))).toEqual([]);
    expect(issues(t({ op: "normalize_phone", value: "{{trigger.phone}}" }))).toEqual([]);
    expect(issues(t({ op: "split", value: "{{trigger.tags}}", separator: "," }))).toEqual([]);
    expect(issues(t({ op: "pick", fields: { who: "{{trigger.name}}" } }))).toEqual([]);
  });
  it("refuses settings that belong to another operation, and a missing value", () => {
    expect(issues(t({ op: "trim" })).join()).toMatch(/needs a value/);
    expect(issues(t({ op: "trim", value: "x", timezone: "Asia/Manila" })).join()).toMatch(/only for format_date/);
    expect(issues(t({ op: "format_date", value: "x", timezone: "Mars/Base" })).join()).toMatch(/IANA/);
    expect(issues(t({ op: "pick" })).join()).toMatch(/at least one field/);
    expect(issues(t({ op: "pick", fields: { a: "x" }, value: "x" })).length).toBe(0);
    expect(issues(t({ op: "eval", value: "1+1" })).length).toBeGreaterThan(0);
  });
});

describe("sheets rows (N30)", () => {
  const s = (config: object) => ({ trigger: manual, steps: [{ id: "log", type: "sheets", config }], edges: [] });
  it("keeps the old columns-only shape valid", () => {
    expect(issues(s({ columns: ["a", "b"] }))).toEqual([]);
    expect(issues(s({}))).not.toEqual([]);
  });
  it("accepts a list template or up to 100 rows by 20 columns, with a header", () => {
    expect(issues(s({ rows: "{{trigger.items}}", columns: ["{{item.name}}", "{{item.qty}}"], header: ["Name", "Qty"] }))).toEqual([]);
    expect(issues(s({ rows: Array.from({ length: 100 }, () => Array(20).fill("x")) }))).toEqual([]);
    expect(issues(s({ rows: Array.from({ length: 101 }, () => ["x"]) })).length).toBeGreaterThan(0);
    expect(issues(s({ rows: [Array(21).fill("x")] })).length).toBeGreaterThan(0);
    expect(issues(s({ rows: [["x"]], header: Array(21).fill("h") })).length).toBeGreaterThan(0);
  });
  it("refuses columns together with a 2D rows array", () => {
    expect(issues(s({ rows: [["x"]], columns: ["y"] })).join()).toMatch(/not both/);
  });
});

describe("lint for switch", () => {
  const classify = { id: "sort", type: "ai", config: { task: "classify", input: "{{trigger.note}}", labels: { billing: "b", support: "s", other: "o" } } };
  it("warns for a classify label that lands on a switch case with no edge", () => {
    const def = definitionSchema.parse({
      trigger: manual,
      steps: [classify, sw([{ label: "billing", equals: "billing" }, { label: "support", equals: "support" }]), mail("a"), mail("b")],
      edges: [
        { from: "sort", to: "route" },
        { from: "route", to: "a", on: "billing" },
        { from: "route", to: "b", on: "support" },
      ],
    });
    const w = lintDefinition(def);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/label "other".*switch "route".*"default"/);
  });
  it("is quiet when default has an edge", () => {
    const def = definitionSchema.parse({
      trigger: manual,
      steps: [classify, sw(), mail("a"), mail("b"), mail("c")],
      edges: [
        { from: "sort", to: "route" },
        { from: "route", to: "a", on: "billing" },
        { from: "route", to: "b", on: "support" },
        { from: "route", to: "c", on: "default" },
      ],
    });
    expect(lintDefinition(def)).toEqual([]);
  });
});
