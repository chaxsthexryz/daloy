import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { lintDefinition, lintFindings } from "./lint";
import { defaultAnswers, officeRequestDefinition } from "./office-request";
import { defaultPurchaseAnswers, purchaseRequestDefinition } from "./purchase-request";
import { TEMPLATES } from "./templates";
import { websiteInquiryDefinition } from "./website-inquiry";

const lint = (def: unknown) => lintDefinition(definitionSchema.parse(def));

const mail = (id: string) => ({ id, type: "email", config: { to: "a@example.com", subject: "s", text: "t" } });
const gate = (id: string, left: string, op: string, right?: unknown) => ({ id, type: "condition", config: { condition: { left, op, right } } });
const budgetForm = (extra: Record<string, unknown> = {}) => ({
  type: "form",
  config: { fields: [{ name: "budget", label: "Budget", type: "number", required: true, ...extra }] },
});

describe("approval branches", () => {
  const approval = { id: "ask", type: "approval", config: { approver: "boss@example.com", subject: "s", message: "m", timeoutSeconds: 3600 } };
  const steps = [approval, mail("yes"), mail("no"), mail("late")];
  const trigger = { type: "manual", config: {} };

  it("passes when approved, rejected and timeout all lead somewhere", () => {
    const edges = [
      { from: "ask", to: "yes", on: "approved" },
      { from: "ask", to: "no", on: "rejected" },
      { from: "ask", to: "late", on: "timeout" },
    ];
    expect(lint({ trigger, steps, edges })).toEqual([]);
  });

  it("warns once per missing rejected or timeout branch", () => {
    const warnings = lint({ trigger, steps: [approval, mail("yes")], edges: [{ from: "ask", to: "yes", on: "approved" }] });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/"ask".*"rejected"/);
    expect(warnings[1]).toMatch(/"ask".*"timeout"/);
  });
});

describe("classify labels", () => {
  const classify = { id: "sort", type: "ai", config: { task: "classify", input: "{{trigger.note}}", labels: { urgent: "u", standard: "s", other: "o" } } };
  const trigger = { type: "manual", config: {} };
  const isUrgent = gate("is_urgent", "{{steps.sort.output.label}}", "eq", "urgent");

  it("passes when every label reaches a step through true and false", () => {
    const edges = [
      { from: "sort", to: "is_urgent" },
      { from: "is_urgent", to: "page", on: "true" },
      { from: "is_urgent", to: "queue", on: "false" },
    ];
    expect(lint({ trigger, steps: [classify, isUrgent, mail("page"), mail("queue")], edges })).toEqual([]);
  });

  it("warns for each label that lands on a branch with no edge", () => {
    const edges = [
      { from: "sort", to: "is_urgent" },
      { from: "is_urgent", to: "page", on: "true" },
    ];
    const warnings = lint({ trigger, steps: [classify, isUrgent, mail("page")], edges });
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toMatch(/label "standard".*"is_urgent".*"false"/);
    expect(warnings.join("\n")).toMatch(/label "other"/);
    expect(warnings.join("\n")).not.toMatch(/label "urgent"/);
  });

  it("reads the label on either side of the comparison", () => {
    const reversed = gate("is_urgent", "urgent", "eq", "{{steps.sort.output.label}}");
    const edges = [
      { from: "sort", to: "is_urgent" },
      { from: "is_urgent", to: "page", on: "true" },
    ];
    const warnings = lint({ trigger, steps: [classify, reversed, mail("page")], edges });
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toMatch(/label "standard".*"false"/);
  });

  it("makes no claim when the other side comes from the run, since the branch is not known", () => {
    const byInput = gate("is_urgent", "{{steps.sort.output.label}}", "eq", "{{trigger.priority}}");
    const edges = [
      { from: "sort", to: "is_urgent" },
      { from: "is_urgent", to: "page", on: "true" },
    ];
    expect(lint({ trigger, steps: [classify, byInput, mail("page")], edges })).toEqual([]);
  });

  it("follows a chain of conditions on the label", () => {
    const isStandard = gate("is_standard", "{{steps.sort.output.label}}", "eq", "standard");
    const edges = [
      { from: "sort", to: "is_urgent" },
      { from: "is_urgent", to: "page", on: "true" },
      { from: "is_urgent", to: "is_standard", on: "false" },
      { from: "is_standard", to: "queue", on: "true" },
    ];
    const warnings = lint({ trigger, steps: [classify, isUrgent, isStandard, mail("page"), mail("queue")], edges });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/label "other".*"is_standard".*"false"/);
  });

  it("leaves a classify step alone when a plain step follows or nothing does", () => {
    expect(lint({ trigger, steps: [classify, mail("send")], edges: [{ from: "sort", to: "send" }] })).toEqual([]);
    expect(lint({ trigger, steps: [classify], edges: [] })).toEqual([]);
  });
});

