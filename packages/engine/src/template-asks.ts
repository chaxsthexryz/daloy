import { definitionSchema, type Step, type WorkflowDefinition } from "./definition";
import type { Language } from "./language";

export type AskType = "text" | "textarea" | "email" | "number" | "select" | "boolean" | "approver";

export type AskTarget =
  | { kind: "step"; stepId: string; field: string; allOwnerEmails?: boolean }
  | { kind: "trigger"; field: string }
  | { kind: "stepNote"; stepId: string };

export type LocalizedText = { en: string; tl: string };

export type TemplateAsk = {
  key: string;
  type: AskType;
  label: LocalizedText;
  help?: LocalizedText;
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: { value: string; label: LocalizedText }[];
  targets: AskTarget[];
};

export type AskAnswerValue = string | number | boolean;
export type AskAnswers = Record<string, AskAnswerValue>;

const tx = (en: string, tl: string): LocalizedText => ({ en, tl });

const approverAsk = (key: string, targets: AskTarget[], en = "Who approves requests", tl = "Sino ang mag-a-approve ng mga request"): TemplateAsk => ({
  key,
  type: "approver",
  label: tx(en, tl),
  required: true,
  targets,
});

const emailAsk = (key: string, targets: AskTarget[], en: string, tl: string): TemplateAsk => ({
  key,
  type: "email",
  label: tx(en, tl),
  required: true,
  targets,
});

const textAsk = (key: string, targets: AskTarget[], en: string, tl: string, multiline = false): TemplateAsk => ({
  key,
  type: multiline ? "textarea" : "text",
  label: tx(en, tl),
  required: true,
  targets,
});

