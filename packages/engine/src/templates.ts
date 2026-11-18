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
          config: { to: "{{trigger.email}}", subject: "We got your message", text: "Thanks for writing. We reply within one working day." },
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
  // Ready-made business starters, simple to complex (T1). Each uses only existing steps; PayMongo and Calendar need those apps connected before going live.
  {
    slug: "appointment-reminder",
    name: "Appointment reminder",
    description: "A day before the appointment, email the customer a reminder.",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "name", label: "Your name", type: "text", required: true },
            { name: "email", label: "Email", type: "email", required: true },
            { name: "service", label: "Service", type: "text", required: true },
            { name: "appointment_at", label: "Appointment time", type: "datetime", timezone: "Asia/Manila", required: true },
          ],
        },
      },
      steps: [
        { id: "wait_for_day_before", type: "delay", config: { until: "{{trigger.appointment_at}}", offsetSeconds: -86_400 } },
        {
          id: "remind",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "Reminder: your {{trigger.service}} appointment", text: "Hi {{trigger.name}}, this is a reminder of your {{trigger.service}} appointment on {{trigger.appointment_at}}. Reply to this email if you need to change it." },
        },
      ],
      edges: [{ from: "wait_for_day_before", to: "remind" }],
    },
  },
  {
    slug: "request-to-sheets",
    name: "Client request to Sheets",
    description: "A client or teammate sends a request on a form. It is added to your Google Sheet and they get a receipt.",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "name", label: "Your name", type: "text", required: true },
            { name: "email", label: "Email", type: "email", required: true },
            { name: "request", label: "What do you need?", type: "textarea", required: true },
          ],
        },
      },
      steps: [
        { id: "log_request", type: "sheets", config: { columns: ["{{trigger.name}}", "{{trigger.email}}", "{{trigger.request}}"] } },
        {
          id: "send_receipt",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "We got your request", text: "Thanks, we added your request to our list and will get back to you soon." },
        },
      ],
      edges: [{ from: "log_request", to: "send_receipt" }],
    },
  },
  {
    slug: "lead-to-booking",
    name: "Lead to booking",
    description: "A lead picks a time on a form. Staff approve before anything is booked. Then Daloy books it, adds it to Google Calendar and confirms by email, or offers another time if the slot is taken.",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "name", label: "Your name", type: "text", required: true },
            { name: "email", label: "Email", type: "email", required: true },
            { name: "service", label: "Service", type: "text", required: true },
            { name: "resource", label: "Who or what to book", type: "resource", required: true },
            { name: "appointment_at", label: "Preferred time", type: "datetime", timezone: "Asia/Manila", slotMinutes: 30, required: true },
          ],
        },
      },
      steps: [
        {
          id: "decide",
          type: "approval",
          config: { to: "owner@example.com", subject: "Booking request from {{trigger.name}}", message: "{{trigger.name}} ({{trigger.email}}) asks for {{trigger.service}} at {{trigger.appointment_at}}.", timeoutSeconds: 172_800 },
        },
        { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.resource}}", start: "{{trigger.appointment_at}}", minutes: 60 } },
        { id: "add_to_calendar", type: "calendar", config: { title: "{{trigger.service}}: {{trigger.name}}", description: "Booked by {{trigger.name}} ({{trigger.email}})" } },
        {
          id: "confirm",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "Your {{trigger.service}} booking is confirmed", text: "Hi {{trigger.name}}, you are booked for {{trigger.appointment_at}}. See you then." },
        },
        {
          id: "tell_taken",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "That time is taken", text: "Hi {{trigger.name}}, {{trigger.appointment_at}} is already booked. Please send the form again with another time." },
        },
        {
          id: "tell_owner",
          type: "email",
          config: { to: "owner@example.com", subject: "Booking problem for {{trigger.name}}", text: "{{trigger.name}} ({{trigger.email}}) asked for a resource that could not be found. Please reply to them." },
        },
        {
          id: "tell_declined",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "About your booking request", text: "Hi {{trigger.name}}, thank you for asking. We cannot take that booking right now." },
        },
        {
          id: "tell_no_decision",
          type: "email",
          config: { to: "owner@example.com", subject: "Booking request from {{trigger.name}} is waiting", text: "Nobody answered the booking request from {{trigger.name}} ({{trigger.email}}) in two days. Please reply to them." },
        },
      ],
      edges: [
        { from: "decide", to: "book", on: "approved" },
        { from: "decide", to: "tell_declined", on: "rejected" },
        { from: "decide", to: "tell_no_decision", on: "timeout" },
        { from: "book", to: "add_to_calendar", on: "done" },
        { from: "add_to_calendar", to: "confirm" },
        { from: "book", to: "tell_taken", on: "taken" },
        { from: "book", to: "tell_owner", on: "not_found" },
      ],
    },
  },
  {
    slug: "order-to-sheets",
    name: "Order to Sheets with payment link",
    description: "An order form asks you to approve the price first. If you approve, it adds a pending row to your Google Sheet and emails the customer a PayMongo payment link.",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "name", label: "Your name", type: "text", required: true },
            { name: "email", label: "Email", type: "email", required: true },
            { name: "item", label: "What do you want to order?", type: "text", required: true },
            { name: "amount", label: "Amount in pesos", type: "number", required: true, min: 1 },
          ],
        },
      },
      steps: [
        {
          id: "approve_price",
          type: "approval",
          config: { to: "owner@example.com", subject: "Order from {{trigger.name}}: {{trigger.item}}", message: "{{trigger.name}} ({{trigger.email}}) wants to order:\n{{trigger.item}}\nAmount entered by the buyer: {{trigger.amount}} pesos\nApprove only if this is your price for the item.", timeoutSeconds: 172_800 },
        },
        { id: "pay_link", type: "paymongo_link", config: { amount: "{{trigger.amount}}", description: "{{trigger.item}}", reference: "{{trigger.name}} - {{trigger.item}}" } },
        { id: "log_order", type: "sheets", config: { columns: ["{{steps.pay_link.output.paymentId}}", "{{trigger.name}}", "{{trigger.item}}", "{{steps.pay_link.output.amountPesos}}", "PHP", "pending"] } },
        {
          id: "send_link",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "Pay for your order: {{trigger.item}}", text: "Hi {{trigger.name}}, thanks for your order of {{trigger.item}} ({{trigger.amount}} pesos). Pay here: {{steps.pay_link.output.url}}" },
        },
        {
          id: "tell_declined",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "About your order: {{trigger.item}}", text: "Hi {{trigger.name}}, thank you for your order. We could not accept it at that price. Please contact us to arrange it." },
        },
        {
          id: "tell_no_decision",
          type: "email",
          config: { to: "owner@example.com", subject: "Order from {{trigger.name}} is waiting", text: "Nobody answered the order from {{trigger.name}} ({{trigger.email}}) for {{trigger.item}} in two days. Please reply to them." },
        },
      ],
      edges: [
        { from: "approve_price", to: "pay_link", on: "approved" },
        { from: "pay_link", to: "log_order" },
        { from: "log_order", to: "send_link" },
        { from: "approve_price", to: "tell_declined", on: "rejected" },
        { from: "approve_price", to: "tell_no_decision", on: "timeout" },
      ],
    },
  },
  {
    slug: "order-paid",
    name: "Order paid",
    description: "When PayMongo confirms a payment, add a paid row to your Google Sheet. Pairs with Order to Sheets.",
    definition: {
      trigger: { type: "payment", config: { events: ["paid"] } },
      steps: [{ id: "log_paid", type: "sheets", config: { columns: ["{{trigger.paymentId}}", "paid", "{{trigger.amountPesos}}", "PHP"] } }],
      edges: [],
    },
  },
  {
    slug: "invoice-paymongo",
    name: "Invoice with payment link and reminders",
    description: "Email an invoice with a PayMongo link, remind once after a week if it is still unpaid, and tell the owner after two weeks. Nothing is sent once it is paid.",
    definition: {
      trigger: {
        type: "webhook",
        config: {
          hmacSecret: "invoice_webhook_secret",
          requireTimestamp: true,
          eventKey: "{{trigger.invoice_id}}",
          fields: [
            { name: "invoice_id", label: "Invoice number", type: "text", required: true },
            { name: "customer_name", label: "Customer name", type: "text", required: true },
            { name: "customer_email", label: "Customer email", type: "email", required: true },
            { name: "amount", label: "Amount in pesos", type: "number", required: true, min: 1 },
          ],
        },
      },
      steps: [
        { id: "pay_link", type: "paymongo_link", config: { amount: "{{trigger.amount}}", description: "Invoice {{trigger.invoice_id}}", reference: "{{trigger.invoice_id}}" } },
        {
          id: "send_invoice",
          type: "email",
          config: { to: "{{trigger.customer_email}}", subject: "Invoice {{trigger.invoice_id}}", text: "Hi {{trigger.customer_name}}, invoice {{trigger.invoice_id}} for {{trigger.amount}} pesos is ready. Pay here: {{steps.pay_link.output.url}}" },
        },
        { id: "wait_a_week", type: "delay", config: { seconds: 604_800 } },
        { id: "check_paid", type: "payment_status", config: { link: "pay_link" } },
        { id: "is_pending", type: "condition", config: { condition: { left: "{{steps.check_paid.output.status}}", op: "eq", right: "pending" } } },
        {
          id: "remind",
          type: "email",
          config: { to: "{{trigger.customer_email}}", subject: "Reminder: invoice {{trigger.invoice_id}}", text: "Hi {{trigger.customer_name}}, invoice {{trigger.invoice_id}} for {{trigger.amount}} pesos is still open. Pay here: {{steps.pay_link.output.url}}" },
        },
        { id: "wait_another_week", type: "delay", config: { seconds: 604_800 } },
        { id: "check_again", type: "payment_status", config: { link: "pay_link" } },
        { id: "still_pending", type: "condition", config: { condition: { left: "{{steps.check_again.output.status}}", op: "eq", right: "pending" } } },
        {
          id: "tell_owner",
          type: "email",
          config: { to: "owner@example.com", subject: "Invoice {{trigger.invoice_id}} is two weeks overdue", text: "{{trigger.customer_name}} ({{trigger.customer_email}}) has not paid invoice {{trigger.invoice_id}} ({{trigger.amount}} pesos) after two reminders." },
        },
      ],
      edges: [
        { from: "pay_link", to: "send_invoice" },
        { from: "send_invoice", to: "wait_a_week" },
        { from: "wait_a_week", to: "check_paid" },
        { from: "check_paid", to: "is_pending" },
        { from: "is_pending", to: "remind", on: "true" },
        { from: "remind", to: "wait_another_week" },
        { from: "wait_another_week", to: "check_again" },
        { from: "check_again", to: "still_pending" },
        { from: "still_pending", to: "tell_owner", on: "true" },
      ],
    },
  },
  {
    slug: "quote-deposit",
    name: "Quote approval with deposit",
    description: "A quote request goes to the owner for approval. If approved, the customer gets a PayMongo deposit link; if not, a polite decline.",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "name", label: "Your name", type: "text", required: true },
            { name: "email", label: "Email", type: "email", required: true },
            { name: "service", label: "What do you need?", type: "textarea", required: true },
            { name: "deposit", label: "Deposit in pesos", type: "number", required: true, min: 1 },
          ],
        },
      },
      steps: [
        {
          id: "decide",
          type: "approval",
          config: { to: "owner@example.com", subject: "Quote request from {{trigger.name}}", message: "{{trigger.name}} ({{trigger.email}}) asks for:\n{{trigger.service}}\nDeposit: {{trigger.deposit}} pesos", timeoutSeconds: 172_800 },
        },
        { id: "deposit_link", type: "paymongo_link", config: { amount: "{{trigger.deposit}}", description: "Deposit for {{trigger.name}}", reference: "Quote {{trigger.name}}" } },
        {
          id: "send_deposit",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "Your quote is approved", text: "Hi {{trigger.name}}, we can do it. Please pay the {{trigger.deposit}} peso deposit to confirm: {{steps.deposit_link.output.url}}" },
        },
        {
          id: "tell_declined",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "About your quote request", text: "Hi {{trigger.name}}, thank you for asking. We cannot take this one on right now." },
        },
        {
          id: "tell_no_decision",
          type: "email",
          config: { to: "owner@example.com", subject: "Quote request from {{trigger.name}} is waiting", text: "Nobody answered the quote request from {{trigger.name}} ({{trigger.email}}) in two days. Please reply to them." },
        },
      ],
      edges: [
        { from: "decide", to: "deposit_link", on: "approved" },
        { from: "deposit_link", to: "send_deposit" },
        { from: "decide", to: "tell_declined", on: "rejected" },
        { from: "decide", to: "tell_no_decision", on: "timeout" },
      ],
    },
  },
  // N20: two more starters, existing steps only. The Sheet is a register Daloy appends to; no step reads a sheet, so the 30-day wait runs per item from its expiry date.
  {
    slug: "renewal-reminders",
    name: "Renewal reminders",
    description: "Add each domain, hosting plan, SSL certificate, permit or insurance policy on a form. Daloy lists it in your Google Sheet and emails you 30 days before it expires.",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "item", label: "What renews? (domain, hosting, SSL, permit, insurance)", type: "text", required: true },
            { name: "expires_at", label: "Expires on", type: "datetime", timezone: "Asia/Manila", required: true },
            { name: "email", label: "Send the reminder to", type: "email", required: true },
          ],
        },
      },
      steps: [
        { id: "log_item", type: "sheets", config: { columns: ["{{trigger.item}}", "{{trigger.expires_at}}", "{{trigger.email}}"] } },
        { id: "wait_until_30_days_before", type: "delay", config: { until: "{{trigger.expires_at}}", offsetSeconds: -2_592_000 } },
        {
          id: "remind",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "Renewal due in 30 days: {{trigger.item}}", text: "{{trigger.item}} expires on {{trigger.expires_at}}. Renew it now so it does not lapse." },
        },
      ],
      edges: [
        { from: "log_item", to: "wait_until_30_days_before" },
        { from: "wait_until_30_days_before", to: "remind" },
      ],
    },
  },
  {
    slug: "store-orders",
    name: "Shopify or WooCommerce orders",
    description: "Point a Shopify or WooCommerce order webhook (or a small relay that sends these four fields) at this automation. Each order is added to your Google Sheet, the customer gets a receipt and the owner gets a Slack note.",
    definition: {
      trigger: {
        type: "webhook",
        config: {
          fields: [
            { name: "order_id", label: "Order number", type: "text", required: true },
            { name: "customer_name", label: "Customer name", type: "text", required: true },
            { name: "customer_email", label: "Customer email", type: "email", required: true },
            { name: "total", label: "Total in pesos", type: "number", required: true, min: 0 },
          ],
        },
      },
      steps: [
        { id: "log_order", type: "sheets", config: { columns: ["{{trigger.order_id}}", "{{trigger.customer_name}}", "{{trigger.total}}"] } },
        {
          id: "send_receipt",
          type: "email",
          config: { to: "{{trigger.customer_email}}", subject: "We got your order {{trigger.order_id}}", text: "Hi {{trigger.customer_name}}, thanks for your order {{trigger.order_id}} ({{trigger.total}} pesos). We will email you when it ships." },
        },
        { id: "tell_owner", type: "slack", config: { text: "New order {{trigger.order_id}}: {{trigger.total}} pesos. Details are in your sheet." } },
      ],
      edges: [
        { from: "log_order", to: "send_receipt" },
        { from: "send_receipt", to: "tell_owner" },
      ],
    },
  },
  // N22: the AI step reads the receipt photo. The photo stays in the run page; the sheet row holds only the text the model read.
  {
    slug: "receipt-expense",
    name: "Receipt to expense row",
    description: "Someone sends a receipt photo on a form. The model reads the shop, total and date, you approve, and Daloy adds a row to your Google Sheet. Needs Google Drive (a shared drive folder), Google Sheets, and an AI model that reads images (Gemini, OpenAI or OpenRouter).",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "name", label: "Your name", type: "text", required: true },
            { name: "email", label: "Email", type: "email", required: true },
            { name: "receipt", label: "Receipt photo", type: "file", required: true },
            { name: "note", label: "Note", type: "textarea", required: false },
          ],
        },
      },
      steps: [
        { id: "save_receipt", type: "drive", config: {} },
        {
          id: "read_receipt",
          type: "ai",
          config: {
            task: "extract",
            input: "Sent by {{trigger.name}}. Note: {{trigger.note}}",
            files: ["receipt"],
            fields: {
              shop: "Shop or business name on the receipt",
              amount: "Total amount paid, digits and a decimal point only",
              date: "Date on the receipt as YYYY-MM-DD",
            },
          },
        },
        {
          id: "approve",
          type: "approval",
          config: {
            to: "owner@example.com",
            subject: "Expense from {{trigger.name}}",
            message: "{{trigger.name}} sent a receipt.\nShop: {{steps.read_receipt.output.shop}}\nAmount: {{steps.read_receipt.output.amount}}\nThe photo is on the run page in Daloy.",
            timeoutSeconds: 172_800,
          },
        },
        {
          id: "log_expense",
          type: "sheets",
          config: { columns: ["{{trigger.name}}", "{{steps.read_receipt.output.shop}}", "{{steps.read_receipt.output.amount}}", "{{steps.read_receipt.output.date}}", "{{trigger.note}}"] },
        },
        {
          id: "tell_approved",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "Your expense was approved", text: "Hi {{trigger.name}}, your receipt from {{steps.read_receipt.output.shop}} ({{steps.read_receipt.output.amount}}) was approved and added to the expense list." },
        },
        {
          id: "tell_rejected",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "Your expense was not approved", text: "Hi {{trigger.name}}, your receipt from {{steps.read_receipt.output.shop}} ({{steps.read_receipt.output.amount}}) was not approved." },
        },
        {
          id: "tell_no_decision",
          type: "email",
          config: { to: "{{trigger.email}}", subject: "No decision on your expense yet", text: "Hi {{trigger.name}}, nobody has decided on your receipt from {{steps.read_receipt.output.shop}} yet. Please ask the owner." },
        },
      ],
      edges: [
        { from: "save_receipt", to: "read_receipt" },
        { from: "read_receipt", to: "approve" },
        { from: "approve", to: "log_expense", on: "approved" },
        { from: "log_expense", to: "tell_approved" },
        { from: "approve", to: "tell_rejected", on: "rejected" },
        { from: "approve", to: "tell_no_decision", on: "timeout" },
      ],
    },
  },
] as const;