describe("dry-run switches", () => {
  it("warns about a trigger field and a condition that read as a test switch", () => {
    const def = {
      trigger: { type: "form", config: { fields: [{ name: "dry_run", label: "Dry run", type: "text" }] } },
      steps: [gate("is_dry", "{{trigger.dry_run}}", "eq", "true"), mail("real"), mail("fake")],
      edges: [
        { from: "is_dry", to: "fake", on: "true" },
        { from: "is_dry", to: "real", on: "false" },
      ],
    };
    const warnings = lint(def);
    expect(warnings).toHaveLength(1);
    // Mock test runs send nothing, but a Live run or a real event follows the branch and can send.
    expect(warnings[0]).toMatch(/"dry_run".*Mock.*Live/);
  });

  it("catches a test_mode condition on a webhook without fields, and ignores ordinary names", () => {
    const flagged = lint({
      trigger: { type: "webhook", config: {} },
      steps: [gate("is_test", "{{trigger.test_mode}}", "eq", true), mail("a"), mail("b")],
      edges: [
        { from: "is_test", to: "a", on: "true" },
        { from: "is_test", to: "b", on: "false" },
      ],
    });
    expect(flagged.join("\n")).toMatch(/"test_mode"/);
    const fine = lint({
      trigger: { type: "form", config: { fields: [{ name: "contest_entry", label: "Entry", type: "text" }, { name: "latest", label: "Latest", type: "text" }] } },
      steps: [gate("has_entry", "{{trigger.contest_entry}}", "exists"), mail("a")],
      edges: [{ from: "has_entry", to: "a", on: "true" }],
    });
    expect(fine).toEqual([]);
  });
});

describe("numeric comparisons", () => {
  const edges = (invalid: boolean) => [
    { from: "big", to: "a", on: "true" },
    { from: "big", to: "b", on: "false" },
    ...(invalid ? [{ from: "big", to: "c", on: "invalid" }] : []),
  ];
  const steps = [gate("big", "{{trigger.budget}}", "gte", 30000), mail("a"), mail("b"), mail("c")];

  it("warns when a gate on text or a webhook value has no invalid edge", () => {
    const warnings = lint({ trigger: { type: "webhook", config: {} }, steps: steps.slice(0, 3), edges: edges(false) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"big".*"invalid"/);
  });

  it("passes with an invalid edge", () => {
    expect(lint({ trigger: { type: "webhook", config: {} }, steps, edges: edges(true) })).toEqual([]);
  });

  it("passes without one when the value is a required number field, which every entry point checks", () => {
    expect(lint({ trigger: budgetForm(), steps: steps.slice(0, 3), edges: edges(false) })).toEqual([]);
  });

  it("reads a threshold the way the engine does, so 1e3 counts as a number", () => {
    const exp = [gate("big", "{{trigger.budget}}", "gte", "1e3"), mail("a"), mail("b")];
    expect(lint({ trigger: budgetForm(), steps: exp, edges: edges(false) })).toEqual([]);
    const text = [gate("big", "{{trigger.budget}}", "gte", "abc"), mail("a"), mail("b")];
    expect(lint({ trigger: budgetForm(), steps: text, edges: edges(false) })).toHaveLength(1);
  });

  it("still warns for an optional number field, which can be missing", () => {
    const optional = { type: "form", config: { fields: [{ name: "budget", label: "Budget", type: "number", required: false }] } };
    expect(lint({ trigger: optional, steps: steps.slice(0, 3), edges: edges(false) })).toHaveLength(1);
  });
});

describe("steps that can never run", () => {
  it("warns about an invalid edge that cannot be taken, and about the step behind it", () => {
    const def = {
      trigger: budgetForm(),
      steps: [gate("big", "{{trigger.budget}}", "gte", 30000), mail("a"), mail("b"), mail("manual_check")],
      edges: [
        { from: "big", to: "a", on: "true" },
        { from: "big", to: "b", on: "false" },
        { from: "big", to: "manual_check", on: "invalid" },
      ],
    };
    const warnings = lint(def);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"manual_check".*never/);
  });

  it("flags an invalid edge on an equality check", () => {
    const def = {
      trigger: { type: "manual", config: {} },
      steps: [gate("same", "{{trigger.kind}}", "eq", "x"), mail("a"), mail("b"), mail("c")],
      edges: [
        { from: "same", to: "a", on: "true" },
        { from: "same", to: "b", on: "false" },
        { from: "same", to: "c", on: "invalid" },
      ],
    };
    expect(lint(def).join("\n")).toMatch(/"c".*never/);
  });

  it("keeps an invalid-only target that a possible branch also reaches", () => {
    const def = {
      trigger: budgetForm(),
      steps: [gate("big", "{{trigger.budget}}", "gte", 30000), mail("a"), mail("shared")],
      edges: [
        { from: "big", to: "a", on: "true" },
        { from: "big", to: "shared", on: "false" },
        { from: "big", to: "shared", on: "invalid" },
        { from: "a", to: "shared" },
      ],
    };
    expect(lint(def)).toEqual([]);
  });
});