export const TEMPLATE_ASKS: Record<string, TemplateAsk[]> = {
  "inquiry-triage": [
    emailAsk("billingEmail", [{ kind: "step", stepId: "to_billing", field: "to" }], "Where should billing questions go?", "Saan ipapadala ang mga tanong sa billing?"),
    emailAsk("supportEmail", [{ kind: "step", stepId: "to_support", field: "to" }], "Where should other inquiries go?", "Saan ipapadala ang ibang inquiries?"),
    textAsk("ackText", [{ kind: "step", stepId: "acknowledge", field: "text" }], "Auto-reply to the sender", "Awtomatikong sagot sa nagpadala", true),
  ],
  "invoice-follow-up": [
    textAsk("statusUrl", [{ kind: "step", stepId: "check_status", field: "url" }], "Invoice status link to check", "Link ng status ng invoice na titingnan"),
    {
      key: "waitSeconds",
      type: "select",
      label: tx("How long to wait before reminding", "Gaano katagal maghihintay bago magpaalala"),
      options: [
        { value: "259200", label: tx("3 days", "3 araw") },
        { value: "604800", label: tx("7 days", "7 araw") },
        { value: "1209600", label: tx("14 days", "14 araw") },
      ],
      targets: [{ kind: "step", stepId: "wait_a_week", field: "seconds" }],
    },
    textAsk("reminderText", [{ kind: "step", stepId: "remind", field: "text" }], "Reminder message", "Mensahe ng paalala", true),
  ],
  "no-show-follow-up": [
    {
      key: "waitSeconds",
      type: "select",
      label: tx("How soon to send the rebook link", "Gaano kabilis ipadala ang rebook link"),
      options: [
        { value: "1800", label: tx("30 minutes after", "30 minuto pagkatapos") },
        { value: "3600", label: tx("1 hour after", "1 oras pagkatapos") },
        { value: "86400", label: tx("Next day (24 hours)", "Kinabukasan (24 oras)") },
      ],
      targets: [{ kind: "step", stepId: "wait_an_hour", field: "seconds" }],
    },
    textAsk("rebookText", [{ kind: "step", stepId: "offer_rebook", field: "text" }], "Rebooking email wording", "Mensahe ng email para mag-book ulit", true),
  ],
  "appointment-reminder": [
    {
      key: "offsetSeconds",
      type: "select",
      label: tx("When to send the reminder", "Kailan ipapadala ang paalala"),
      options: [
        { value: "-86400", label: tx("1 day before", "1 araw bago") },
        { value: "-43200", label: tx("12 hours before", "12 oras bago") },
        { value: "-7200", label: tx("2 hours before", "2 oras bago") },
      ],
      targets: [{ kind: "step", stepId: "wait_for_day_before", field: "offsetSeconds" }],
    },
    textAsk("reminderText", [{ kind: "step", stepId: "remind", field: "text" }], "Reminder email wording", "Mensahe ng paalala sa email", true),
  ],
  "request-to-sheets": [
    textAsk("receiptSubject", [{ kind: "step", stepId: "send_receipt", field: "subject" }], "Receipt email subject", "Paksa ng receipt email"),
    textAsk("receiptText", [{ kind: "step", stepId: "send_receipt", field: "text" }], "Receipt message to the requester", "Mensahe ng resibo sa nag-request", true),
  ],
  "lead-to-booking": [
    approverAsk("approverEmail", [{ kind: "step", stepId: "decide", field: "to" }, { kind: "step", stepId: "tell_owner", field: "to" }, { kind: "step", stepId: "tell_no_decision", field: "to" }], "Who approves booking requests", "Sino ang mag-a-approve ng booking requests"),
    textAsk("confirmText", [{ kind: "step", stepId: "confirm", field: "text" }], "Confirmation message when booked", "Mensahe ng kumpirmasyon kapag na-book", true),
    textAsk("declinedText", [{ kind: "step", stepId: "tell_declined", field: "text" }], "Message if declined", "Mensahe kapag tinanggihan", true),
  ],
  "order-to-sheets": [
    approverAsk("approverEmail", [{ kind: "step", stepId: "approve_price", field: "to" }, { kind: "step", stepId: "tell_no_decision", field: "to" }], "Who checks the order price", "Sino ang magche-check ng presyo ng order"),
    textAsk("linkText", [{ kind: "step", stepId: "send_link", field: "text" }], "Payment link email to the buyer", "Email na may payment link sa buyer", true),
    textAsk("declinedText", [{ kind: "step", stepId: "tell_declined", field: "text" }], "Message if declined", "Mensahe kapag hindi na-approve", true),
  ],
  "order-paid": [
    textAsk("sheetNote", [{ kind: "stepNote", stepId: "log_paid" }], "Label or note for your paid orders log", "Label o tala para sa paid orders log mo"),
  ],
  "invoice-paymongo": [
    emailAsk("ownerEmail", [{ kind: "step", stepId: "tell_owner", field: "to" }], "Where to send overdue alerts", "Saan ipapadala ang overdue alerts"),
    textAsk("invoiceText", [{ kind: "step", stepId: "send_invoice", field: "text" }], "First invoice message", "Unang mensahe ng invoice", true),
    textAsk("reminderText", [{ kind: "step", stepId: "remind", field: "text" }], "Follow-up reminder wording", "Mensahe ng paalala", true),
  ],
  "invoice-pdf": [
    textAsk("businessName", [{ kind: "step", stepId: "make_invoice", field: "businessName" }], "Business name on the PDF invoice", "Pangalan ng negosyo sa PDF invoice"),
    approverAsk("approverEmail", [{ kind: "step", stepId: "decide", field: "to" }, { kind: "step", stepId: "tell_owner", field: "to" }, { kind: "step", stepId: "tell_not_sent", field: "to" }, { kind: "step", stepId: "tell_no_decision", field: "to" }], "Who approves before sending the PDF", "Sino ang mag-a-approve bago ipadala ang PDF"),
    textAsk("invoiceText", [{ kind: "step", stepId: "send_invoice", field: "text" }], "Invoice email wording", "Mensahe sa invoice email", true),
  ],
  "quote-deposit": [
    approverAsk("approverEmail", [{ kind: "step", stepId: "decide", field: "to" }, { kind: "step", stepId: "tell_no_decision", field: "to" }], "Who approves quotes", "Sino ang mag-a-approve ng quotes"),
    textAsk("depositText", [{ kind: "step", stepId: "send_deposit", field: "text" }], "Approved quote and deposit message", "Mensahe kapag na-approve ang quote at deposito", true),
    textAsk("declinedText", [{ kind: "step", stepId: "tell_declined", field: "text" }], "Message if declined", "Mensahe kapag tinanggihan", true),
  ],
  "deposit-first": [
    approverAsk("approverEmail", [{ kind: "step", stepId: "decide", field: "to" }, { kind: "step", stepId: "tell_owner", field: "to" }, { kind: "step", stepId: "tell_not_sent", field: "to" }, { kind: "step", stepId: "tell_no_decision", field: "to" }], "Who approves deposit requests", "Sino ang mag-a-approve ng hiling na deposito"),
    textAsk("linkText", [{ kind: "step", stepId: "send_link", field: "text" }], "Deposit link email wording", "Mensahe para sa deposit link email", true),
    textAsk("paidText", [{ kind: "step", stepId: "tell_paid", field: "text" }], "Confirmation once deposit is paid", "Kumpirmasyon kapag bayad na ang deposito", true),
  ],
  "renewal-reminders": [
    {
      key: "offsetSeconds",
      type: "select",
      label: tx("How far ahead to remind", "Gaano kaaga magpapaalala"),
      options: [
        { value: "-2592000", label: tx("30 days before", "30 araw bago") },
        { value: "-1209600", label: tx("14 days before", "14 araw bago") },
        { value: "-604800", label: tx("7 days before", "7 araw bago") },
      ],
      targets: [{ kind: "step", stepId: "wait_until_30_days_before", field: "offsetSeconds" }],
    },
    textAsk("reminderText", [{ kind: "step", stepId: "remind", field: "text" }], "Renewal reminder message", "Mensahe ng paalala sa renewal", true),
  ],
  "store-orders": [
    textAsk("receiptSubject", [{ kind: "step", stepId: "send_receipt", field: "subject" }], "Order receipt subject", "Paksa ng resibo ng order"),
    textAsk("receiptText", [{ kind: "step", stepId: "send_receipt", field: "text" }], "Order receipt message", "Mensahe ng resibo ng order", true),
    textAsk("slackText", [{ kind: "step", stepId: "tell_owner", field: "text" }], "Team Slack note wording", "Mensahe sa Slack para sa team"),
  ],
  "shopify-orders": [
    textAsk("receiptSubject", [{ kind: "step", stepId: "send_receipt", field: "subject" }], "Order confirmation subject", "Paksa ng kumpirmasyon ng order"),
    textAsk("receiptText", [{ kind: "step", stepId: "send_receipt", field: "text" }], "Order confirmation message", "Mensahe ng kumpirmasyon ng order", true),
    textAsk("slackText", [{ kind: "step", stepId: "tell_owner", field: "text" }], "Team Slack alert wording", "Mensahe sa Slack alert"),
  ],
  "marketplace-orders-to-sheets": [
    textAsk("slackText", [{ kind: "step", stepId: "tell_team", field: "text" }], "Team summary message after importing rows", "Mensahe sa team pagkatapos mag-import ng rows"),
  ],
  "low-stock-alert": [
    emailAsk("ownerEmail", [{ kind: "step", stepId: "tell_owner", field: "to" }, { kind: "step", stepId: "tell_bad_row", field: "to" }], "Who receives low-stock alerts", "Sino ang tatanggap ng low-stock alerts"),
    textAsk("alertSubject", [{ kind: "step", stepId: "tell_owner", field: "subject" }], "Alert email subject", "Paksa ng alert email"),
  ],
  "receipt-expense": [
    approverAsk("approverEmail", [{ kind: "step", stepId: "approve", field: "to" }, { kind: "step", stepId: "tell_no_decision", field: "to" }], "Who approves expenses", "Sino ang mag-a-approve ng gastos"),
    textAsk("approvedText", [{ kind: "step", stepId: "tell_approved", field: "text" }], "Reply when approved", "Sagot kapag na-approve", true),
    textAsk("rejectedText", [{ kind: "step", stepId: "tell_rejected", field: "text" }], "Reply when rejected", "Sagot kapag tinanggihan", true),
  ],
  "meta-receipt-intake": [
    approverAsk("approverEmail", [{ kind: "step", stepId: "approve", field: "approver" }], "Who confirms the receipt", "Sino ang magkukumpirma ng resibo"),
    emailAsk("timeoutEmail", [{ kind: "step", stepId: "notify_timeout", field: "to" }], "Who to notify if nobody decides", "Sino ang sasabihan kung walang nagpasya"),
    textAsk("confirmedText", [{ kind: "step", stepId: "reply_confirmed", field: "text" }], "DM reply when confirmed", "Sagot sa DM kapag kumpirmado", true),
    textAsk("rejectedText", [{ kind: "step", stepId: "reply_rejected", field: "text" }], "DM reply when rejected", "Sagot sa DM kapag tinanggihan", true),
  ],
  "telegram-gcash-receipts": [
    textAsk("replyText", [{ kind: "step", stepId: "reply", field: "text" }], "Telegram reply after logging the receipt", "Sagot sa Telegram pagkatapos itala ang resibo", true),
  ],
  "booking-deposit-review": [
    approverAsk("approverEmail", [{ kind: "step", stepId: "decide", field: "to" }], "Who approves booking requests", "Sino ang mag-a-approve ng booking"),
    textAsk("depositAmount", [{ kind: "step", stepId: "ask_deposit", field: "amount" }], "Deposit amount (pesos)", "Halaga ng deposito (piso)"),
    textAsk("totalAmount", [{ kind: "step", stepId: "ask_deposit", field: "total" }], "Full price (pesos)", "Buong presyo (piso)"),
    textAsk("payLinkSms", [{ kind: "step", stepId: "send_pay_link", field: "message" }], "SMS with the payment link", "SMS na may payment link", true),
  ],
  "order-gcash-checkout": [
    textAsk("checkoutSms", [{ kind: "step", stepId: "send_checkout", field: "message" }], "SMS sent with the payment link", "SMS na ipapadala kasama ang payment link", true),
    textAsk("reminderSms", [{ kind: "step", stepId: "remind", field: "message" }], "Unpaid reminder SMS", "SMS na paalala kapag hindi pa bayad", true),
  ],
  "lalamove-confirmed-order": [
    textAsk("pickupAddress", [{ kind: "step", stepId: "book_rider", field: "pickupAddress" }], "Pick-up address (shop or kitchen)", "Address ng pick-up (tindahan o kusina)"),
    textAsk("senderName", [{ kind: "step", stepId: "book_rider", field: "senderName" }], "Sender name for the rider", "Pangalan ng nagpapadala para sa rider"),
    textAsk("senderPhone", [{ kind: "step", stepId: "book_rider", field: "senderPhone" }], "Sender mobile number (09...)", "Mobile number ng nagpapadala (09...)"),
    textAsk("trackingSms", [{ kind: "step", stepId: "send_tracking", field: "message" }], "SMS tracking message to customer", "SMS tracking message sa customer", true),
  ],
  "resort-concierge-dm": [
    {
      key: "followupSeconds",
      type: "select",
      label: tx("Follow-up delay if guest goes quiet", "Oras ng paghihintay bago mag-follow up"),
      options: [
        { value: "21600", label: tx("6 hours", "6 oras") },
        { value: "43200", label: tx("12 hours", "12 oras") },
        { value: "72000", label: tx("20 hours", "20 oras") },
      ],
      targets: [{ kind: "step", stepId: "wait_followup", field: "seconds" }],
    },
    textAsk("handoffText", [{ kind: "step", stepId: "reply_handoff", field: "text" }], "Reply when passing to staff", "Sagot kapag ipapasa sa staff", true),
    textAsk("followupText", [{ kind: "step", stepId: "send_followup", field: "text" }], "Gentle follow-up message", "Magalang na follow-up message", true),
  ],
  "resort-concierge-email": [
    {
      key: "followupSeconds",
      type: "select",
      label: tx("Follow-up delay if guest goes quiet", "Oras ng paghihintay bago mag-follow up"),
      options: [
        { value: "21600", label: tx("6 hours", "6 oras") },
        { value: "43200", label: tx("12 hours", "12 oras") },
        { value: "72000", label: tx("20 hours", "20 oras") },
      ],
      targets: [{ kind: "step", stepId: "wait_followup", field: "seconds" }],
    },
    textAsk("handoffText", [{ kind: "step", stepId: "reply_handoff", field: "text" }], "Reply when passing to staff", "Sagot kapag ipapasa sa staff", true),
    textAsk("followupText", [{ kind: "step", stepId: "send_followup", field: "text" }], "Follow-up email wording", "Mensahe ng follow-up email", true),
  ],
  "resort-deposit-and-stay": [
    textAsk("payEmailText", [{ kind: "step", stepId: "send_pay_email", field: "text" }], "Deposit request email", "Email para humingi ng deposito", true),
    textAsk("preArrivalText", [{ kind: "step", stepId: "send_pre_arrival", field: "text" }], "Pre-arrival check-in message", "Mensahe bago dumating ang bisita", true),
    textAsk("reviewText", [{ kind: "step", stepId: "send_review", field: "text" }], "Post-checkout thank-you message", "Pasasalamat pagkatapos ng checkout", true),
  ],
  "telegram-assistant": [
    textAsk("assistantNote", [{ kind: "stepNote", stepId: "write_answer" }], "What to focus on in your daily replies", "Ano ang dapat unahin sa mga sagot"),
  ],
  "freelancer-lead-crm": [
    emailAsk("ownerEmail", [{ kind: "step", stepId: "alert_hot", field: "to" }, { kind: "step", stepId: "tell_warm", field: "to" }, { kind: "step", stepId: "tell_other", field: "to" }], "Where to send qualified lead alerts", "Saan ipapadala ang lead alerts"),
    textAsk("receiptText", [{ kind: "step", stepId: "send_receipt", field: "text" }], "Auto-reply to the client", "Awtomatikong sagot sa kliyente", true),
  ],
  "freelancer-client-onboarding": [
    emailAsk("ownerEmail", [{ kind: "step", stepId: "tell_owner", field: "to" }], "Where to notify you of new onboardings", "Saan ka sasabihan kapag may bagong kliyente"),
    textAsk("welcomeSubject", [{ kind: "step", stepId: "send_welcome", field: "subject" }], "Welcome email subject", "Paksa ng welcome email"),
    textAsk("welcomeText", [{ kind: "step", stepId: "send_welcome", field: "text" }], "Welcome email wording", "Mensahe ng welcome email", true),
  ],
  "client-brief-to-trello": [
    textAsk("receiptSubject", [{ kind: "step", stepId: "send_receipt", field: "subject" }], "Confirmation subject to client", "Paksa ng kumpirmasyon sa kliyente"),
    textAsk("receiptText", [{ kind: "step", stepId: "send_receipt", field: "text" }], "Confirmation message to client", "Mensahe ng kumpirmasyon sa kliyente", true),
  ],
  "meeting-prep-telegram": [
    textAsk("telegramText", [{ kind: "step", stepId: "notify_telegram", field: "text" }], "Telegram reminder format", "Format ng paalala sa Telegram", true),
  ],
  "drive-doc-to-notion-summary": [
    emailAsk("ownerEmail", [{ kind: "step", stepId: "email_owner", field: "to" }], "Who receives the summary email", "Sino ang tatanggap ng summary email"),
    textAsk("emailSubject", [{ kind: "step", stepId: "email_owner", field: "subject" }], "Summary email subject", "Paksa ng summary email"),
  ],
  "daily-morning-briefing": [
    {
      key: "cron",
      type: "select",
      label: tx("When to send the briefing", "Kailan ipapadala ang briefing"),
      options: [
        { value: "0 8 * * 1-5", label: tx("Weekdays at 8:00 AM", "Lunes-Biyernes alas-8 ng umaga") },
        { value: "0 7 * * 1-5", label: tx("Weekdays at 7:00 AM", "Lunes-Biyernes alas-7 ng umaga") },
        { value: "0 9 * * *", label: tx("Every day at 9:00 AM", "Araw-araw alas-9 ng umaga") },
      ],
      targets: [{ kind: "trigger", field: "cron" }],
    },
    textAsk("telegramText", [{ kind: "step", stepId: "send_brief", field: "text" }], "Briefing message wrapper", "Mensahe ng briefing", true),
  ],
  "email-ai-triage-draft": [
    emailAsk("urgentEmail", [{ kind: "step", stepId: "alert_urgent", field: "to" }], "Where to send urgent emails", "Saan ipapadala ang urgent emails"),
    emailAsk("salesEmail", [{ kind: "step", stepId: "send_sales", field: "to" }], "Where to send sales emails", "Saan ipapadala ang sales emails"),
    emailAsk("generalEmail", [{ kind: "step", stepId: "send_general", field: "to" }], "Where to send general emails", "Saan ipapadala ang general emails"),
  ],
  "whatsapp-inquiry-to-sheets": [
    textAsk("replyText", [{ kind: "step", stepId: "reply_customer", field: "text" }], "WhatsApp reply to the customer", "Sagot sa WhatsApp sa customer", true),
    textAsk("slackText", [{ kind: "step", stepId: "notify_team", field: "text" }], "Team Slack notification", "Abiso sa team sa Slack"),
  ],
  "customer-feedback-triage": [
    emailAsk("ownerEmail", [{ kind: "step", stepId: "alert_owner", field: "to" }], "Who receives issue alerts", "Sino ang tatanggap ng alerts kapag may problema"),
    textAsk("thanksText", [{ kind: "step", stepId: "send_thanks", field: "text" }], "Thank-you email to the customer", "Pasasalamat na email sa customer", true),
    textAsk("slackText", [{ kind: "step", stepId: "share_win", field: "text" }], "Positive feedback Slack note", "Note sa Slack para sa magandang feedback"),
  ],
  "competitor-price-watch": [
    textAsk("watchUrl", [{ kind: "trigger", field: "url" }], "Page URL to watch", "Link ng page na babantayan"),
    emailAsk("ownerEmail", [{ kind: "step", stepId: "email_owner", field: "to" }], "Who receives price change emails", "Sino ang tatanggap ng email kapag nagbago ang presyo"),
    textAsk("slackText", [{ kind: "step", stepId: "notify_slack", field: "text" }], "Slack alert wording", "Mensahe ng alert sa Slack"),
  ],
  "rss-news-to-discord": [
    textAsk("feedUrl", [{ kind: "trigger", field: "url" }], "RSS or Atom feed URL", "Link ng RSS o Atom feed"),
    textAsk("discordText", [{ kind: "step", stepId: "post_discord", field: "text" }], "Discord post format", "Format ng post sa Discord", true),
  ],
  "trello-status-to-teams": [
    textAsk("teamsText", [{ kind: "step", stepId: "post_teams", field: "text" }], "Teams channel message format", "Format ng mensahe sa Teams channel", true),
  ],
};

