import { approval, condition, edge, email, REJECTED, sheets, type Scenario } from "./types";

// QA-05 Office Purchase Requests, v2 shape: over 5,000 needs approval, every outcome is logged to the sheet.
const approved = ["gate", "ask", "order", "log"];
const routine = ["gate", "routine_log", "routine_notice"];

export const qa05: Scenario = {
  id: "QA-05",
  name: "Office purchase requests",
  definition: {
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "item", label: "Item", type: "text", required: true },
          { name: "department", label: "Department", type: "text", required: true },
          { name: "amount", label: "Amount (PHP)", type: "number", required: true, min: 0.01 },
        ],
      },
    },
    steps: [
      condition("gate", "{{trigger.amount}}", "gt", 5_000),
      approval("ask", "Approve this purchase?"),
      email("order", "purchasing@example.com", "Approved purchase"),
      sheets("log", "{{trigger.item}}", "{{trigger.department}}", "{{trigger.amount}}", "approved"),
      email("reject_notice", "requester@example.com", "Purchase rejected"),
      sheets("timeout_log", "{{trigger.item}}", "{{trigger.department}}", "{{trigger.amount}}", "timeout"),
      sheets("routine_log", "{{trigger.item}}", "{{trigger.department}}", "{{trigger.amount}}", "routine"),
      email("routine_notice", "purchasing@example.com", "Routine purchase"),
    ],
    edges: [
      edge("gate", "ask", "true"),
      edge("gate", "routine_log", "false"),
      edge("ask", "order", "approved"),
      edge("order", "log"),
      edge("ask", "reject_notice", "rejected"),
      edge("ask", "timeout_log", "timeout"),
      edge("routine_log", "routine_notice"),
    ],
  },
  cases: [
    { name: "7,800 goes to approval", payload: { item: "Laptop", department: "Finance", amount: 7_800 }, want: approved },
    { name: "exactly 5,000 is routine (gt boundary)", payload: { item: "Chair", department: "HR", amount: 5_000 }, want: routine },
    { name: "5,000.01 goes to approval", payload: { item: "Desk", department: "HR", amount: 5_000.01 }, want: approved },
    {
      name: "the tester picks rejected and the requester is told",
      payload: { item: "Laptop", department: "Finance", amount: 7_800 },
      options: { choices: { ask: { decision: "rejected" } } },
      want: ["gate", "ask", "reject_notice"],
      gap: { phase: "P3", today: approved, why: "mocked approvals always approve" },
    },
    {
      name: "the tester picks timeout and the timeout is logged",
      payload: { item: "Laptop", department: "Finance", amount: 7_800 },
      options: { choices: { ask: { decision: "timeout" } } },
      want: ["gate", "ask", "timeout_log"],
      gap: { phase: "P3", today: approved, why: "mocked approvals always approve" },
    },
    {
      name: "a missing department alone is refused at the boundary",
      payload: { item: "Pens", amount: 100 },
      want: REJECTED,
      gap: { phase: "P2", today: routine, why: "test-run payloads skip required-field checks" },
    },
  ],
};
