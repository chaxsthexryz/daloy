import { approval, condition, edge, email, REJECTED, sheets, type Scenario } from "./types";

// QA-08 Complex Workflow Failure Recovery, v2 shape: approval, then HTTP, Sheets and a notification.
const full = ["check", "ask", "post", "log", "notify"];

export const qa08: Scenario = {
  id: "QA-08",
  name: "Failure recovery",
  definition: {
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "item", label: "Item", type: "text", required: true },
          { name: "amount", label: "Amount (PHP)", type: "number", required: true, min: 0.01 },
        ],
      },
    },
    steps: [
      condition("check", "{{trigger.amount}}", "gt", 0),
      approval("ask", "Approve this order?"),
      { id: "post", type: "http", config: { method: "POST", url: "https://erp.example.com/orders", headers: { "Content-Type": "application/json" }, body: '{"item": "{{trigger.item}}", "amount": {{trigger.amount}}}' } },
      sheets("log", "{{trigger.item}}", "{{trigger.amount}}"),
      email("notify", "ops@example.com", "Order placed"),
      email("reject_notice", "ops@example.com", "Order rejected"),
      email("timeout_notice", "ops@example.com", "Order not answered"),
      email("invalid", "ops@example.com", "Invalid order"),
    ],
    edges: [
      edge("check", "ask", "true"),
      edge("check", "invalid", "false"),
      edge("ask", "post", "approved"),
      edge("post", "log"),
      edge("log", "notify"),
      edge("ask", "reject_notice", "rejected"),
      edge("ask", "timeout_notice", "timeout"),
    ],
  },
  cases: [
    { name: "8,000 goes through approval, HTTP, Sheets and the notification", payload: { item: "Printer", amount: 8_000 }, want: full },
    {
      name: "-1 is refused at the boundary",
      payload: { item: "Printer", amount: -1 },
      want: REJECTED,
      rejects: ["amount: must be at least 0.01"],
    },
    {
      name: "exactly 0 is refused at the boundary",
      payload: { item: "Printer", amount: 0 },
      want: REJECTED,
      rejects: ["amount: must be at least 0.01"],
    },
    {
      name: "the tester makes the sheet write fail and the run stops there",
      payload: { item: "Printer", amount: 8_000 },
      options: { choices: { log: { fail: "permanent" } } },
      want: ["check", "ask", "post", "log:failed"],
      gap: { phase: "P3", today: full, why: "mocked steps always succeed" },
    },
    {
      name: "the tester picks rejected and nothing is posted",
      payload: { item: "Printer", amount: 8_000 },
      options: { choices: { ask: { decision: "rejected" } } },
      want: ["check", "ask", "reject_notice"],
      gap: { phase: "P3", today: full, why: "mocked approvals always approve" },
    },
  ],
};

/** A live POST to the harness's local receiver, then an email, for retry and recovery checks. */
export const liveOrder = (url: string) => ({
  trigger: { type: "manual", config: {} },
  steps: [
    { id: "post", type: "http", config: { method: "POST", url, headers: { "Content-Type": "application/json" }, body: '{"order": "{{trigger.order}}"}' } },
    email("notify", "ops@example.com", "Order placed"),
  ],
  edges: [edge("post", "notify")],
});