function targetExists(def: WorkflowDefinition, target: AskTarget): boolean {
  if (target.kind === "trigger") {
    return target.field in (def.trigger.config as Record<string, unknown>);
  }
  const step = def.steps.find((s) => s.id === target.stepId);
  if (!step) return false;
  if (target.kind === "stepNote") return true;
  return target.field in (step.config as Record<string, unknown>);
}

/** Derives owner questions for a template slug, or falls back to inspecting any draft's editable fields. */
export function asksForTemplate(slug: string | undefined, def: WorkflowDefinition): TemplateAsk[] {
  if (slug && TEMPLATE_ASKS[slug]) {
    const curated = TEMPLATE_ASKS[slug]!.filter((a) => a.targets.some((t) => targetExists(def, t)));
    if (curated.length > 0) return curated;
  }

  const out: TemplateAsk[] = [];
  const approval = def.steps.find((s) => s.type === "approval");
  if (approval && approval.type === "approval") {
    if ("approver" in approval.config && approval.config.approver) {
      out.push(approverAsk("approverEmail", [{ kind: "step", stepId: approval.id, field: "approver" }]));
    } else if ("to" in approval.config) {
      out.push(approverAsk("approverEmail", [{ kind: "step", stepId: approval.id, field: "to" }]));
    }
  }

  const ownerEmailSteps = def.steps.filter((s) => {
    if (s.id === approval?.id) return false;
    const cfg = s.config as Record<string, unknown>;
    return typeof cfg.to === "string" && !cfg.to.includes("{{");
  });
  if (ownerEmailSteps.length > 0) {
    out.push(
      emailAsk(
        "notifyEmail",
        ownerEmailSteps.map((s) => ({ kind: "step", stepId: s.id, field: "to" })),
        "Who should receive notifications",
        "Sino ang dapat makatanggap ng mga abiso",
      ),
    );
  }

  const msgStep = def.steps.find((s) => {
    if (s.type === "email" || s.type === "outlook") return String((s.config as { to?: string }).to ?? "").includes("{{");
    return s.type === "sms" || s.type === "meta_reply" || s.type === "whatsapp_reply" || s.type === "telegram" || s.type === "slack";
  });
  if (msgStep) {
    const cfg = msgStep.config as Record<string, unknown>;
    const field = "message" in cfg ? "message" : "text";
    if (typeof cfg[field] === "string") {
      out.push(textAsk("replyText", [{ kind: "step", stepId: msgStep.id, field }], "Message wording", "Nilalaman ng mensahe", true));
    }
  }

  if (out.length === 0 && def.steps.length > 0) {
    out.push(textAsk("flowNote", [{ kind: "stepNote", stepId: def.steps[0]!.id }], "Note for your team", "Tala para sa team mo"));
  }
  return out;
}

