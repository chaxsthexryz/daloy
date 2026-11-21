import { describe, expect, it } from "vitest";
import { definitionSchema, type WorkflowDefinition } from "./definition";
import { configProblems, explainFlow, paymentMode, stepLines, withoutRecipient } from "./flow-guide";

const parse = (d: unknown): WorkflowDefinition => definitionSchema.parse(d);

const receipt = parse({
  trigger: { type: "form", config: { fields: [{ name: "email", label: "Customer email", type: "email", required: true }] } },
  steps: [
    { id: "ask", type: "approval", config: { approver: "ana@example.com", subject: "Check receipt", message: "Please check", timeoutSeconds: 3600 } },
    { id: "mail", type: "email", config: { to: "{{trigger.email}}", subject: "Paid", text: "Thank you" } },
    { id: "slack", type: "slack", config: { text: "Rejected" } },
  ],
  edges: [
    { from: "ask", to: "mail", on: "approved" },
    { from: "ask", to: "slack", on: "rejected" },
  ],
});

describe("explainFlow", () => {
  it("names the trigger, then each step in the order a run reaches it, with who gets it", () => {
    const lines = explainFlow(receipt, "en");
    expect(lines[0]).toMatch(/^Starts when: A form is submitted/);
    expect(lines[1]).toMatch(/^1\. Approval\. Ask: ana@example.com/);
    expect(lines[2]).toMatch(/^2\. After approved: Gmail, Send email\. To: Customer email from the form/);
    expect(lines[3]).toMatch(/^3\. After rejected: Slack, Post a message/);
  });
  it("is generated in Tagalog from the same draft", () => {
    const lines = explainFlow(receipt, "tl");
    expect(lines[0]).toContain("May nag-submit ng form");
    expect(lines[2]).toContain("Para kay: Customer email mula sa form");
  });
  it("lists a step that no edge reaches rather than dropping it", () => {
    // An editor draft need not parse yet: two unconnected steps are valid work in progress.
    const loose = { trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "slack", config: { text: "x" } }, { id: "b", type: "slack", config: { text: "y" } }], edges: [] } as WorkflowDefinition;
    expect(explainFlow(loose, "en")).toHaveLength(3);
  });
  it("uses the destination the owner picked in Apps", () => {
    const lines = stepLines(receipt, "en", { slack: "#orders" });
    expect(lines.find((l) => l.id === "slack")!.where).toContain("#orders");
  });
});

describe("configProblems", () => {
  it("passes a complete draft", () => {
    expect(configProblems(receipt, "en")).toEqual([]);
  });
  it("reports a missing recipient and a blank message, by step", () => {
    const bad = { ...receipt, steps: receipt.steps.map((s) => (s.id === "mail" ? { ...s, config: { ...s.config, to: "  ", text: "" } } : s)) } as WorkflowDefinition;
    const problems = configProblems(bad, "en");
    expect(problems.map((p) => p.stepId)).toEqual(["mail", "mail"]);
    expect(problems[0]!.message).toBe("Gmail, Send email has no recipient.");
    expect(problems[1]!.message).toBe("Gmail, Send email needs text.");
  });
  it("reports a form with no fields on the trigger", () => {
    const bad = { ...receipt, trigger: { type: "form", config: { fields: [] } } } as WorkflowDefinition;
    expect(configProblems(bad, "en")[0]).toMatchObject({ stepId: "trigger" });
  });
  it("reports in Tagalog", () => {
    const bad = { ...receipt, steps: receipt.steps.map((s) => (s.id === "mail" ? { ...s, config: { ...s.config, to: "" } } : s)) } as WorkflowDefinition;
    expect(configProblems(bad, "tl")[0]!.message).toBe("Walang tatanggap ang Gmail, Magpadala ng email.");
  });
});

describe("withoutRecipient", () => {
  it("blanks the first recipient so the failure example fails the same check", () => {
    const failing = withoutRecipient(receipt);
    expect(configProblems(failing, "en").map((p) => p.stepId)).toEqual(["mail"]);
    expect(configProblems(receipt, "en")).toEqual([]);
  });
  it("returns the draft unchanged when no step has a recipient", () => {
    const none = parse({ trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "slack", config: { text: "x" } }], edges: [] });
    expect(withoutRecipient(none)).toBe(none);
  });
});

describe("paymentMode", () => {
  const due = (config: object) => parse({ trigger: { type: "manual", config: {} }, steps: [{ id: "due", type: "payment_due", config: { reference: "D-1", amount: "350", ...config } }], edges: [] });
  it("is null when the flow asks for no payment", () => expect(paymentMode(receipt)).toBeNull());
  it("is manual for a QR Ph transfer", () => expect(paymentMode(due({}))).toBe("manual"));
  it("is checkout when PayMongo checkout is on", () => expect(paymentMode(due({ checkout: true }))).toBe("checkout"));
  it("is later for a balance due", () => expect(paymentMode(due({ kind: "balance" }))).toBe("later"));
});
