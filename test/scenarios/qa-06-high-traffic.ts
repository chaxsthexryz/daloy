import { approval, condition, edge, email, type Scenario } from "./types";

// QA-06 High-Traffic E-commerce Automation, v2 shape: classify the event, high-value refunds need approval and then POST.
// `fields` and `eventKey` on the webhook are the desired settings; today's schema drops both (P2, P4).
const webhook = {
  type: "webhook",
  config: {
    eventKey: "{{trigger.event_id}}",
    fields: [
      { name: "event_id", label: "Event ID", type: "text", required: true },
      { name: "type", label: "Event type", type: "text", required: true },
      { name: "amount", label: "Amount", type: "number", required: true, min: 0 },
    ],
  },
};
const toRefund = ["classify", "route", "high"];

export const qa06: Scenario = {
  id: "QA-06",
  name: "High-traffic e-commerce events",
  definition: {
    trigger: webhook,
    steps: [
      { id: "classify", type: "ai", config: { task: "classify", input: "{{trigger.type}} {{trigger.amount}}", labels: { notify_team: "anything that is not a refund", refund: "a refund request" } } },
      condition("route", "{{steps.classify.output.label}}", "eq", "refund"),
      condition("high", "{{trigger.amount}}", "gte", 10_000),
      approval("ask", "Approve this refund?"),
      { id: "post", type: "http", config: { method: "POST", url: "https://payments.example.com/refunds", headers: { "Content-Type": "application/json" }, body: '{"event": "{{trigger.event_id}}", "amount": {{trigger.amount}}}' } },
      email("small_refund", "support@example.com", "Small refund"),
      email("notify", "team@example.com", "New event"),
    ],
    edges: [edge("classify", "route"), edge("route", "high", "true"), edge("route", "notify", "false"), edge("high", "ask", "true"), edge("high", "small_refund", "false"), edge("ask", "post", "approved")],
  },
  cases: [
    // Postgres jsonb stores object keys shortest first, so the mock's "first label" is refund, not notify_team as written.
    {
      name: "the tester picks notify_team and an order event notifies the team",
      payload: { event_id: "evt_1", type: "order.created", amount: 900 },
      options: { choices: { classify: { label: "notify_team" } } },
      want: ["classify", "route", "notify"],
    },
    { name: "a 15,000 refund reaches approval and the POST", payload: { event_id: "evt_2", type: "refund.requested", amount: 15_000 }, options: { choices: { classify: { label: "refund" } } }, want: [...toRefund, "ask", "post"] },
    { name: "a 500 refund is handled as small", payload: { event_id: "evt_3", type: "refund.requested", amount: 500 }, options: { choices: { classify: { label: "refund" } } }, want: [...toRefund, "small_refund"] },
    {
      name: "exactly 10,000 is high value (gte boundary)",
      payload: { event_id: "evt_4", type: "refund.requested", amount: 10_000 },
      options: { choices: { classify: { label: "refund" } } },
      want: [...toRefund, "ask", "post"],
    },
  ],
};

/** A side-effect-free intake graph for volume and deduplication checks, so live runs need no model or network. */
export const intake = {
  trigger: webhook,
  steps: [condition("high", "{{trigger.amount}}", "gte", 10_000), condition("big", "{{trigger.amount}}", "gte", 100_000), condition("small", "{{trigger.amount}}", "lt", 100)],
  edges: [edge("high", "big", "true"), edge("high", "small", "false")],
};
