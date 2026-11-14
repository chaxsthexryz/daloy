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
    // The field limits refuse these before the workflow's own guards see them (P2).
    { name: "80% is refused at the boundary", payload: { title: "Too generous", discount: 80 }, want: REJECTED, rejects: ["discount: must be at most 50"] },
    { name: "-5% is refused at the boundary", payload: { title: "Negative", discount: -5 }, want: REJECTED, rejects: ["discount: must be at least 0"] },
    { name: "exactly 50% is allowed (lte boundary)", payload: { title: "Half off", discount: 50 }, want: approved },
    { name: "exactly 0% is allowed (gte boundary)", payload: { title: "No discount", discount: 0 }, want: approved },
    { name: "50.01% is refused at the boundary", payload: { title: "Just over", discount: 50.01 }, want: REJECTED, rejects: ["discount: must be at most 50"] },
    {
      name: "the tester picks rejected and the rejection notice goes",
      payload: { title: "Rainy day", discount: 20 },
      options: { choices: { ask: { decision: "rejected" } } },
      want: ["guard_low", "guard_high", "ask", "rejected_notice"],
    },
    {
      name: "the tester picks timeout and the timeout notice goes",
      payload: { title: "Rainy day", discount: 20 },
      options: { choices: { ask: { decision: "timeout" } } },
      want: ["guard_low", "guard_high", "ask", "timeout_notice"],
    },
    {
      name: "a missing discount is refused at the boundary",
      payload: { title: "No discount given" },
      want: REJECTED,
      rejects: ["discount: is required"],
    },
  ],
};
