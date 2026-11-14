import { condition, edge, email, REJECTED, type Scenario } from "./types";

// QA-01 Sales Lead Prioritization, v2 shape: summary, an explicit 30,000 gate, then a classifier for the rest.
// The form refuses a negative, missing or malformed budget before any run starts.
const toStandard = ["summarize", "gate", "classify", "route", "standard"];
const lead = { name: "Lea", email: "lea@example.com" };

export const qa01: Scenario = {
  id: "QA-01",
  name: "Sales lead prioritization",
  definition: {
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "name", label: "Name", type: "text", required: true },
          { name: "email", label: "Email", type: "email", required: true },
          { name: "budget", label: "Budget (PHP)", type: "number", required: true, min: 0 },
          { name: "details", label: "Project details", type: "textarea", required: true },
        ],
      },
    },
    steps: [
      { id: "summarize", type: "ai", config: { task: "summarize", input: "{{trigger.details}}" } },
      condition("gate", "{{trigger.budget}}", "gte", 30_000),
      email("urgent", "sales@example.com", "Urgent lead"),
      { id: "classify", type: "ai", config: { task: "classify", input: "{{trigger.details}}", labels: { standard: "a normal lead", manual_review: "unclear, suspicious or malformed" } } },
      condition("route", "{{steps.classify.output.label}}", "eq", "manual_review"),
      email("standard", "sales@example.com", "New lead"),
      email("review", "sales@example.com", "Lead needs review"),
    ],
    edges: [edge("summarize", "gate"), edge("gate", "urgent", "true"), edge("gate", "classify", "false"), edge("classify", "route"), edge("route", "review", "true"), edge("route", "standard", "false")],
  },
  cases: [
    { name: "a 45,000 project goes urgent", payload: { ...lead, budget: 45_000, details: "Website for a clinic" }, want: ["summarize", "gate", "urgent"] },
    { name: "a 200 project goes standard", payload: { ...lead, budget: 200, details: "Fix a typo" }, want: toStandard },
    { name: "exactly 30,000 is urgent (gte boundary)", payload: { ...lead, budget: 30_000, details: "Boundary" }, want: ["summarize", "gate", "urgent"] },
    { name: "29,999.99 is standard", payload: { ...lead, budget: 29_999.99, details: "Just under" }, want: toStandard },
    { name: "a budget sent as the text 30000 compares as a number", payload: { ...lead, budget: "30000", details: "Text number" }, want: ["summarize", "gate", "urgent"] },
    {
      name: "the tester picks manual_review and the lead reaches review",
      payload: { ...lead, budget: 200, details: "Odd request" },
      options: { choices: { classify: { label: "manual_review" } } },
      want: ["summarize", "gate", "classify", "route", "review"],
      gap: { phase: "P3", today: toStandard, why: "test runs ignore chosen labels and always take the first label" },
    },
    {
      name: "a negative budget is refused at the boundary",
      payload: { ...lead, budget: -5_000, details: "Adversarial negative budget" },
      want: REJECTED,
      rejects: ["budget: must be at least 0"],
    },
    {
      name: "a missing budget is refused at the boundary",
      payload: { ...lead, details: "No budget given" },
      want: REJECTED,
      rejects: ["budget: is required"],
    },
    {
      name: "a malformed budget '45,000' is refused at the boundary",
      payload: { ...lead, budget: "45,000", details: "Comma number" },
      want: REJECTED,
      rejects: ["budget: must be a number"],
    },
  ],
};

/**
 * The same gate behind a manual trigger, which has no fields to check, so bad data reaches the condition.
 * A comparison on a value that is missing or not a number takes the `invalid` branch to manual review.
 */
export const qa01Unchecked: Scenario = {
  id: "QA-01",
  name: "Sales lead gate without field checks",
  definition: {
    trigger: { type: "manual", config: {} },
    steps: [condition("gate", "{{trigger.budget}}", "gte", 30_000), email("urgent", "sales@example.com", "Urgent lead"), email("standard", "sales@example.com", "New lead"), email("review", "sales@example.com", "Lead needs review")],
    edges: [edge("gate", "urgent", "true"), edge("gate", "standard", "false"), edge("gate", "review", "invalid")],
  },
  cases: [
    { name: "45,000 goes urgent", payload: { budget: 45_000 }, want: ["gate", "urgent"] },
    { name: "200 goes standard", payload: { budget: 200 }, want: ["gate", "standard"] },
    { name: "'45,000' goes to manual review", payload: { budget: "45,000" }, want: ["gate", "review"] },
    { name: "a missing budget goes to manual review", payload: {}, want: ["gate", "review"] },
  ],
};

/** The gate with no `invalid` edge: bad data fails the run instead of quietly going standard. */
export const qa01NoInvalidEdge = {
  trigger: { type: "manual", config: {} },
  steps: [condition("gate", "{{trigger.budget}}", "gte", 30_000), email("urgent", "sales@example.com", "Urgent lead"), email("standard", "sales@example.com", "New lead")],
  edges: [edge("gate", "urgent", "true"), edge("gate", "standard", "false")],
};