describe("shipped definitions", () => {
  it("every template and guided setup lints clean", () => {
    for (const t of TEMPLATES) expect(lint(t.definition), t.name).toEqual([]);
    expect(lint(officeRequestDefinition(defaultAnswers("owner@example.com")))).toEqual([]);
    expect(lint(purchaseRequestDefinition({ ...defaultPurchaseAnswers("owner@example.com"), approver: "boss@example.com" }))).toEqual([]);
    expect(lint(websiteInquiryDefinition({ businessName: "Acme", inquiryEmail: "owner@example.com" }))).toEqual([]);
  });
});

describe("rule ids", () => {
  const rules = (def: unknown) => lintFindings(definitionSchema.parse(def)).map((f) => f.rule);
  const manual = { type: "manual", config: {} };

  it("names the rule of each finding, with the same messages as lintDefinition", () => {
    const approval = { id: "ask", type: "approval", config: { approver: "boss@example.com", subject: "s", message: "m", timeoutSeconds: 3600 } };
    const approvalDef = { trigger: manual, steps: [approval, mail("yes")], edges: [{ from: "ask", to: "yes", on: "approved" }] };
    expect(rules(approvalDef)).toEqual(["approval_no_edge", "approval_no_edge"]);
    expect(lintFindings(definitionSchema.parse(approvalDef)).map((f) => f.message)).toEqual(lint(approvalDef));

    const classify = { id: "sort", type: "ai", config: { task: "classify", input: "{{trigger.note}}", labels: { urgent: "u", other: "o" } } };
    const isUrgent = gate("is_urgent", "{{steps.sort.output.label}}", "eq", "urgent");
    const edges = [
      { from: "sort", to: "is_urgent" },
      { from: "is_urgent", to: "page", on: "true" },
    ];
    expect(rules({ trigger: manual, steps: [classify, isUrgent, mail("page")], edges })).toEqual(["classify_dead_end"]);

    expect(
      rules({
        trigger: { type: "form", config: { fields: [{ name: "dry_run", label: "Dry run", type: "text" }] } },
        steps: [gate("is_dry", "{{trigger.dry_run}}", "eq", "true"), mail("real"), mail("fake")],
        edges: [
          { from: "is_dry", to: "fake", on: "true" },
          { from: "is_dry", to: "real", on: "false" },
        ],
      }),
    ).toEqual(["test_switch"]);

    const big = [
      { from: "big", to: "a", on: "true" },
      { from: "big", to: "b", on: "false" },
    ];
    expect(rules({ trigger: { type: "webhook", config: {} }, steps: [gate("big", "{{trigger.budget}}", "gte", 30000), mail("a"), mail("b")], edges: big })).toEqual(["number_no_invalid"]);

    expect(
      rules({ trigger: budgetForm(), steps: [gate("big", "{{trigger.budget}}", "gte", 30000), mail("a"), mail("b"), mail("manual_check")], edges: [...big, { from: "big", to: "manual_check", on: "invalid" }] }),
    ).toEqual(["unreachable_step"]);
  });
});

describe("ai step and file fields", () => {
  const trigger = { type: "form", config: { fields: [{ name: "schedule", label: "Schedule photo", type: "file", required: true }] } };
  const read = (config: Record<string, unknown> = {}) => ({ id: "read", type: "ai", config: { task: "extract", input: "{{trigger.schedule}}", fields: { subject: "Subject" }, ...config } });

  it("warns when the form has a file field and the ai step reads no file", () => {
    expect(lint({ trigger, steps: [read()], edges: [] })).toEqual(['AI step "read" reads no file, but the form has a file field. Tick it under "Let the AI read these files" on that step.']);
  });

  it("is quiet when the ai step reads the file, or the form has no file field", () => {
    expect(lint({ trigger, steps: [read({ files: ["schedule"] })], edges: [] })).toEqual([]);
    expect(lint({ trigger: { type: "manual", config: {} }, steps: [read()], edges: [] })).toEqual([]);
  });
});
