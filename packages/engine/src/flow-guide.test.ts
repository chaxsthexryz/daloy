import { describe, expect, it } from "vitest";
import { definitionSchema, type WorkflowDefinition } from "./definition";
import { configProblems, explainFlow, paymentMode, preflightProblems, stepLines, withoutRecipient } from "./flow-guide";

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
  it("adds the owner's note after its step, quoted and not translated (T4)", () => {
    const noted = { ...receipt, steps: receipt.steps.map((s) => (s.id === "mail" ? { ...s, note: "Only for paid orders" } : s)) };
    expect(explainFlow(noted, "en")[2]).toMatch(/Customer email from the form.* Your note: "Only for paid orders"$/);
    expect(explainFlow(noted, "tl")[2]).toMatch(/ Tala mo: "Only for paid orders"$/);
    expect(explainFlow(receipt, "en")[2]).not.toContain("note");
  });
  it("says what happens when a step fails, and says nothing when it stops the run as before (T3)", () => {
    const flow = (onError?: string) =>
      parse({
        trigger: { type: "manual", config: {} },
        steps: [{ id: "mail", type: "email", onError, config: { to: "a@example.com", subject: "s", text: "t" } }, { id: "tell", type: "slack", config: { text: "x" } }],
        edges: [{ from: "mail", to: "tell", ...(onError === "failed_edge" ? { on: "failed" } : {}) }],
      });
    expect(explainFlow(flow("skip"), "en")[1]).toMatch(/ If it fails, the automation skips it and carries on\.$/);
    expect(explainFlow(flow("skip"), "tl")[1]).toMatch(/ Kapag pumalya ito, lalaktawan ito at magpapatuloy ang automation\.$/);
    const path = explainFlow(flow("failed_edge"), "en");
    expect(path[1]).toMatch(/ If it fails, the automation takes the failed path\.$/);
    expect(path[2]).toMatch(/^2\. If the step before fails: Slack/);
    expect(explainFlow(flow(), "en")[1]).not.toMatch(/fails/);
  });
  it("uses the destination the owner picked in Apps", () => {
    const lines = stepLines(receipt, "en", { slack: "#orders" });
    expect(lines.find((l) => l.id === "slack")!.where).toContain("#orders");
  });
  it("explains a stay_quote step with its room and note", () => {
    const quoted = parse({
      trigger: { type: "manual", config: {} },
      steps: [{ id: "quote", note: "Ask staff before discounting", type: "stay_quote", config: { room: "Garden room", checkIn: "2026-12-14", nights: "2", guests: "2" } }],
      edges: [],
    });
    expect(explainFlow(quoted, "en")[1]).toBe('1. Quote a stay. Room: Garden room Your note: "Ask staff before discounting"');
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

describe("preflightProblems", () => {
  const bookingWithResource = parse({
    trigger: { type: "form", config: { fields: [{ name: "resource", label: "Room", type: "resource", required: true }, { name: "at", label: "Time", type: "datetime", timezone: "Asia/Manila", required: true }] } },
    steps: [
      { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.resource}}", start: "{{trigger.at}}", minutes: 60 } },
      { id: "tell", type: "sms", config: { to: "+639171234567", message: "Booked" } },
    ],
    edges: [{ from: "book", to: "tell", on: "done" }],
  });
  const concierge = parse({
    trigger: { type: "meta_dm", config: { channel: "both", requireImage: false } },
    steps: [{ id: "ans", type: "ai", config: { task: "answer", input: "{{trigger.text}}" } }],
    edges: [],
  });

  it("reports missing resources, server SMS unavailable, Preview plan SMS 0, exhausted SMS quota, and unpublished knowledge", () => {
    const probs = preflightProblems(bookingWithResource, { resourceCount: 0, smsConfigured: false, smsLimit: 0, smsUsed: 0 }, "en");
    expect(probs.map((p) => p.kind)).toEqual(["missing_resource", "sms_unavailable", "sms_plan"]);
    expect(probs.find((p) => p.kind === "sms_unavailable")?.blocksPublish).toBe(true);
    expect(probs.find((p) => p.kind === "sms_plan")?.blocksPublish).toBe(true);

    const quota = preflightProblems(bookingWithResource, { resourceCount: 1, smsConfigured: true, smsLimit: 50, smsUsed: 50 }, "en");
    expect(quota.map((p) => p.kind)).toEqual(["sms_quota"]);

    const unlimited = preflightProblems(bookingWithResource, { resourceCount: 1, smsConfigured: true, smsLimit: null, smsUsed: 0 }, "en");
    expect(unlimited).toEqual([]);

    const noKnowledge = preflightProblems(concierge, { knowledgePublished: false }, "en");
    expect(noKnowledge.map((p) => p.kind)).toEqual(["knowledge"]);
    expect(preflightProblems(concierge, { knowledgePublished: true }, "en")).toEqual([]);
  });
});
