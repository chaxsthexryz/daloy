/**
 * Starter workflows offered by "New from template" in the builder. Phase 9 seeds them for the demo user.
 * Inquiry triage uses an AI classify step; a test run without live calls gets the first label ("billing") from the mock.
 */
/** The groups the Library page filters by (U5). Every template has exactly one. */
export const TEMPLATE_CATEGORIES = ["Inquiries", "Bookings", "Payments and receipts", "Orders", "Office"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATES = [
  {
    slug: "inquiry-triage",
    name: "Inquiry triage",
    description: "Thank the sender, let the model classify the message, then route billing questions and everything else to different inboxes.",
    category: "Inquiries",
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
    category: "Payments and receipts",
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
    category: "Bookings",
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
    category: "Bookings",
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
    category: "Office",
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
    category: "Bookings",
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
    category: "Orders",
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
    category: "Orders",
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
    category: "Payments and receipts",
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
    category: "Payments and receipts",
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
    category: "Office",
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
    name: "WooCommerce or other store orders",
    description: "Point a WooCommerce order webhook (or a small relay that sends these four fields) at this automation. For Shopify, use the Shopify orders template instead. Each order is added to your Google Sheet, the customer gets a receipt and the owner gets a Slack note.",
    category: "Orders",
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
  // I2: the native Shopify trigger. The order arrives already signed, checked and mapped to these fields (decision 0105).
  {
    slug: "shopify-orders",
    name: "Shopify orders",
    description: "Connect your Shopify store in Apps. Each new order is added to your Google Sheet, the customer gets a receipt when the order has an email, and the owner gets a Slack note. Daloy checks Shopify's signature before anything runs.",
    category: "Orders",
    definition: {
      trigger: { type: "shopify_order", config: {} },
      steps: [
        { id: "log_order", type: "sheets", config: { columns: ["{{trigger.order_number}}", "{{trigger.customer_name}}", "{{trigger.total}}", "{{trigger.items}}"] } },
        { id: "has_email", type: "condition", config: { condition: { left: "{{trigger.customer_email}}", op: "exists" } } },
        {
          id: "send_receipt",
          type: "email",
          config: { to: "{{trigger.customer_email}}", subject: "We got your order {{trigger.order_number}}", text: "Hi {{trigger.customer_name}}, thanks for your order {{trigger.order_number}} ({{trigger.total}} {{trigger.currency}}).\n\n{{trigger.items}}\n\nWe will email you when it ships." },
        },
        { id: "tell_owner", type: "slack", config: { text: "New Shopify order {{trigger.order_number}}: {{trigger.total}} {{trigger.currency}}, {{trigger.item_count}} items. Details are in your sheet." } },
      ],
      edges: [
        { from: "log_order", to: "has_email" },
        { from: "has_email", to: "send_receipt", on: "true" },
        { from: "has_email", to: "tell_owner", on: "false" },
        { from: "send_receipt", to: "tell_owner" },
      ],
    },
  },
  // N22: the AI step reads the receipt photo. The photo stays in the run page; the sheet row holds only the text the model read.
  {
    slug: "receipt-expense",
    name: "Receipt to expense row",
    description: "Someone sends a receipt photo on a form. The model reads the shop, total and date, you approve, and Daloy adds a row to your Google Sheet. Needs Google Drive (a shared drive folder), Google Sheets, and an AI model that reads images (Gemini, OpenAI or OpenRouter).",
    category: "Payments and receipts",
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
          config: { to: "{{trigger.email}}", subject: "No decision on your expense yet", text: "Nobody has decided on your expense submission yet. Please ask the owner." },
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
  // N16: FB Messenger and Instagram DM receipt intake. A screenshot is never proof of payment: the sheet row is
  // explicitly marked "Pending verification" and the owner checks their real GCash or bank inbox before approving.
  {
    slug: "meta-receipt-intake",
    name: "FB and IG receipt check",
    description: "When a customer sends a GCash or bank receipt photo on Facebook Messenger or Instagram, Daloy reads the details, saves the photo, logs a pending row to Google Sheets and asks you to verify before replying. Needs Facebook Messenger & Instagram, Google Drive, Google Sheets and an AI model that reads images.",
    category: "Payments and receipts",
    definition: {
      trigger: {
        type: "meta_dm",
        config: { channel: "both", requireImage: true },
      },
      steps: [
        {
          id: "read_receipt",
          type: "ai",
          config: {
            task: "extract",
            input: "Channel: {{trigger.channel}}. Message: {{trigger.text}}",
            files: ["image"],
            fields: {
              is_receipt: "Reply yes if this photo is a GCash, Maya or bank transfer receipt, otherwise no",
              provider: "Payment provider or bank name on the receipt (for example GCash, Maya, BDO, BPI)",
              reference: "Reference or transaction number on the receipt",
              amount: "Amount paid, digits and a decimal point only",
              sender_name: "Sender name on the receipt",
              date: "Date on the receipt as YYYY-MM-DD",
            },
          },
        },
        { id: "save_receipt", type: "drive", config: {} },
        {
          id: "is_receipt",
          type: "condition",
          config: { condition: { left: "{{steps.read_receipt.output.is_receipt}}", op: "eq", right: "yes" } },
        },
        {
          id: "log_pending",
          type: "sheets",
          config: {
            columns: [
              "Pending verification",
              "{{trigger.channel}}",
              "{{trigger.senderId}}",
              "{{steps.read_receipt.output.provider}}",
              "{{steps.read_receipt.output.reference}}",
              "{{steps.read_receipt.output.amount}}",
              "{{steps.read_receipt.output.date}}",
            ],
          },
        },
        {
          id: "approve",
          type: "approval",
          config: {
            approver: "owner@example.com",
            subject: "Verify receipt {{steps.read_receipt.output.reference}} ({{steps.read_receipt.output.amount}})",
            message: "A customer sent a receipt photo on {{trigger.channel}}.\nProvider: {{steps.read_receipt.output.provider}}\nReference: {{steps.read_receipt.output.reference}}\nAmount: {{steps.read_receipt.output.amount}}\nSender: {{steps.read_receipt.output.sender_name}}\nDate: {{steps.read_receipt.output.date}}\n{{steps.read_receipt.output.duplicate_warning}}\nCheck your real GCash or bank inbox before approving. A screenshot is never proof of payment.",
            timeoutSeconds: 86_400,
          },
        },
        {
          id: "reply_confirmed",
          type: "meta_reply",
          config: {
            recipientId: "{{trigger.senderId}}",
            channel: "{{trigger.channel}}",
            text: "Thanks! We verified your payment and confirmed your order.",
          },
        },
        {
          id: "reply_rejected",
          type: "meta_reply",
          config: {
            recipientId: "{{trigger.senderId}}",
            channel: "{{trigger.channel}}",
            text: "We could not match that payment yet. Please double-check the transfer details and send us a message again.",
          },
        },
        {
          id: "notify_timeout",
          type: "email",
          config: {
            to: "owner@example.com",
            subject: "Receipt check timed out",
            text: "A receipt sent on {{trigger.channel}} (reference {{steps.read_receipt.output.reference}}, amount {{steps.read_receipt.output.amount}}) was not reviewed within 24 hours. Meta's 24-hour reply window may have closed, so reply directly from your Page inbox.",
          },
        },
      ],
      edges: [
        { from: "read_receipt", to: "save_receipt" },
        { from: "save_receipt", to: "is_receipt" },
        { from: "is_receipt", to: "log_pending", on: "true" },
        { from: "log_pending", to: "approve" },
        { from: "approve", to: "reply_confirmed", on: "approved" },
        { from: "approve", to: "reply_rejected", on: "rejected" },
        { from: "approve", to: "notify_timeout", on: "timeout" },
      ],
    },
  },
  // R3 (decision 0090): the receipt-review path. The customer pays the shop's QR Ph code or GCash number and sends the
  // transfer reference on the pay page. Staff confirm in Receipts to review. The nudge and the deadline are steps here.
  {
    slug: "booking-deposit-review",
    name: "Booking with a GCash or QR Ph deposit",
    description: "A customer asks for a time. You approve it, Daloy books it and asks for a deposit to your QR Ph code or GCash number, and the customer sends the transfer reference. You check your own GCash or bank history and confirm in Receipts to review. Unpaid after 6 hours: an SMS reminder. Unpaid after 24 hours: the slot is released and the customer is told. Needs UniSMS.",
    category: "Bookings",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "name", label: "Your name", type: "text", required: true },
            { name: "phone", label: "Mobile number", type: "text", required: true },
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
          config: { to: "owner@example.com", subject: "Booking request from {{trigger.name}}", message: "{{trigger.name}} ({{trigger.phone}}) asks for {{trigger.service}} at {{trigger.appointment_at}}. If you approve, Daloy books it and asks for the deposit.", timeoutSeconds: 172_800 },
        },
        { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.resource}}", start: "{{trigger.appointment_at}}", minutes: 60 } },
        {
          id: "ask_deposit",
          type: "payment_due",
          config: { reference: "{{steps.book.output.reference}}", kind: "deposit", amount: "350", total: "1200", booking: "book", checkout: false, channel: "sms", to: "{{trigger.phone}}", confirmedMessage: "Hi {{trigger.name}}, we received your 350 peso deposit for {{steps.book.output.reference}}. See you on {{trigger.appointment_at}}." },
        },
        { id: "send_pay_link", type: "sms", config: { to: "{{trigger.phone}}", message: "Hi {{trigger.name}}, your slot {{steps.book.output.reference}} is held. Pay the 350 peso deposit and send your reference here: {{steps.ask_deposit.output.payUrl}}" } },
        { id: "wait_reminder", type: "delay", config: { seconds: 21_600 } },
        { id: "check_paid", type: "payment_status", config: { link: "ask_deposit" } },
        { id: "still_unpaid", type: "condition", config: { condition: { left: "{{steps.check_paid.output.status}}", op: "eq", right: "pending" } } },
        { id: "remind", type: "sms", config: { to: "{{trigger.phone}}", message: "Reminder: the deposit for {{steps.book.output.reference}} is still unpaid. Pay and send your reference here: {{steps.ask_deposit.output.payUrl}}" } },
        { id: "wait_deadline", type: "delay", config: { seconds: 64_800 } },
        { id: "check_deadline", type: "payment_status", config: { link: "ask_deposit" } },
        { id: "unpaid_at_deadline", type: "condition", config: { condition: { left: "{{steps.check_deadline.output.status}}", op: "eq", right: "pending" } } },
        { id: "release_slot", type: "payment_expire", config: { due: "ask_deposit" } },
        { id: "tell_released", type: "sms", config: { to: "{{trigger.phone}}", message: "Hi {{trigger.name}}, we did not receive the deposit for {{steps.book.output.reference}}, so the slot was released. Book again any time." } },
        { id: "tell_taken", type: "sms", config: { to: "{{trigger.phone}}", message: "Hi {{trigger.name}}, {{trigger.appointment_at}} was just booked by someone else. Please choose another time." } },
        { id: "tell_declined", type: "sms", config: { to: "{{trigger.phone}}", message: "Hi {{trigger.name}}, we cannot take the booking for {{trigger.appointment_at}}. Please choose another time." } },
      ],
      edges: [
        { from: "decide", to: "book", on: "approved" },
        { from: "decide", to: "tell_declined", on: "rejected" },
        { from: "decide", to: "tell_declined", on: "timeout" },
        { from: "book", to: "ask_deposit", on: "done" },
        { from: "book", to: "tell_taken", on: "taken" },
        { from: "ask_deposit", to: "send_pay_link" },
        { from: "send_pay_link", to: "wait_reminder" },
        { from: "wait_reminder", to: "check_paid" },
        { from: "check_paid", to: "still_unpaid" },
        { from: "still_unpaid", to: "remind", on: "true" },
        { from: "remind", to: "wait_deadline" },
        { from: "wait_deadline", to: "check_deadline" },
        { from: "check_deadline", to: "unpaid_at_deadline" },
        { from: "unpaid_at_deadline", to: "release_slot", on: "true" },
        { from: "release_slot", to: "tell_released", on: "expired" },
      ],
    },
  },
  // R3 (decision 0090): the automatic path. Only a verified PayMongo event that matches the order confirms it.
  {
    slug: "order-gcash-checkout",
    name: "Order with GCash checkout",
    description: "Your shop sends a signed order webhook. The customer gets a PayMongo checkout link (GCash when enabled for your account) and the QR Ph option. Daloy confirms the order only when a verified PayMongo payment matches it, then texts the customer once. Unpaid after a day: a reminder. Unpaid after three days: the order is cancelled and the customer is told. Needs PayMongo and UniSMS.",
    category: "Orders",
    definition: {
      trigger: {
        type: "webhook",
        config: {
          hmacSecret: "order_webhook_secret",
          requireTimestamp: true,
          eventKey: "{{trigger.order_id}}",
          fields: [
            { name: "order_id", label: "Order number", type: "text", required: true },
            { name: "customer_name", label: "Customer name", type: "text", required: true },
            { name: "phone", label: "Mobile number", type: "text", required: true },
            { name: "amount", label: "Amount in pesos", type: "number", required: true, min: 1 },
          ],
        },
      },
      steps: [
        {
          id: "ask_payment",
          type: "payment_due",
          config: { reference: "{{trigger.order_id}}", kind: "full", amount: "{{trigger.amount}}", checkout: true, channel: "sms", to: "{{trigger.phone}}", confirmedMessage: "Hi {{trigger.customer_name}}, your payment for order {{trigger.order_id}} is confirmed. Thank you!" },
        },
        { id: "send_checkout", type: "sms", config: { to: "{{trigger.phone}}", message: "Hi {{trigger.customer_name}}, pay {{trigger.amount}} pesos for order {{trigger.order_id}} here: {{steps.ask_payment.output.checkoutUrl}}" } },
        { id: "wait_reminder", type: "delay", config: { seconds: 86_400 } },
        { id: "check_paid", type: "payment_status", config: { link: "ask_payment" } },
        { id: "still_unpaid", type: "condition", config: { condition: { left: "{{steps.check_paid.output.status}}", op: "eq", right: "pending" } } },
        { id: "remind", type: "sms", config: { to: "{{trigger.phone}}", message: "Reminder: order {{trigger.order_id}} is still unpaid. Pay here: {{steps.ask_payment.output.checkoutUrl}}" } },
        { id: "wait_deadline", type: "delay", config: { seconds: 172_800 } },
        { id: "check_deadline", type: "payment_status", config: { link: "ask_payment" } },
        { id: "unpaid_at_deadline", type: "condition", config: { condition: { left: "{{steps.check_deadline.output.status}}", op: "eq", right: "pending" } } },
        { id: "cancel_order", type: "payment_expire", config: { due: "ask_payment" } },
        { id: "tell_cancelled", type: "sms", config: { to: "{{trigger.phone}}", message: "Hi {{trigger.customer_name}}, order {{trigger.order_id}} was cancelled because it was not paid in time. Reply if you already paid." } },
      ],
      edges: [
        { from: "ask_payment", to: "send_checkout" },
        { from: "send_checkout", to: "wait_reminder" },
        { from: "wait_reminder", to: "check_paid" },
        { from: "check_paid", to: "still_unpaid" },
        { from: "still_unpaid", to: "remind", on: "true" },
        { from: "remind", to: "wait_deadline" },
        { from: "wait_deadline", to: "check_deadline" },
        { from: "check_deadline", to: "unpaid_at_deadline" },
        { from: "unpaid_at_deadline", to: "cancel_order", on: "true" },
        { from: "cancel_order", to: "tell_cancelled", on: "expired" },
      ],
    },
  },
] as const;
