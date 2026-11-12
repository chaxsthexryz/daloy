/**
 * Starter workflows offered by "New from template" in the builder. Phase 9 seeds them for the demo user.
 * Inquiry triage uses an AI classify step; a test run without live calls gets the first label ("billing") from the mock.
 */
export const TEMPLATES = [
  {
    slug: "inquiry-triage",
    name: "Inquiry triage",
    description: "Thank the sender, let the model classify the message, then route billing questions and everything else to different inboxes.",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "name", label: "Your name", type: "text", required: true },
            { name: "email", label: "Email", type: "email", required: true },
            { name: "message", label: "How can we help?", type: "textarea", required: true },
          ],
        },
      },
      steps: [
        {
          id: "acknowledge",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "We got your message", text: "Hi {{trigger.name}}, thanks for writing. We reply within one working day." },
        },
        {
          id: "classify",
          type: "ai",
          config: {
            task: "classify",
            input: "{{trigger.message}}",
            labels: {
              billing: "Invoices, payments, refunds and prices",
              support: "Problems with the product or questions about using it",
              other: "Anything else",
            },
          },
        },
        { id: "is_billing", type: "condition", config: { condition: { left: "{{steps.classify.output.label}}", op: "eq", right: "billing" } } },
        {
          id: "to_billing",
          type: "email",
          config: { to: "billing@example.com", subject: "Billing inquiry from {{trigger.name}}", text: "{{trigger.message}}\n\nReply to: {{trigger.email}}" },
        },
        {
          id: "to_support",
          type: "email",
          config: { to: "support@example.com", subject: "Inquiry from {{trigger.name}}", text: "{{trigger.message}}\n\nReply to: {{trigger.email}}" },
        },
      ],
      edges: [
        { from: "acknowledge", to: "classify" },
        { from: "classify", to: "is_billing" },
        { from: "is_billing", to: "to_billing", on: "true" },
        { from: "is_billing", to: "to_support", on: "false" },
      ],
    },
  },
  {
    slug: "invoice-follow-up",
    name: "Invoice follow-up",
    description: "Seven days after an invoice is sent, check whether it is paid and email a reminder if not.",
    definition: {
      trigger: { type: "webhook", config: {} },
      steps: [
        { id: "wait_a_week", type: "delay", config: { seconds: 604_800 } },
        {
          id: "check_status",
          type: "http",
          config: { method: "GET", url: "https://billing.example.com/invoices/{{trigger.invoice_id}}", headers: { Authorization: "Bearer {{secrets.billing_token}}" } },
        },
        { id: "is_unpaid", type: "condition", config: { condition: { left: "{{steps.check_status.output.body.status}}", op: "neq", right: "paid" } } },
        {
          id: "remind",
          type: "email",
          config: {
            to: "{{trigger.customer_email}}",
            subject: "Reminder: invoice {{trigger.invoice_id}}",
            text: "Hi {{trigger.customer_name}}, invoice {{trigger.invoice_id}} for {{trigger.amount}} is still open. You can pay it at {{trigger.pay_url}}.",
          },
        },
      ],
      edges: [
        { from: "wait_a_week", to: "check_status" },
        { from: "check_status", to: "is_unpaid" },
        { from: "is_unpaid", to: "remind", on: "true" },
      ],
    },
  },
  {
    slug: "no-show-follow-up",
    name: "Booking no-show follow-up",
    description: "When a booking is marked as a no-show, wait an hour, then send a link to rebook.",
    definition: {
      trigger: { type: "webhook", config: {} },
      steps: [
        { id: "is_no_show", type: "condition", config: { condition: { left: "{{trigger.status}}", op: "eq", right: "no_show" } } },
        { id: "wait_an_hour", type: "delay", config: { seconds: 3600 } },
        {
          id: "offer_rebook",
          type: "email",
          config: {
            to: "{{trigger.customer_email}}",
            subject: "Sorry we missed you",
            text: "Hi {{trigger.customer_name}}, we missed you at your {{trigger.service}} booking. Pick a new time here: {{trigger.rebook_url}}",
          },
        },
      ],
      edges: [
        { from: "is_no_show", to: "wait_an_hour", on: "true" },
        { from: "wait_an_hour", to: "offer_rebook" },
      ],
    },
  },
] as const;
