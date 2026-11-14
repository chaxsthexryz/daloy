import { approval, condition, edge, email, REJECTED, type Scenario } from "./types";

// QA-04 E-commerce Refund Management, v2 shape: order ID and amount guards, refunds over 1,000 need a manager.
const toApproval = ["check_id", "check_amount", "big", "ask"];

export const qa04: Scenario = {
  id: "QA-04",
  name: "Refund management",
  definition: {
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "order_id", label: "Order ID", type: "text", required: true },
          { name: "amount", label: "Refund amount (PHP)", type: "number", required: true, min: 0.01 },
          { name: "reason", label: "Reason", type: "textarea" },
        ],
      },
    },
    steps: [
      condition("check_id", "{{trigger.order_id}}", "exists"),
      condition("check_amount", "{{trigger.amount}}", "gt", 0),
      condition("big", "{{trigger.amount}}", "gt", 1_000),
      approval("ask", "Approve this refund?"),
      email("approve_notice", "support@example.com", "Refund approved"),
      email("reject_notice", "support@example.com", "Refund rejected"),
      email("timeout_notice", "support@example.com", "Refund not answered"),
      email("routine", "support@example.com", "Routine refund"),
      email("invalid", "support@example.com", "Invalid refund request"),
    ],
    edges: [
      edge("check_id", "check_amount", "true"),
      edge("check_id", "invalid", "false"),
      edge("check_amount", "big", "true"),
      edge("check_amount", "invalid", "false"),
      edge("big", "ask", "true"),
      edge("big", "routine", "false"),
      edge("ask", "approve_notice", "approved"),
      edge("ask", "reject_notice", "rejected"),
      edge("ask", "timeout_notice", "timeout"),
    ],
  },
  cases: [
    { name: "2,100 needs approval and is approved", payload: { order_id: "ORD-1", amount: 2_100 }, want: [...toApproval, "approve_notice"] },
    { name: "500 is routine", payload: { order_id: "ORD-2", amount: 500 }, want: ["check_id", "check_amount", "big", "routine"] },
    { name: "exactly 1,000 is routine (gt boundary)", payload: { order_id: "ORD-3", amount: 1_000 }, want: ["check_id", "check_amount", "big", "routine"] },
    { name: "1,000.01 needs approval", payload: { order_id: "ORD-4", amount: 1_000.01 }, want: [...toApproval, "approve_notice"] },
    {
      name: "an empty order ID alone is refused at the boundary",
      payload: { order_id: "", amount: 500 },
      want: REJECTED,
      rejects: ["order_id: is required"],
    },
    {
      name: "a negative amount alone is refused at the boundary",
      payload: { order_id: "ORD-5", amount: -10 },
      want: REJECTED,
      rejects: ["amount: must be at least 0.01"],
    },
    {
      name: "an empty order ID with a negative amount is refused at the boundary",
      payload: { order_id: "", amount: -10 },
      want: REJECTED,
      rejects: ["order_id: is required", "amount: must be at least 0.01"],
    },
    {
      name: "the tester picks rejected and the rejection notice goes",
      payload: { order_id: "ORD-6", amount: 2_100 },
      options: { choices: { ask: { decision: "rejected" } } },
      want: [...toApproval, "reject_notice"],
    },
    {
      name: "the tester picks timeout and the timeout notice goes",
      payload: { order_id: "ORD-7", amount: 2_100 },
      options: { choices: { ask: { decision: "timeout" } } },
      want: [...toApproval, "timeout_notice"],
    },
  ],
};
