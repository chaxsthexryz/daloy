/**
 * Starter workflows offered by "New from template" in the builder. Phase 9 seeds them for the demo user.
 * Inquiry triage uses an AI classify step; a test run without live calls gets the first label ("billing") from the mock.
 */
/** The groups the Library page filters by (U5). Every template has exactly one. */
export const TEMPLATE_CATEGORIES = ["Inquiries", "Bookings", "Payments and receipts", "Orders", "Resorts and hotels", "Office"] as const;
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
    description: "A lead picks a time on a form. Staff approve before anything is booked. Then kymavo books it, adds it to Google Calendar and confirms by email, or offers another time if the slot is taken.",
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
  // N23 (decision 0140): the same chase as invoice-paymongo, with a PDF invoice attached to the first email. The
  // reminders link to the payment page and attach nothing, because uploads are purged after 7 days.
  {
    slug: "invoice-pdf",
    name: "Invoice with PDF and reminders",
    description: "Fill in the form and approve the email that follows to send a client a PDF invoice with a PayMongo link. It reminds them once after a week while unpaid and tells you after two weeks.",
    category: "Payments and receipts",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "client_name", label: "Client name", type: "text", required: true },
            { name: "client_email", label: "Client email", type: "email", required: true },
            { name: "invoice_number", label: "Invoice number", type: "text", required: true },
            { name: "service", label: "What is it for?", type: "text", required: true },
            { name: "quantity", label: "Quantity or hours", type: "number", required: true, min: 0.01, max: 10000 },
            { name: "rate", label: "Rate in pesos", type: "number", required: true, min: 0.01 },
            { name: "due_date", label: "Due date", type: "text", required: false },
          ],
        },
      },
      steps: [
        {
          id: "decide",
          type: "approval",
          config: { to: "owner@example.com", subject: "Send invoice {{trigger.invoice_number}}?", message: "Invoice {{trigger.invoice_number}} to {{trigger.client_name}} ({{trigger.client_email}}):\n{{trigger.service}}, {{trigger.quantity}} x {{trigger.rate}} pesos\nApprove to make the PDF and email it.", timeoutSeconds: 172_800 },
        },
        {
          id: "make_invoice",
          type: "invoice_pdf",
          config: {
            businessName: "My business",
            clientName: "{{trigger.client_name}}",
            clientEmail: "{{trigger.client_email}}",
            invoiceNumber: "{{trigger.invoice_number}}",
            items: [{ description: "{{trigger.service}}", quantity: "{{trigger.quantity}}", unitPrice: "{{trigger.rate}}" }],
            currency: "PHP",
            dueDate: "{{trigger.due_date}}",
            notes: "Pay online through the link in the email.",
          },
        },
        { id: "pay_link", type: "paymongo_link", config: { amount: "{{steps.make_invoice.output.total}}", description: "Invoice {{trigger.invoice_number}}", reference: "{{trigger.invoice_number}}" } },
        {
          id: "send_invoice",
          type: "email",
          config: {
            to: "{{trigger.client_email}}",
            subject: "Invoice {{trigger.invoice_number}}",
            text: "Hi {{trigger.client_name}}, invoice {{trigger.invoice_number}} for {{steps.make_invoice.output.totalText}} is attached. Pay here: {{steps.pay_link.output.url}}",
            attachments: ["{{steps.make_invoice.output.file}}"],
          },
        },
        { id: "wait_a_week", type: "delay", config: { seconds: 604_800 } },
        { id: "check_paid", type: "payment_status", config: { link: "pay_link" } },
        { id: "is_pending", type: "condition", config: { condition: { left: "{{steps.check_paid.output.status}}", op: "eq", right: "pending" } } },
        {
          id: "remind",
          type: "email",
          config: { to: "{{trigger.client_email}}", subject: "Reminder: invoice {{trigger.invoice_number}}", text: "Hi {{trigger.client_name}}, invoice {{trigger.invoice_number}} for {{steps.make_invoice.output.totalText}} is still open. Pay here: {{steps.pay_link.output.url}}" },
        },
        { id: "wait_another_week", type: "delay", config: { seconds: 604_800 } },
        { id: "check_again", type: "payment_status", config: { link: "pay_link" } },
        { id: "still_pending", type: "condition", config: { condition: { left: "{{steps.check_again.output.status}}", op: "eq", right: "pending" } } },
        {
          id: "tell_owner",
          type: "email",
          config: { to: "owner@example.com", subject: "Invoice {{trigger.invoice_number}} is two weeks overdue", text: "{{trigger.client_name}} ({{trigger.client_email}}) has not paid invoice {{trigger.invoice_number}} ({{steps.make_invoice.output.totalText}}) after a reminder." },
        },
        { id: "tell_not_sent", type: "email", config: { to: "owner@example.com", subject: "Invoice {{trigger.invoice_number}} was not sent", text: "You turned down invoice {{trigger.invoice_number}} for {{trigger.client_name}}, so nothing went to them." } },
        { id: "tell_no_decision", type: "email", config: { to: "owner@example.com", subject: "Invoice {{trigger.invoice_number}} is waiting", text: "Nobody approved invoice {{trigger.invoice_number}} for {{trigger.client_name}} in two days, so nothing went to them. Fill in the form again to send it." } },
      ],
      edges: [
        { from: "decide", to: "make_invoice", on: "approved" },
        { from: "decide", to: "tell_not_sent", on: "rejected" },
        { from: "decide", to: "tell_no_decision", on: "timeout" },
        { from: "make_invoice", to: "pay_link" },
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
  // N23: work starts once the deposit is in. payment_status reads the payment PayMongo reported, so the run checks after
  // a day and again after three, and tells the owner if it is still unpaid.
  {
    slug: "deposit-first",
    name: "Deposit before work starts",
    description: "Fill in the form and approve the email that follows to send a client a PayMongo deposit link. When the deposit is paid, the client gets an email that work is starting. If it is still unpaid after three days, you get an email.",
    category: "Payments and receipts",
    definition: {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "client_name", label: "Client name", type: "text", required: true },
            { name: "client_email", label: "Client email", type: "email", required: true },
            { name: "project", label: "What is the work?", type: "text", required: true },
            { name: "deposit", label: "Deposit in pesos", type: "number", required: true, min: 1 },
          ],
        },
      },
      steps: [
        {
          id: "decide",
          type: "approval",
          config: { to: "owner@example.com", subject: "Ask {{trigger.client_name}} for a deposit?", message: "Deposit of {{trigger.deposit}} pesos from {{trigger.client_name}} ({{trigger.client_email}}) for:\n{{trigger.project}}\nApprove to email them the payment link.", timeoutSeconds: 172_800 },
        },
        { id: "deposit_link", type: "paymongo_link", config: { amount: "{{trigger.deposit}}", description: "Deposit: {{trigger.project}}", reference: "Deposit {{trigger.client_name}}" } },
        {
          id: "send_link",
          type: "email",
          config: { to: "{{trigger.client_email}}", subject: "Deposit for {{trigger.project}}", text: "Hi {{trigger.client_name}}, work on {{trigger.project}} starts once the {{trigger.deposit}} peso deposit is paid. Pay here: {{steps.deposit_link.output.url}}" },
        },
        { id: "wait_a_day", type: "delay", config: { seconds: 86_400 } },
        { id: "check_paid", type: "payment_status", config: { link: "deposit_link" } },
        { id: "is_paid", type: "condition", config: { condition: { left: "{{steps.check_paid.output.status}}", op: "eq", right: "paid" } } },
        {
          id: "tell_paid",
          type: "email",
          config: { to: "{{trigger.client_email}}", subject: "Deposit received: {{trigger.project}}", text: "Hi {{trigger.client_name}}, we received your {{trigger.deposit}} peso deposit. Work on {{trigger.project}} starts now." },
        },
        { id: "wait_two_days", type: "delay", config: { seconds: 172_800 } },
        { id: "check_again", type: "payment_status", config: { link: "deposit_link" } },
        { id: "paid_later", type: "condition", config: { condition: { left: "{{steps.check_again.output.status}}", op: "eq", right: "paid" } } },
        {
          id: "tell_paid_later",
          type: "email",
          config: { to: "{{trigger.client_email}}", subject: "Deposit received: {{trigger.project}}", text: "Hi {{trigger.client_name}}, we received your {{trigger.deposit}} peso deposit. Work on {{trigger.project}} starts now." },
        },
        {
          id: "tell_owner",
          type: "email",
          config: { to: "owner@example.com", subject: "No deposit yet from {{trigger.client_name}}", text: "{{trigger.client_name}} ({{trigger.client_email}}) has not paid the {{trigger.deposit}} peso deposit for {{trigger.project}} after three days." },
        },
        { id: "tell_not_sent", type: "email", config: { to: "owner@example.com", subject: "Deposit request for {{trigger.client_name}} was not sent", text: "You turned down the deposit request for {{trigger.project}}, so nothing went to {{trigger.client_name}}." } },
        { id: "tell_no_decision", type: "email", config: { to: "owner@example.com", subject: "Deposit request for {{trigger.client_name}} is waiting", text: "Nobody approved the deposit request for {{trigger.project}} in two days, so nothing went to {{trigger.client_name}}. Fill in the form again to send it." } },
      ],
      edges: [
        { from: "decide", to: "deposit_link", on: "approved" },
        { from: "decide", to: "tell_not_sent", on: "rejected" },
        { from: "decide", to: "tell_no_decision", on: "timeout" },
        { from: "deposit_link", to: "send_link" },
        { from: "send_link", to: "wait_a_day" },
        { from: "wait_a_day", to: "check_paid" },
        { from: "check_paid", to: "is_paid" },
        { from: "is_paid", to: "tell_paid", on: "true" },
        { from: "is_paid", to: "wait_two_days", on: "false" },
        { from: "wait_two_days", to: "check_again" },
        { from: "check_again", to: "paid_later" },
        { from: "paid_later", to: "tell_paid_later", on: "true" },
        { from: "paid_later", to: "tell_owner", on: "false" },
      ],
    },
  },
  // N20: two more starters, existing steps only. The Sheet is a register kymavo appends to; no step reads a sheet, so the 30-day wait runs per item from its expiry date.
  {
    slug: "renewal-reminders",
    name: "Renewal reminders",
    description: "Add each domain, hosting plan, SSL certificate, permit or insurance policy on a form. kymavo lists it in your Google Sheet and emails you 30 days before it expires.",
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
    description: "Connect your Shopify store in Apps. Each new order is added to your Google Sheet, the customer gets a receipt when the order has an email, and the owner gets a Slack note. kymavo checks Shopify's signature before anything runs.",
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
  // M1 (decision 0139): an order export from Shopee, Lazada or TikTok Shop, dropped into the watched Drive folder.
  {
    slug: "marketplace-orders-to-sheets",
    name: "Marketplace orders to Sheets",
    description: "Download your order export from Shopee, Lazada or TikTok Shop (CSV or Excel) and put it in the Google Drive folder picked in Apps. kymavo reads each order and adds it to your Google Sheet, up to 100 orders a file, then tells the team on Slack how many it added. Each column is a header from the export in lower case with _ for spaces, so Order ID is {{item.order_id}}: change the columns to match your export. An order that appears in two exports is added twice.",
    category: "Orders",
    definition: {
      trigger: { type: "drive_file", config: { requireFile: false } },
      steps: [
        { id: "read_orders", type: "read_spreadsheet", config: { fileId: "{{trigger.fileId}}" } },
        { id: "add_orders", type: "sheets", config: { rows: "{{steps.read_orders.output.rows}}", columns: ["{{item.order_id}}", "{{item.order_status}}", "{{item.product_name}}", "{{item.quantity}}", "{{item.total_amount}}"] } },
        { id: "tell_team", type: "slack", config: { text: "Added {{steps.read_orders.output.count}} orders from {{trigger.name}} to your sheet." } },
      ],
      edges: [
        { from: "read_orders", to: "add_orders" },
        { from: "add_orders", to: "tell_team" },
      ],
    },
  },
  // M1: a stock count typed as a new row in the watched tab. The row's headers are item, in_stock and reorder_at.
  {
    slug: "low-stock-alert",
    name: "Low-stock alert",
    description: "Log stock counts as new rows in the Stock tab of your Google Sheet, with the headers Item, In stock and Reorder at. When a count is at or below its reorder level, the owner gets an email.",
    category: "Orders",
    definition: {
      trigger: { type: "sheets_row", config: { tab: "Stock" } },
      steps: [
        { id: "is_low", type: "condition", config: { condition: { left: "{{trigger.cells.in_stock}}", op: "lte", right: "{{trigger.cells.reorder_at}}" } } },
        {
          id: "tell_owner",
          type: "email",
          config: { to: "owner@example.com", subject: "Low stock: {{trigger.cells.item}}", text: "{{trigger.cells.item}} is down to {{trigger.cells.in_stock}}, at or below its reorder level of {{trigger.cells.reorder_at}}. Time to restock." },
        },
        {
          id: "tell_bad_row",
          type: "email",
          config: { to: "owner@example.com", subject: "Stock row {{trigger.rowNumber}} needs a number", text: "Row {{trigger.rowNumber}} in the Stock tab ({{trigger.cells.item}}) has no number in In stock or Reorder at, so kymavo could not check it. Fix the row, then add the count again." },
        },
      ],
      edges: [
        { from: "is_low", to: "tell_owner", on: "true" },
        { from: "is_low", to: "tell_bad_row", on: "invalid" },
      ],
    },
  },
  // N22: the AI step reads the receipt photo. The photo stays in the run page; the sheet row holds only the text the model read.
  {
    slug: "receipt-expense",
    name: "Receipt to expense row",
    description: "Someone sends a receipt photo on a form. The model reads the shop, total and date, you approve, and kymavo adds a row to your Google Sheet. Needs Google Drive (a shared drive folder), Google Sheets, and an AI model that reads images (Gemini, OpenAI or OpenRouter).",
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
            message: "{{trigger.name}} sent a receipt.\nShop: {{steps.read_receipt.output.shop}}\nAmount: {{steps.read_receipt.output.amount}}\nThe photo is on the run page in kymavo.",
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
    description: "When a customer sends a GCash or bank receipt photo on Facebook Messenger or Instagram, kymavo reads the details, saves the photo, logs a pending row to Google Sheets and asks you to verify before replying. Needs Facebook Messenger & Instagram, Google Drive, Google Sheets and an AI model that reads images.",
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
  // T9 (decision 0117): the seller forwards GCash receipts to their own bot. A screenshot is never proof of payment, so
  // the row says "To check" until the owner matches it against the real GCash history.
  {
    slug: "telegram-gcash-receipts",
    name: "Log GCash receipts from Telegram",
    description: "Forward a GCash or bank receipt screenshot or PDF to your own Telegram bot. The AI step reads the reference, amount, sender and date, kymavo adds a row to your Google Sheet marked To check, and the bot replies with what it read. Needs Telegram (your bot from @BotFather, with receiving turned on), Google Sheets and an AI model that reads images.",
    category: "Payments and receipts",
    definition: {
      trigger: { type: "telegram_message", config: { from: "my_chat", requireFile: true } },
      steps: [
        {
          id: "read_receipt",
          type: "ai",
          config: {
            task: "extract",
            input: "Caption: {{trigger.text}}",
            files: ["file"],
            fields: {
              is_receipt: "Reply yes if this is a GCash, Maya or bank transfer receipt, otherwise no",
              reference: "Reference or transaction number on the receipt",
              amount: "Amount paid, digits and a decimal point only",
              sender_name: "Sender name on the receipt",
              date: "Date on the receipt as YYYY-MM-DD",
            },
          },
        },
        {
          id: "log_receipt",
          type: "sheets",
          config: { columns: ["To check", "{{steps.read_receipt.output.date}}", "{{steps.read_receipt.output.sender_name}}", "{{steps.read_receipt.output.amount}}", "{{steps.read_receipt.output.reference}}", "{{trigger.text}}"] },
        },
        {
          id: "reply",
          type: "telegram",
          config: { chatId: "{{trigger.chatId}}", text: "Logged as To check: {{steps.read_receipt.output.amount}} from {{steps.read_receipt.output.sender_name}}, reference {{steps.read_receipt.output.reference}}. {{steps.read_receipt.output.duplicate_warning}}" },
        },
      ],
      edges: [
        { from: "read_receipt", to: "log_receipt" },
        { from: "log_receipt", to: "reply" },
      ],
    },
  },
  // R3 (decision 0090): the receipt-review path. The customer pays the shop's QR Ph code or GCash number and sends the
  // transfer reference on the pay page. Staff confirm in Receipts to review. The nudge and the deadline are steps here.
  {
    slug: "booking-deposit-review",
    name: "Booking with a GCash or QR Ph deposit",
    description: "A customer asks for a time. You approve it, kymavo books it and asks for a deposit to your QR Ph code or GCash number, and the customer sends the transfer reference. You check your own GCash or bank history and confirm in Receipts to review. Unpaid after 6 hours: an SMS reminder. Unpaid after 24 hours: the slot is released and the customer is told. Needs UniSMS.",
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
          config: { to: "owner@example.com", subject: "Booking request from {{trigger.name}}", message: "{{trigger.name}} ({{trigger.phone}}) asks for {{trigger.service}} at {{trigger.appointment_at}}. If you approve, kymavo books it and asks for the deposit.", timeoutSeconds: 172_800 },
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
    description: "Your shop sends a signed order webhook. The customer gets a PayMongo checkout link (GCash when enabled for your account) and the QR Ph option. kymavo confirms the order only when a verified PayMongo payment matches it, then texts the customer once. Unpaid after a day: a reminder. Unpaid after three days: the order is cancelled and the customer is told. Needs PayMongo and UniSMS.",
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
  // C8 (decision 0126): Resort concierge and stay templates.
  {
    slug: "resort-concierge-dm",
    name: "Resort concierge for Messenger & Instagram",
    description: "Answer resort DMs using only your published knowledge sheet, save guest stay details, hand off unsure questions or staff taps to the team, and send one follow-up after 20 hours if the guest has not replied.",
    category: "Resorts and hotels",
    definition: {
      trigger: { type: "meta_dm", config: { channel: "both", requireImage: false } },
      steps: [
        { id: "check_bot_active", type: "condition", config: { condition: { left: "{{trigger.conversation.status}}", op: "neq", right: "staff" } } },
        { id: "check_staff_choice", type: "condition", config: { condition: { left: "{{trigger.choice}}", op: "eq", right: "staff" } } },
        { id: "reply_staff_choice", type: "meta_reply", config: { recipientId: "{{trigger.senderId}}", channel: "{{trigger.channel}}", text: "I'll let our team know and someone will reply here shortly." } },
        {
          id: "answer",
          type: "ai",
          config: {
            task: "answer",
            input: "Menu choice: {{trigger.choice}}\nMessage: {{trigger.text}}",
            instructions: "Answer warmly using only the resort knowledge sheet. Focus on the menu topic when a choice is given. Never invent rates or confirm room availability; ask for check-in date, nights, guests and email when ready to book.",
          },
        },
        {
          id: "save_details",
          type: "conversation_update",
          config: {
            fields: {
              check_in: "{{steps.answer.output.fields.check_in}}",
              check_out: "{{steps.answer.output.fields.check_out}}",
              guests: "{{steps.answer.output.fields.guests}}",
              name: "{{steps.answer.output.fields.name}}",
              phone: "{{steps.answer.output.fields.phone}}",
              email: "{{steps.answer.output.fields.email}}",
            },
          },
        },
        { id: "needs_staff", type: "condition", config: { condition: { left: "{{steps.answer.output.needsHuman}}", op: "eq", right: true } } },
        { id: "reply_handoff", type: "meta_reply", config: { recipientId: "{{trigger.senderId}}", channel: "{{trigger.channel}}", text: "{{steps.answer.output.reply}}\n\nOur team has been notified and will follow up here." } },
        {
          id: "reply_guest",
          type: "meta_reply",
          config: {
            recipientId: "{{trigger.senderId}}",
            channel: "{{trigger.channel}}",
            text: "{{steps.answer.output.reply}}",
            quickReplies: [
              { title: "Rooms", choice: "rooms" },
              { title: "Rates", choice: "rates" },
              { title: "Location", choice: "location" },
              { title: "Activities", choice: "activities" },
              { title: "Book a stay", choice: "book" },
              { title: "Talk to staff", choice: "staff" },
            ],
          },
        },
        { id: "wait_followup", type: "delay", config: { seconds: 72_000 } },
        {
          id: "send_followup",
          type: "meta_reply",
          config: {
            recipientId: "{{trigger.senderId}}",
            channel: "{{trigger.channel}}",
            text: "Hi again! Let us know if you would like rates for specific dates or help planning your stay.",
            quickReplies: [
              { title: "Rooms", choice: "rooms" },
              { title: "Rates", choice: "rates" },
              { title: "Location", choice: "location" },
              { title: "Activities", choice: "activities" },
              { title: "Book a stay", choice: "book" },
              { title: "Talk to staff", choice: "staff" },
            ],
          },
        },
      ],
      edges: [
        { from: "check_bot_active", to: "check_staff_choice", on: "true" },
        { from: "check_staff_choice", to: "reply_staff_choice", on: "true" },
        { from: "check_staff_choice", to: "answer", on: "false" },
        { from: "answer", to: "save_details" },
        { from: "save_details", to: "needs_staff" },
        { from: "needs_staff", to: "reply_handoff", on: "true" },
        { from: "needs_staff", to: "reply_guest", on: "false" },
        { from: "reply_guest", to: "wait_followup" },
        { from: "wait_followup", to: "send_followup" },
      ],
    },
  },
  {
    slug: "resort-concierge-email",
    name: "Resort concierge for email",
    description: "Reply to guest emails in the same thread using only your published knowledge sheet, save stay details, hand off unsure questions to staff, and send one follow-up after 24 hours.",
    category: "Resorts and hotels",
    definition: {
      trigger: { type: "email", config: {} },
      steps: [
        { id: "check_bot_active", type: "condition", config: { condition: { left: "{{trigger.conversation.status}}", op: "neq", right: "staff" } } },
        { id: "check_staff_choice", type: "condition", config: { condition: { left: "{{trigger.choice}}", op: "eq", right: "staff" } } },
        { id: "reply_staff_choice", type: "email", config: { to: "{{trigger.replyTo}}", subject: "Re: {{trigger.subject}}", text: "Thank you for writing. I've passed your message to our resort team and someone will reply shortly." } },
        {
          id: "answer",
          type: "ai",
          config: {
            task: "answer",
            input: "Menu choice: {{trigger.choice}}\nSubject: {{trigger.subject}}\nMessage: {{trigger.text}}",
            instructions: "Answer warmly using only the resort knowledge sheet. Never invent rates or confirm room availability; ask for check-in date, nights and guests when ready to book.",
          },
        },
        {
          id: "save_details",
          type: "conversation_update",
          config: {
            fields: {
              check_in: "{{steps.answer.output.fields.check_in}}",
              check_out: "{{steps.answer.output.fields.check_out}}",
              guests: "{{steps.answer.output.fields.guests}}",
              name: "{{steps.answer.output.fields.name}}",
              phone: "{{steps.answer.output.fields.phone}}",
              email: "{{steps.answer.output.fields.email}}",
            },
          },
        },
        { id: "needs_staff", type: "condition", config: { condition: { left: "{{steps.answer.output.needsHuman}}", op: "eq", right: true } } },
        { id: "reply_handoff", type: "email", config: { to: "{{trigger.replyTo}}", subject: "Re: {{trigger.subject}}", text: "{{steps.answer.output.reply}}\n\nOur team has been notified and will follow up shortly." } },
        {
          id: "reply_guest",
          type: "email",
          config: {
            to: "{{trigger.replyTo}}",
            subject: "Re: {{trigger.subject}}",
            text: "{{steps.answer.output.reply}}",
            menu: [
              { title: "Rooms", choice: "rooms" },
              { title: "Rates", choice: "rates" },
              { title: "Location", choice: "location" },
              { title: "Activities", choice: "activities" },
              { title: "Book a stay", choice: "book" },
              { title: "Talk to staff", choice: "staff" },
            ],
          },
        },
        { id: "wait_followup", type: "delay", config: { seconds: 86_400 } },
        {
          id: "send_followup",
          type: "email",
          config: {
            to: "{{trigger.replyTo}}",
            subject: "Re: {{trigger.subject}}",
            text: "Hi again! Let us know if you would like rates for specific dates or help planning your stay.",
            menu: [
              { title: "Rooms", choice: "rooms" },
              { title: "Rates", choice: "rates" },
              { title: "Location", choice: "location" },
              { title: "Activities", choice: "activities" },
              { title: "Book a stay", choice: "book" },
              { title: "Talk to staff", choice: "staff" },
            ],
          },
        },
      ],
      edges: [
        { from: "check_bot_active", to: "check_staff_choice", on: "true" },
        { from: "check_staff_choice", to: "reply_staff_choice", on: "true" },
        { from: "check_staff_choice", to: "answer", on: "false" },
        { from: "answer", to: "save_details" },
        { from: "save_details", to: "needs_staff" },
        { from: "needs_staff", to: "reply_handoff", on: "true" },
        { from: "needs_staff", to: "reply_guest", on: "false" },
        { from: "reply_guest", to: "wait_followup" },
        { from: "wait_followup", to: "send_followup" },
      ],
    },
  },
  {
    slug: "resort-deposit-and-stay",
    name: "Deposit and stay",
    description: "Started from Conversations: quote the stay from your knowledge sheet, hold the room, request the deposit with Messenger or email fallback, remind after 6 hours, expire after 48 hours if unpaid, and send pre-arrival and post-checkout emails. Needs PayMongo and UniSMS.",
    category: "Resorts and hotels",
    definition: {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "quote", type: "stay_quote", config: { room: "{{trigger.room}}", checkIn: "{{trigger.check_in}}", nights: "{{trigger.nights}}", guests: "{{trigger.guests}}" } },
        { id: "book_stay", type: "booking", config: { action: "create", mode: "stay", resource: "{{trigger.resource}}", checkIn: "{{trigger.check_in}}", nights: "{{trigger.nights}}", conversation: "{{trigger.conversation_id}}" } },
        { id: "tell_taken", type: "email", config: { to: "{{trigger.email}}", subject: "Room unavailable for {{trigger.check_in}}", text: "Hi {{trigger.name}}, sorry, {{steps.quote.output.title}} is no longer available for {{trigger.check_in}} ({{trigger.nights}} nights). Reply with another date and we will check right away." } },
        {
          id: "ask_deposit",
          type: "payment_due",
          config: {
            reference: "{{steps.book_stay.output.reference}}",
            kind: "deposit",
            amount: "{{steps.quote.output.deposit}}",
            total: "{{steps.quote.output.total}}",
            booking: "book_stay",
            checkout: true,
            channel: "sms",
            to: "{{trigger.phone}}",
            confirmedMessage: "Hi {{trigger.name}}, your deposit of {{steps.quote.output.deposit}} pesos for {{steps.quote.output.title}} ({{steps.book_stay.output.reference}}, check-in {{trigger.check_in}}) is confirmed. See you soon!",
          },
        },
        { id: "has_dm", type: "condition", config: { condition: { left: "{{trigger.senderId}}", op: "neq", right: "" } } },
        { id: "send_pay_dm", type: "meta_reply", config: { recipientId: "{{trigger.senderId}}", channel: "{{trigger.channel}}", text: "Hi {{trigger.name}}, we are holding {{steps.quote.output.title}} for {{trigger.check_in}} ({{trigger.nights}} nights, ref {{steps.book_stay.output.reference}}). Deposit is {{steps.quote.output.deposit}} pesos (total {{steps.quote.output.total}} pesos). Pay here: {{steps.ask_deposit.output.payUrl}}" } },
        { id: "send_pay_email", type: "email", config: { to: "{{trigger.email}}", subject: "Deposit request for {{steps.book_stay.output.reference}}", text: "Hi {{trigger.name}},\n\nWe are holding {{steps.quote.output.title}} for check-in on {{trigger.check_in}} ({{trigger.nights}} nights, {{trigger.guests}} guests).\nReference: {{steps.book_stay.output.reference}}\nTotal: {{steps.quote.output.total}} pesos\nDeposit due: {{steps.quote.output.deposit}} pesos\n\nPay here: {{steps.ask_deposit.output.payUrl}}" } },
        { id: "wait_reminder", type: "delay", config: { seconds: 21_600 } },
        { id: "check_paid", type: "payment_status", config: { link: "ask_deposit" } },
        { id: "still_unpaid", type: "condition", config: { condition: { left: "{{steps.check_paid.output.status}}", op: "eq", right: "pending" } } },
        { id: "remind_email", type: "email", config: { to: "{{trigger.email}}", subject: "Reminder: deposit for {{steps.book_stay.output.reference}}", text: "Hi {{trigger.name}}, friendly reminder that the {{steps.quote.output.deposit}} pesos deposit for {{steps.book_stay.output.reference}} (check-in {{trigger.check_in}}) is still pending. Pay here: {{steps.ask_deposit.output.payUrl}}" } },
        { id: "wait_deadline", type: "delay", config: { seconds: 151_200 } },
        { id: "check_deadline", type: "payment_status", config: { link: "ask_deposit" } },
        { id: "unpaid_at_deadline", type: "condition", config: { condition: { left: "{{steps.check_deadline.output.status}}", op: "eq", right: "pending" } } },
        { id: "release_stay", type: "payment_expire", config: { due: "ask_deposit" } },
        { id: "tell_released", type: "email", config: { to: "{{trigger.email}}", subject: "Hold released for {{steps.book_stay.output.reference}}", text: "Hi {{trigger.name}}, we did not receive the deposit for {{steps.book_stay.output.reference}} in time, so the hold was released. Message us any time if you would like to rebook." } },
        { id: "wait_pre_arrival", type: "delay", config: { until: "{{steps.book_stay.output.start}}", offsetSeconds: -172_800 } },
        { id: "send_pre_arrival", type: "email", config: { to: "{{trigger.email}}", subject: "Getting ready for your stay ({{steps.book_stay.output.reference}})", text: "Hi {{trigger.name}},\n\nWe look forward to welcoming you to {{steps.quote.output.title}} on {{steps.book_stay.output.checkIn}} (check-out {{steps.book_stay.output.checkOut}}, reference {{steps.book_stay.output.reference}}).\nReply to this email or message us on Messenger if you need directions or arrival help." } },
        { id: "wait_post_checkout", type: "delay", config: { until: "{{steps.book_stay.output.end}}", offsetSeconds: 86_400 } },
        { id: "send_review", type: "email", config: { to: "{{trigger.email}}", subject: "Thank you for staying with us ({{steps.book_stay.output.reference}})", text: "Hi {{trigger.name}},\n\nThank you for staying with us! We welcome honest feedback from every guest on our Google profile and Facebook page. Reply here any time if you have notes for our team." } },
      ],
      edges: [
        { from: "quote", to: "book_stay" },
        { from: "book_stay", to: "tell_taken", on: "taken" },
        { from: "book_stay", to: "ask_deposit", on: "done" },
        { from: "ask_deposit", to: "has_dm" },
        { from: "has_dm", to: "send_pay_dm", on: "true" },
        { from: "has_dm", to: "send_pay_email", on: "false" },
        { from: "send_pay_dm", to: "send_pay_email", on: "outside_window" },
        { from: "send_pay_dm", to: "send_pay_email", on: "paused" },
        { from: "send_pay_dm", to: "wait_reminder" },
        { from: "send_pay_email", to: "wait_reminder" },
        { from: "wait_reminder", to: "check_paid" },
        { from: "check_paid", to: "still_unpaid" },
        { from: "still_unpaid", to: "remind_email", on: "true" },
        { from: "still_unpaid", to: "wait_pre_arrival", on: "false" },
        { from: "remind_email", to: "wait_deadline" },
        { from: "wait_deadline", to: "check_deadline" },
        { from: "check_deadline", to: "unpaid_at_deadline" },
        { from: "unpaid_at_deadline", to: "release_stay", on: "true" },
        { from: "unpaid_at_deadline", to: "wait_pre_arrival", on: "false" },
        { from: "release_stay", to: "tell_released", on: "expired" },
        { from: "release_stay", to: "wait_pre_arrival", on: "kept" },
        { from: "wait_pre_arrival", to: "send_pre_arrival" },
        { from: "send_pre_arrival", to: "wait_post_checkout" },
        { from: "wait_post_checkout", to: "send_review" },
      ],
    },
  },
  // J1 (decision 0135): read-only Telegram assistant with multi-turn memory.
  {
    slug: "telegram-assistant",
    name: "Ask my assistant on Telegram",
    description: "Message your own Telegram bot to ask about today's Google Calendar events, kymavo bookings, open unpaid payments or today's runs. AI picks the intent, reads your workspace data (read-only), and replies in the same chat with follow-up memory. Needs Telegram (with receiving turned on) and an AI model.",
    category: "Office",
    definition: {
      trigger: { type: "telegram_message", config: { from: "my_chat", requireFile: false } },
      steps: [
        {
          id: "pick_intent",
          type: "ai",
          config: {
            task: "classify",
            input: "Recent messages: {{trigger.conversation.history}}\nLatest question: {{trigger.text}}",
            instructions: "Choose the single intent that best matches the owner's latest question, using recent messages only to understand follow-up questions.",
            labels: {
              calendar: "Questions about today's Google Calendar events or schedule",
              bookings: "Questions about today's kymavo bookings or appointments",
              payments: "Questions about open unpaid payment dues or pending balances",
              runs: "Questions about today's automation runs, failures or activity",
              all: "A daily briefing, greeting, or anything asking across multiple areas",
            },
          },
        },
        {
          id: "read_data",
          type: "assistant_read",
          config: { what: "{{steps.pick_intent.output.label}}" },
        },
        {
          id: "write_answer",
          type: "ai",
          config: {
            task: "draft",
            input: "Question: {{trigger.text}}\nConversation history: {{trigger.conversation.history}}\nToday ({{steps.read_data.output.timezone}}): {{steps.read_data.output.date}}\nWorkspace summary:\n{{steps.read_data.output.summaryText}}",
            instructions: "You are kymavo's read-only assistant answering the workspace owner on Telegram. Answer using only the workspace summary in the data block. Never invent events, bookings, amounts or run statuses, and never claim to book, cancel, pay or change anything. If Google Calendar is not connected, say they can connect it in Apps. Reply concisely in under 2,500 characters in the owner's language (English, Tagalog or Taglish).",
          },
        },
        {
          id: "reply",
          type: "telegram",
          config: { chatId: "{{trigger.chatId}}", text: "kymavo assistant:\n{{steps.write_answer.output.draft}}" },
        },
      ],
      edges: [
        { from: "pick_intent", to: "read_data" },
        { from: "read_data", to: "write_answer" },
        { from: "write_answer", to: "reply" },
      ],
    },
  },
] as const;