function readTargetValue(def: WorkflowDefinition, target: AskTarget): AskAnswerValue | undefined {
  if (target.kind === "trigger") {
    const val = (def.trigger.config as Record<string, unknown>)[target.field];
    return typeof val === "string" || typeof val === "number" || typeof val === "boolean" ? val : undefined;
  }
  const step = def.steps.find((s) => s.id === target.stepId);
  if (!step) return undefined;
  if (target.kind === "stepNote") return step.note ?? "";
  const val = (step.config as Record<string, unknown>)[target.field];
  return typeof val === "string" || typeof val === "number" || typeof val === "boolean" ? val : undefined;
}

export function defaultAskAnswers(
  asks: TemplateAsk[],
  ctx: { ownerEmail: string; businessName?: string | null; workflowName?: string },
): AskAnswers {
  const answers: AskAnswers = {};
  for (const ask of asks) {
    if (ask.defaultValue !== undefined) {
      answers[ask.key] = ask.defaultValue;
    } else if (ask.type === "email" || ask.type === "approver") {
      answers[ask.key] = ctx.ownerEmail;
    } else if (ask.key === "businessName" && ctx.businessName) {
      answers[ask.key] = ctx.businessName;
    } else if (ask.options?.length) {
      answers[ask.key] = ask.options[0]!.value;
    } else {
      answers[ask.key] = "";
    }
  }
  return answers;
}

