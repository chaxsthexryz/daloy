import { approval, condition, edge, email, REJECTED, type Scenario } from "./types";

// QA-03 Café Promotion Approval, v2 shape: two numeric guards, then a manager approval with its three outcomes.
const approved = ["guard_low", "guard_high", "ask", "announce"];

export const qa03: Scenario = {
  id: "QA-03",
  name: "Café promotion approval",
  definition: {
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "title", label: "Promotion", type: "text", required: true },
          { name: "discount", label: "Discount (%)", type: "number", required: true, min: 0, max: 50 },
        ],
      },
    },
    steps: [
      condition("guard_low", "{{trigger.discount}}", "gte", 0),
      condition("guard_high", "{{trigger.discount}}", "lte", 50),
      approval("ask", "Approve this promotion?"),
      email("announce", "customers@example.com", "New promotion"),
      email("rejected_notice", "marketing@example.com", "Promotion rejected"),
      email("timeout_notice", "marketing@example.com", "Promotion not answered"),
      email("invalid", "marketing@example.com", "Promotion discount is out of range"),
    ],
    edges: [
      edge("guard_low", "guard_high", "true"),
      edge("guard_low", "invalid", "false"),
      edge("guard_high", "ask", "true"),
      edge("guard_high", "invalid", "false"),
      edge("ask", "announce", "approved"),
      edge("ask", "rejected_notice", "rejected"),
      edge("ask", "timeout_notice", "timeout"),
    ],
  },
  cases: [
    { name: "20% reaches approval and the announcement", payload: { title: "Rainy day", discount: 20 }, want: approved },
    { name: "80% goes to the invalid handler", payload: { title: "Too generous", discount: 80 }, want: ["guard_low", "guard_high", "invalid"] },
    { name: "-5% goes to the invalid handler", payload: { title: "Negative", discount: -5 }, want: ["guard_low", "invalid"] },
    { name: "exactly 50% is allowed (lte boundary)", payload: { title: "Half off", discount: 50 }, want: approved },
    { name: "exactly 0% is allowed (gte boundary)", payload: { title: "No discount", discount: 0 }, want: approved },
    { name: "50.01% goes to the invalid handler", payload: { title: "Just over", discount: 50.01 }, want: ["guard_low", "guard_high", "invalid"] },
    {
      name: "the tester picks rejected and the rejection notice goes",
      payload: { title: "Rainy day", discount: 20 },
      options: { choices: { ask: { decision: "rejected" } } },
      want: ["guard_low", "guard_high", "ask", "rejected_notice"],
      gap: { phase: "P3", today: approved, why: "mocked approvals always approve" },
    },
    {
      name: "the tester picks timeout and the timeout notice goes",
      payload: { title: "Rainy day", discount: 20 },
      options: { choices: { ask: { decision: "timeout" } } },
      want: ["guard_low", "guard_high", "ask", "timeout_notice"],
      gap: { phase: "P3", today: approved, why: "mocked approvals always approve" },
    },
    {
      name: "a missing discount is refused at the boundary",
      payload: { title: "No discount given" },
      want: REJECTED,
      gap: { phase: "P2", today: ["guard_low", "invalid"], why: "test-run payloads skip required-field checks" },
    },
  ],
};