/** Populates initial answers from an existing draft definition + workspace context. */
export function answersFromDefinition(
  def: WorkflowDefinition,
  asks: TemplateAsk[],
  ctx: { ownerEmail: string; businessName?: string | null },
  saved: AskAnswers = {},
): AskAnswers {
  const out: AskAnswers = {};
  for (const ask of asks) {
    if (saved[ask.key] !== undefined && saved[ask.key] !== "") {
      out[ask.key] = saved[ask.key]!;
      continue;
    }
    const existing = ask.targets.map((t) => readTargetValue(def, t)).find((v) => v !== undefined);
    let val = existing;
    if (typeof val === "string" && (val === "owner@example.com" || val === "billing@example.com" || val === "support@example.com")) {
      val = ctx.ownerEmail;
    }
    if (ask.key === "businessName" && (!val || val === "My business") && ctx.businessName) {
      val = ctx.businessName;
    }
    if (val === undefined || val === "") {
      val = ask.defaultValue ?? (ask.type === "email" || ask.type === "approver" ? ctx.ownerEmail : ask.options?.[0]?.value ?? "");
    }
    out[ask.key] = ask.type === "select" ? String(val) : val;
  }
  return out;
}

/** Applies wizard answers into a copy of `def` and returns a validated WorkflowDefinition. */
export function applyAskAnswers(def: WorkflowDefinition, asks: TemplateAsk[], answers: AskAnswers): WorkflowDefinition {
  const next = structuredClone(def);
  for (const ask of asks) {
    const raw = answers[ask.key];
    if (raw === undefined) continue;
    const strVal = String(raw).trim();
    if (ask.required && !strVal && ask.type !== "boolean") continue;
    for (const target of ask.targets) {
      if (target.kind === "trigger") {
        const cfg = next.trigger.config as Record<string, unknown>;
        const cur = cfg[target.field];
        cfg[target.field] = typeof cur === "number" ? Number(raw) : raw;
        continue;
      }
      const step = next.steps.find((s) => s.id === target.stepId) as Step | undefined;
      if (!step) continue;
      if (target.kind === "stepNote") {
        const trimmed = strVal.slice(0, 300);
        if (trimmed) step.note = trimmed;
        else delete step.note;
        continue;
      }
      const cfg = step.config as Record<string, unknown>;
      const cur = cfg[target.field];
      if (typeof cur === "number" || target.field === "seconds" || target.field === "offsetSeconds") {
        const num = Number(raw);
        if (Number.isFinite(num)) cfg[target.field] = num;
      } else {
        cfg[target.field] = typeof raw === "boolean" ? raw : String(raw);
      }
    }
  }
  return definitionSchema.parse(next);
}

export function askLabel(ask: TemplateAsk, language: Language): string {
  return ask.label[language];
}
