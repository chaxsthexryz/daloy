import * as z from "zod";
import { aiConfigSchema } from "./ai";
import { browserConfigSchema } from "./browser";
import { DISCORD_MAX_CHARS, DOCS_MAX_VALUES, isPlaceholderKey } from "./discord-docs";
import { FILES_PER_FIELD, type FileRef } from "./file-type";
import { CLOCK_TIME_RE } from "./knowledge";
import { menuSchema } from "./menu";
import { SENDER_ID_RE } from "./phone";
import { isTimeZone, parseZoned } from "./zoned";

// Ids end up inside expression paths ({{steps.<id>.output}}), so keep them to a safe charset.
const stepId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "step ids use a-z, 0-9 and _, starting with a letter");

export const conditionSchema = z.object({
  left: z.string().max(1000),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists"]),
  right: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

// String fields are templates: {{trigger...}}, {{steps...}} and {{secrets...}} are resolved when the step runs.
const template = (max: number) => z.string().max(max);

export const httpConfigSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: template(2000).min(1),
  headers: z
    .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "header names use letters, digits and -"), template(2000))
    .refine((h) => Object.keys(h).length <= 20, "at most 20 headers")
    .default({}),
  body: template(100_000).optional(),
  // Safe to send twice. Unset, GET, PUT and DELETE are; POST and PATCH are not (decision 0030).
  idempotent: z.boolean().optional(),
});

export const emailConfigSchema = z.object({
  // Comma-separated; the worker checks each address and the recipient cap after resolving the template.
  to: template(2000).min(1),
  subject: template(500).min(1),
  text: template(50_000).min(1),
  // The same menu as the Messenger buttons, added below the text as a numbered list; a reply of "2" picks choice 2 (decision 0118).
  menu: menuSchema.optional().describe("Choices listed under the message as 1, 2, 3. A reply with just the number picks that choice."),
});

// A fixed wait, or until a time from the run (a datetime field) moved by offsetSeconds. A wake-up time that has
// passed takes the "late" edge, or ends the run when there is none (decision 0031).
export const delayConfigSchema = z
  .object({
    seconds: z.int().min(1).max(2_592_000).optional(),
    until: template(500)
      .min(1)
      .optional()
      .describe("A date and time with an offset, such as {{trigger.appointment_at}} from a datetime field. If it has passed when the step runs, the run ends here, or takes the step's late edge when it has one."),
    offsetSeconds: z.int().min(-2_592_000).max(2_592_000).optional().describe("Seconds after the until time; negative is before it, e.g. -3600 for an hour before."),
  })
  .superRefine((c, ctx) => {
    if ((c.seconds === undefined) === (c.until === undefined)) ctx.addIssue({ code: "custom", path: ["seconds"], message: "set either seconds or until" });
    if (c.offsetSeconds !== undefined && c.until === undefined) ctx.addIssue({ code: "custom", path: ["offsetSeconds"], message: "offsetSeconds needs until" });
  });
export type HttpConfig = z.infer<typeof httpConfigSchema>;
export const isIdempotent = (cfg: Pick<HttpConfig, "method" | "idempotent">) => cfg.idempotent ?? ["GET", "PUT", "DELETE"].includes(cfg.method);
export type EmailConfig = z.infer<typeof emailConfigSchema>;

// The approver gets an email with a single-use link. timeoutSeconds later, an unanswered approval takes the timeout branch.
// With `approver` set, only that workspace member can decide, signed in, and the link goes to their sign-in email
// (decision 0022). Without it, `to` gets a link that whoever holds it can use (decision 0009). The approver is a plain
// email, not a template, so publishing can check that it names a member who may approve.
export const approvalConfigSchema = z
  .object({
    to: template(2000).min(1).optional(),
    approver: z.email().max(254).transform((s) => s.toLowerCase()).optional(),
    subject: template(500).min(1),
    message: template(10_000).min(1),
    timeoutSeconds: z.int().min(60).max(2_592_000),
  })
  .refine((c) => c.to !== undefined || c.approver !== undefined, { message: "set a recipient (to) or a named approver", path: ["to"] });
export type ApprovalConfig = z.infer<typeof approvalConfigSchema>;

// Sheets and Slack go to the destination the owner picked in Apps (decision 0021). The worker queues them
// as deliveries, so the run carries on and each one is retried on its own. The row starts with the request reference
// and the time, then these columns. Keep private details out of Slack text: everyone in the channel can read it.
export const sheetsConfigSchema = z.object({ columns: z.array(template(2000)).min(1).max(20) });
export const slackConfigSchema = z.object({ text: template(3000).min(1) });
// Outlook mail is sent from the mailbox the owner consented with, and a Teams note goes to the channel their Teams
// workflow posts to (decision 0023). Both are queued deliveries too. A Teams note is a notification only: approvals
// are answered in kymavo by the named approver.
export const outlookConfigSchema = emailConfigSchema;
export const teamsConfigSchema = slackConfigSchema;
// A Telegram message goes to the one chat picked in Apps, as plain text (decision 0042). Queued like Slack.
// chatId (T9) answers the person who messaged the bot: it must render to the chat of the run's Telegram message.
export const telegramConfigSchema = slackConfigSchema.extend({
  chatId: template(200).min(1).optional(),
});
// Philippine SMS through UniSMS (phase N7, decision 0074). Queued as a delivery with needs_review on unknown outcomes.
export const smsConfigSchema = z.object({
  to: template(500).min(1).describe("Philippine mobile number (+639XXXXXXXXX, 639XXXXXXXXX or 09XXXXXXXXX) or a template such as {{trigger.phone}}."),
  message: template(2500).min(1).describe("SMS text. The rendered message must be at most 670 characters."),
  senderId: z.string().trim().min(1).max(11).regex(SENDER_ID_RE, "Sender ID uses up to 11 letters, digits, spaces, - or _").optional().describe("Optional registered Sender ID. Leave empty to use the connected default."),
});
export type SmsConfig = z.infer<typeof smsConfigSchema>;
// A calendar event for the run's booking, in the one calendar picked in Apps (decision 0044). It follows the booking: moved when it is rescheduled, deleted when it is cancelled.
export const calendarConfigSchema = z.object({ title: template(300).min(1), description: template(3000).optional() });
// A PayMongo checkout link for the amount in pesos (text, so a template works), sent on by a later step (decision 0045). Idempotent per run and step.
export const paymongoLinkConfigSchema = z.object({ amount: template(100).min(1), description: template(200).min(1), reference: template(200).min(1) });
// Airtable, Notion and Trello add one record, page or card to the target picked in Apps (decision 0046), queued like
// Sheets. Field and property names are the owner's literals; values are templates. Notion fields are text properties.
const fieldName = z.string().trim().min(1).max(100);
const fieldMap = z.record(fieldName, template(2000)).refine((f) => Object.keys(f).length <= 20, "at most 20 fields");
export const airtableConfigSchema = z.object({ fields: fieldMap.refine((f) => Object.keys(f).length >= 1, "add at least one field") });
export const notionConfigSchema = z.object({ title: template(2000).min(1), fields: fieldMap.default({}) });
export const trelloConfigSchema = z.object({ name: template(500).min(1), desc: template(10_000).optional() });
// link is the id of the paymongo_link step to check. The current status of its payment in this run: pending, paid, needs_review or refunded. Read-only, never calls PayMongo.
export const paymentStatusConfigSchema = z.object({ link: stepId.describe("Id of a paymongo_link or payment_due step of this workflow.") });
// R3 (decision 0088): what a customer owes on one order or booking. The customer pays the QR Ph code or GCash number
// shown on the pay page and sends the transfer reference, or pays PayMongo checkout when it is on. Nothing here confirms
// a payment: a reviewer or a matching PayMongo event does, and then kymavo sends confirmedMessage once.
export const paymentDueConfigSchema = z
  .object({
    reference: template(200).min(1).describe("The order or booking reference the customer sees, such as {{trigger.order_id}}."),
    kind: z.enum(["deposit", "full", "balance"]).default("deposit").describe("deposit, full or balance. A pay-later booking asks for the balance and is never cancelled for it."),
    amount: template(100).min(1).describe("Amount in pesos, like 350 or 350.50."),
    total: template(100).min(1).optional().describe("For a deposit: the full price in pesos. What is left is shown as the balance."),
    booking: stepId.optional().describe("Id of the booking step that made the booking this payment is for."),
    checkout: z.boolean().default(false).describe("Also offer PayMongo checkout (GCash and others). Needs PayMongo connected."),
    reviewer: z.email().max(254).transform((s) => s.toLowerCase()).optional().describe("Email of the owner or operator who reviews receipts for this. Empty: any owner or operator."),
    channel: z.enum(["sms", "messenger"]).optional().describe("How the customer is told about the decision: sms or messenger."),
    to: template(500).min(1).optional().describe("The customer's mobile number for SMS, or their Messenger id, such as {{trigger.phone}}."),
    confirmedMessage: template(2500).min(1).optional().describe("Sent once when the payment is confirmed."),
  })
  .refine((c) => (c.channel === undefined) === (c.to === undefined), { message: "set both channel and to, or neither", path: ["to"] });
// The unpaid deadline (R3): cancels the due made by the named payment_due step of this run when it is still unpaid,
// expires its open checkout and releases the booking slot. Branches: expired, or kept when it was paid meanwhile.
export const paymentExpireConfigSchema = z.object({ due: stepId.describe("Id of the payment_due step whose payment this cancels.") });
// A Discord message goes to the channel the owner's webhook posts to (phase I1, decision 0104). The webhook URL is a
// credential: it lives in the Discord connection in Apps, never in a version. Queued like Slack.
export const discordConfigSchema = z.object({ text: template(DISCORD_MAX_CHARS).min(1) });
// A copy of a Google Docs template, saved in the Drive folder picked in Apps (decision 0104). The template is picked in the
// editor with the Google Picker, which is the only way kymavo's drive.file access can open it; templateId is a file id, not a
// secret. Each key of values names a {{key}} placeholder in the template; its value is a template filled from the run.
// Runs inside the step, so a later step can read {{steps.<id>.output.url}}.
export const googleDocsConfigSchema = z.object({
  templateId: z.string().regex(/^[\w-]{10,100}$/, "pick a Google Docs template").describe("The Google Docs template to copy. Pick it with the template button."),
  templateName: z.string().max(200).optional().describe("The template's name, for display."),
  name: template(200).min(1).describe("The new document's name, such as Invoice {{trigger.reference}}."),
  values: z
    .record(z.string().refine(isPlaceholderKey, "a placeholder name uses letters, digits, spaces and _ - . (up to 40 characters), without braces"), template(5000))
    .refine((v) => Object.keys(v).length <= DOCS_MAX_VALUES, `at most ${DOCS_MAX_VALUES} placeholders`)
    .default({})
    .describe("Placeholders to fill. Each name is a {{name}} in the template; its value is the text to put there."),
});
// Reads one public web page (phase B1, decision 0107): its title, its main text and, with a selector, one value such as
// a price. previous and changed come from this step's last successful run. A GET through the same guard as the http step.
export const READ_PAGE_MAX_CHARS = 20_000;
export const readPageConfigSchema = z.object({
  url: template(2000).min(1).describe("The page to read, such as https://example.com/rice. Only public web pages are read."),
  selector: z.string().min(1).max(500).optional().describe("A CSS selector for one value, such as .price. Leave empty to use the whole page text."),
  maxChars: z.int().min(100).max(READ_PAGE_MAX_CHARS).default(4000).describe("The most characters of page text to keep."),
});
// Saves the files a form collected into the Google Drive folder picked in Apps. It takes no settings: the files are
// the form's file fields. Queued like Sheets.
export const driveConfigSchema = z.object({}).default({});
// Replies to a Facebook Messenger or Instagram DM within Meta's 24-hour messaging window (decision 0075). Queued like Slack.
export const metaReplyConfigSchema = z.object({
  recipientId: template(200).min(1).default("{{trigger.senderId}}"),
  channel: template(100).min(1).default("{{trigger.channel}}"),
  text: template(2000).min(1),
  // Tap buttons under the reply (decision 0118). A tap starts a run with {{trigger.choice}} set to the button's choice.
  quickReplies: menuSchema.optional().describe("Buttons under the reply, up to 13. A tap sets {{trigger.choice}}."),
});
export type MetaReplyConfig = z.infer<typeof metaReplyConfigSchema>;
// Saves what the guest told so far on the conversation (decision 0115), for the next message's run. A fixed list of short
// values; an empty value after filling in keeps the saved one.
export const CONVERSATION_FIELD_NAMES = ["check_in", "check_out", "guests", "name", "phone", "email"] as const;
export const conversationUpdateConfigSchema = z.object({
  fields: z.partialRecord(z.enum(CONVERSATION_FIELD_NAMES), template(500)).refine((f) => Object.keys(f).length > 0, "set at least one field"),
});
// The price of a stay from the published knowledge sheet (C4, decision 0119). room is an entry id or title; the nights,
// guests and check-in only count, so the price and deposit always come from the owner's sheet, never from the run.
export const stayQuoteConfigSchema = z.object({
  room: template(200).min(1).describe("The id or title of a room or rate entry of the knowledge sheet."),
  checkIn: template(100).min(1).describe("Check-in date as YYYY-MM-DD."),
  nights: template(20).min(1).describe("Number of nights, 1 to 30."),
  guests: template(20).min(1).describe("Number of guests."),
});
// J1 (decision 0135): strictly read-only workspace summary for the owner's assistant.
export const ASSISTANT_READ_SCOPES = ["all", "calendar", "bookings", "payments", "runs"] as const;
export type AssistantReadScope = (typeof ASSISTANT_READ_SCOPES)[number];
export const assistantReadConfigSchema = z
  .object({
    what: template(100)
      .min(1)
      .default("all")
      .describe("What to read for today: all, calendar, bookings, payments or runs (or a template such as {{steps.pick_intent.output.label}})."),
    timezone: z.string().max(64).optional().describe("IANA timezone for today's dates (defaults to Asia/Manila)."),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.timezone !== undefined && !isTimeZone(c.timezone)) {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "use an IANA timezone name such as Asia/Manila" });
    }
    if (!c.what.includes("{{") && !(ASSISTANT_READ_SCOPES as readonly string[]).includes(c.what.trim().toLowerCase())) {
      ctx.addIssue({ code: "custom", path: ["what"], message: "what must be all, calendar, bookings, payments, runs or a {{...}} template" });
    }
  });
export type AssistantReadConfig = z.infer<typeof assistantReadConfigSchema>;
// Shopify products (decision 0105), queued as deliveries. Every field is a template, read as text when the step runs: price like "499.50" in the
// store's currency, imageUrl an https link Shopify downloads from. A new product starts as a
// draft, so nothing goes on sale by surprise. Blank after filling in means "leave as is" for an update.
const productStatus = z.enum(["draft", "active"]);
const productText = {
  description: template(5000).optional().describe("Plain text. Line breaks are kept, and HTML is shown as typed."),
  price: template(40).optional().describe("In the store's currency, like 499 or 499.50. Leave empty to keep the price as it is."),
  sku: template(255).optional().describe("The SKU is case-sensitive."),
  imageUrl: template(2000).optional().describe("A link that starts with https://. Shopify downloads the picture from it."),
};
export const shopifyCreateProductConfigSchema = z.object({
  title: template(255).min(1),
  ...productText,
  status: productStatus.default("draft").describe("A new product is a draft until you choose active."),
});
// "by" says what "product" holds: a Shopify product id (or the link to it in the Shopify admin) or an exact SKU.
export const shopifyUpdateProductConfigSchema = z
  .object({
    by: z.enum(["id", "sku"]).default("sku").describe("Whether Product below is a Shopify product id or an exact SKU."),
    product: template(255).min(1).describe("The Shopify product id (or the product's link in the Shopify admin), or the exact SKU."),
    title: template(255).optional(),
    ...productText,
    status: productStatus.optional(),
  })
  .refine((c) => [c.title, c.description, c.price, c.sku, c.status, c.imageUrl].some((v) => v !== undefined), "choose at least one thing to change");
export type SheetsConfig = z.infer<typeof sheetsConfigSchema>;
export type SlackConfig = z.infer<typeof slackConfigSchema>;

// A booking for a workspace resource (decision 0032, stays in decision 0120).
// Slot mode (default): create needs resource, start ({{trigger.<datetime field>}}) and minutes (1..1440); reschedule needs booking and start.
// Stay mode: create needs resource, checkIn (YYYY-MM-DD) and nights (1..30), using check-in/out times from the published knowledge sheet;
// reschedule keeps nights and takes booking and checkIn. cancel needs only booking.
export const bookingConfigSchema = z
  .object({
    action: z.enum(["create", "reschedule", "cancel"]),
    mode: z.enum(["slot", "stay"]).optional().describe("slot books a time of up to 24 hours; stay books 1 to 30 nights using the resort's check-in and check-out times from the knowledge sheet."),
    resource: template(500).min(1).optional().describe("The resource to book: a resource field such as {{trigger.therapist}}, or a resource id."),
    booking: template(500).min(1).optional().describe("The booking reference to change, such as {{trigger.reference}}."),
    start: template(500).min(1).optional().describe("A datetime field of the trigger, such as {{trigger.appointment_at}}."),
    minutes: z.int().min(1).max(1440).optional(),
    checkIn: template(200).min(1).optional().describe("Check-in date as YYYY-MM-DD for stay mode, such as {{trigger.check_in}}."),
    nights: z.union([z.int().min(1).max(30), template(50).min(1)]).optional().describe("Number of nights (1 to 30) for stay mode, such as 3 or {{trigger.nights}}."),
    timezone: z.string().max(64).optional().describe("IANA timezone for stay mode (defaults to Asia/Manila)."),
    checkInTime: z.string().regex(CLOCK_TIME_RE, "must be a 24-hour time as HH:MM").optional().describe("Optional 24-hour HH:MM check-in override; leave empty to read from the published knowledge sheet."),
    checkOutTime: z.string().regex(CLOCK_TIME_RE, "must be a 24-hour time as HH:MM").optional().describe("Optional 24-hour HH:MM check-out override; leave empty to read from the published knowledge sheet."),
    conversation: template(200).min(1).optional().describe("Optional conversation id to link this stay to for guest contact, such as {{trigger.conversation_id}}."),
  })
  .superRefine((c, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const stay = c.mode === "stay";
    const stayOnlyFields = [
      ["checkIn", c.checkIn],
      ["nights", c.nights],
      ["timezone", c.timezone],
      ["checkInTime", c.checkInTime],
      ["checkOutTime", c.checkOutTime],
      ["conversation", c.conversation],
    ] as const;

    if (c.timezone !== undefined && !isTimeZone(c.timezone)) issue("timezone", "use an IANA timezone name such as Asia/Manila");
    if (typeof c.nights === "string" && !c.nights.includes("{{")) {
      const n = /^\d{1,2}$/.test(c.nights.trim()) ? Number(c.nights.trim()) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 30) issue("nights", "nights must be a whole number from 1 to 30");
    }

    if (stay) {
      if (c.action === "create") {
        if (c.resource === undefined || c.checkIn === undefined || c.nights === undefined) {
          issue(c.resource === undefined ? "resource" : c.checkIn === undefined ? "checkIn" : "nights", "a stay create needs resource, checkIn and nights");
        }
        if (c.booking !== undefined) issue("booking", "a create makes a new booking, so it takes no booking reference");
        if (c.start !== undefined) issue("start", "stay mode uses checkIn and nights, not start");
        if (c.minutes !== undefined) issue("minutes", "stay mode uses checkIn and nights, not minutes");
      } else if (c.action === "reschedule") {
        if (c.resource !== undefined) issue("resource", "only a create picks the resource; a booking keeps its resource");
        if (c.booking === undefined || c.checkIn === undefined) issue(c.booking === undefined ? "booking" : "checkIn", "a stay reschedule needs booking and checkIn");
        if (c.start !== undefined) issue("start", "stay mode reschedule uses checkIn, not start");
        if (c.minutes !== undefined) issue("minutes", "stay mode reschedule keeps its nights and takes no minutes");
        if (c.nights !== undefined) issue("nights", "a stay reschedule keeps its nights");
      } else {
        if (c.resource !== undefined) issue("resource", "only a create picks the resource; a booking keeps its resource");
        if (c.booking === undefined) issue("booking", "a cancel needs the booking reference");
        for (const [k, v] of [["start", c.start], ["minutes", c.minutes], ...stayOnlyFields] as const) {
          if (v !== undefined) issue(k, "a cancel takes only the booking reference");
        }
      }
      return;
    }

    // Slot mode (default)
    for (const [k, v] of stayOnlyFields) {
      if (v !== undefined) issue(k, `${k} is only for stay mode (set mode to "stay")`);
    }
    if (c.action === "create") {
      if (c.resource === undefined || c.start === undefined || c.minutes === undefined) issue(c.resource === undefined ? "resource" : c.start === undefined ? "start" : "minutes", "a create needs resource, start and minutes");
      if (c.booking !== undefined) issue("booking", "a create makes a new booking, so it takes no booking reference");
    } else {
      if (c.resource !== undefined) issue("resource", "only a create picks the resource; a booking keeps its resource");
      if (c.action === "reschedule" && (c.booking === undefined || c.start === undefined)) issue(c.booking === undefined ? "booking" : "start", "a reschedule needs booking and start");
      if (c.action === "cancel" && c.booking === undefined) issue("booking", "a cancel needs the booking reference");
      if (c.action === "cancel" && (c.start !== undefined || c.minutes !== undefined)) issue(c.start !== undefined ? "start" : "minutes", "a cancel takes only the booking reference");
    }
  });
export type BookingConfig = z.infer<typeof bookingConfigSchema>;

// A disabled step is recorded as skipped and the run follows its one edge (decision 0097). Only true, so an enabled step has no key.
const disabled = z.literal(true).optional();
// T4: the owner's own words about a step, shown on its card and in Explain this flow. Plain text, never resolved as a template.
export const STEP_NOTE_MAX = 300;
export const stepNoteSchema = z.string().max(STEP_NOTE_MAX).optional();
const note = stepNoteSchema;

const stepSchema = z.discriminatedUnion("type", [
  z.object({ id: stepId, disabled, note, type: z.literal("condition"), config: z.object({ condition: conditionSchema }) }),
  z.object({ id: stepId, disabled, note, type: z.literal("http"), config: httpConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("email"), config: emailConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("delay"), config: delayConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("ai"), config: aiConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("approval"), config: approvalConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("sheets"), config: sheetsConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("drive"), config: driveConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("slack"), config: slackConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("outlook"), config: outlookConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("teams"), config: teamsConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("telegram"), config: telegramConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("sms"), config: smsConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("calendar"), config: calendarConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("airtable"), config: airtableConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("notion"), config: notionConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("trello"), config: trelloConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("booking"), config: bookingConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("paymongo_link"), config: paymongoLinkConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("payment_status"), config: paymentStatusConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("payment_due"), config: paymentDueConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("payment_expire"), config: paymentExpireConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("meta_reply"), config: metaReplyConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("conversation_update"), config: conversationUpdateConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("stay_quote"), config: stayQuoteConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("assistant_read"), config: assistantReadConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("discord"), config: discordConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("google_docs"), config: googleDocsConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("read_page"), config: readPageConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("shopify_create_product"), config: shopifyCreateProductConfigSchema }),
  z.object({ id: stepId, disabled, note, type: z.literal("shopify_update_product"), config: shopifyUpdateProductConfigSchema }),
  // Phase B2 (decision 0108): a page opened in the browser service, with a list of actions.
  z.object({ id: stepId, disabled, note, type: z.literal("browser"), config: browserConfigSchema }),
  // G1 (decision 0123): start another published sub_workflow in the same workspace.
  z.object({
    id: stepId,
    disabled,
    note,
    type: z.literal("call_workflow"),
    config: z.object({
      workflowSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "use a-z, 0-9 and -").describe("The slug of the target automation (started by Run from another automation)."),
      payload: z.record(z.string().min(1).max(64), template(2000)).refine((p) => Object.keys(p).length <= 30, "at most 30 fields").default({}).describe("Fields sent to the child automation."),
    }),
  }),
]);
export const callWorkflowConfigSchema = z.object({
  workflowSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "use a-z, 0-9 and -").describe("The slug of the target automation (started by Run from another automation)."),
  payload: z.record(z.string().min(1).max(64), template(2000)).refine((p) => Object.keys(p).length <= 30, "at most 30 fields").default({}).describe("Fields sent to the child automation."),
});
export type Step = z.infer<typeof stepSchema>;

/** Outgoing edge labels for steps that branch. Every other step has at most one unlabelled edge. */
// A condition's "invalid" edge is optional: without one, a comparison on a missing or non-number value fails the step.
export const BRANCHES: Partial<Record<Step["type"], readonly string[]>> = {
  condition: ["true", "false", "invalid"],
  approval: ["approved", "rejected", "timeout"],
  booking: ["done", "taken", "not_found"],
  payment_expire: ["expired", "kept"],
};

const edgeSchema = z.object({ from: stepId, to: stepId, on: z.string().max(32).optional() });

// Field names become keys of the trigger payload ({{trigger.<name>}}), so they use the same charset as step ids.
// min, max and integer limit a number field; the API checks them wherever a payload comes in (decision 0027).
export const formFieldSchema = z
  .object({
    name: stepId,
    label: z.string().min(1).max(200),
    type: z.enum(["text", "email", "textarea", "number", "datetime", "resource", "file"]),
    required: z.boolean().default(false),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
    // datetime: the IANA zone the time is read in, and an optional slot grid counted from local midnight (decision 0031).
    timezone: z.string().max(64).optional(),
    slotMinutes: z.int().min(1).max(1440).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "datetime" && f.timezone === undefined) ctx.addIssue({ code: "custom", path: ["timezone"], message: "a datetime field needs a timezone such as Asia/Manila" });
    if (f.type === "datetime" && f.timezone !== undefined && !isTimeZone(f.timezone)) ctx.addIssue({ code: "custom", path: ["timezone"], message: "use an IANA timezone name such as Asia/Manila" });
    if (f.type !== "datetime" && (f.timezone !== undefined || f.slotMinutes !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["type"], message: "timezone and slotMinutes are for datetime fields" });
    }
    if (f.type !== "number" && (f.min !== undefined || f.max !== undefined || f.integer !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["type"], message: "min, max and integer are for number fields" });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) ctx.addIssue({ code: "custom", path: ["max"], message: "max must not be below min" });
  });
export type FormField = z.infer<typeof formFieldSchema>;

const fieldList = z.array(formFieldSchema).min(1).max(30);

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual"), config: z.object({}).default({}) }),
  // The mailbox credential belongs to the installation's encrypted source row, never to a saved version.
  z.object({ type: z.literal("email"), config: z.strictObject({}).default({}) }),
  // hmacSecret names a stored secret; the API checks X-Daloy-Signature against it. fields, when set, are checked like a form's.
  // eventKey is a template such as {{trigger.event_id}}: a second event with the same key gets the first run (decision 0029).
  // requireTimestamp (N11b): refuse a call signed without X-Daloy-Timestamp. Off by default, so callers written before it keep working.
  z.object({ type: z.literal("webhook"), config: z.object({ hmacSecret: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/, "use a-z, 0-9 and _").optional(), requireTimestamp: z.boolean().optional(), fields: fieldList.optional(), eventKey: z.string().min(1).max(500).optional() }).default({}) }),
  // pg-boss validates the expression fully when the schedule is saved.
  z.object({ type: z.literal("schedule"), config: z.object({ cron: z.string().regex(/^\S+( \S+){4,5}$/, "cron needs 5 or 6 fields") }) }),
  z.object({ type: z.literal("form"), config: z.object({ fields: fieldList }) }),
  // Starts a run when PayMongo reports a payment (paid by default). The run gets the payment as its trigger payload.
  z.object({ type: z.literal("payment"), config: z.object({ events: z.array(z.enum(["paid", "refunded"])).min(1).default(["paid"]) }).default({ events: ["paid"] }) }),
  // Starts a run when a Facebook Messenger or Instagram DM arrives on the connected Page or Instagram account (decision 0075).
  z.object({
    type: z.literal("meta_dm"),
    config: z
      .object({
        channel: z.enum(["messenger", "instagram", "both"]).default("both"),
        requireImage: z.boolean().default(false),
      })
      .default({ channel: "both", requireImage: false }),
  }),
  // Starts a run for each new Shopify order (orders/create). kymavo registers the webhook when the store is connected and
  // checks X-Shopify-Hmac-Sha256 with the app secret. The order arrives as trigger fields (decision 0105).
  z.object({ type: z.literal("shopify_order"), config: z.strictObject({}).default({}) }),
  // T9: starts when someone messages the owner's own Telegram bot (decision 0117). "my_chat" takes only the chat chosen
  // in Apps; "anyone" takes every chat that messages the bot. A photo or PDF arrives as the upload field "file".
  z.object({
    type: z.literal("telegram_message"),
    config: z
      .strictObject({ from: z.enum(["my_chat", "anyone"]).default("my_chat"), requireFile: z.boolean().default(true) })
      .default({ from: "my_chat", requireFile: true }),
  }),
  // G1 (decision 0123): kymavo internal booking/payment lifecycle events and reusable sub-workflows.
  z.object({
    type: z.literal("booking_event"),
    config: z.object({ events: z.array(z.enum(["created", "rescheduled", "cancelled"])).min(1).default(["created"]) }).default({ events: ["created"] }),
  }),
  z.object({
    type: z.literal("payment_event"),
    config: z.object({ events: z.array(z.enum(["confirmed", "expired"])).min(1).default(["confirmed"]) }).default({ events: ["confirmed"] }),
  }),
  z.object({
    type: z.literal("sub_workflow"),
    config: z.object({ fields: fieldList.optional() }).default({}),
  }),
  // G2 (decision 0127): Google Workspace triggers on the connections chosen in Apps, read by the worker's poll.
  // sheets_row: a new row in this tab of the spreadsheet picked for Google Sheets.
  z.object({ type: z.literal("sheets_row"), config: z.strictObject({ tab: z.string().trim().min(1).max(100) }) }),
  // calendar_event: a new event, or one starting within minutesBefore, in the calendar chosen for Google Calendar.
  z.object({
    type: z.literal("calendar_event"),
    config: z
      .strictObject({ on: z.enum(["created", "starting"]).default("created"), minutesBefore: z.number().int().min(5).max(1440).default(60) })
      .default({ on: "created", minutesBefore: 60 }),
  }),
  // drive_file: a new file in the folder chosen for Google Drive. requireFile: only files Daloy can attach (type and size limits).
  z.object({ type: z.literal("drive_file"), config: z.strictObject({ requireFile: z.boolean().default(false) }).default({ requireFile: false }) }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

/** The upload fields a trigger brings in, which an AI step may read and a drive step saves. */
export function triggerFileFields(trigger: Trigger): string[] {
  if (trigger.type === "form") return trigger.config.fields.filter((f) => f.type === "file").map((f) => f.name);
  if (trigger.type === "meta_dm") return ["image"];
  if (trigger.type === "telegram_message" || trigger.type === "drive_file") return ["file"];
  return [];
}

const TRIGGER_FIELD = /^\{\{\s*trigger\.([a-z][a-z0-9_]*)\s*\}\}$/;
/** The datetime field a booking step's start reads, or undefined when start is anything else (decision 0032). */
export function bookingStartField(trigger: Trigger, config: Pick<BookingConfig, "start">): FormField | undefined {
  const name = config.start === undefined ? undefined : TRIGGER_FIELD.exec(config.start)?.[1];
  return triggerFields(trigger)?.find((f) => f.name === name && f.type === "datetime");
}

/** The fields a trigger's payload is checked against: a form's, or a webhook's or sub_workflow's when it lists any. */
export const triggerFields = (t: Trigger): FormField[] | undefined =>
  t.type === "form" || t.type === "webhook" || t.type === "sub_workflow" ? t.config.fields : undefined;

// Plain decimal text only, so "45,000", "0x10" and "Infinity" are refused instead of read as some other number.
const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const notGiven = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const required = (fallback: string) => ({ error: (iss: { input: unknown }) => (iss.input === undefined ? "is required" : fallback) });

/**
 * The schema a submission must pass: from the public form, a test run, the console Run button, MCP, or a webhook with
 * fields. Empty text and null count as not given. Keys that are not fields are dropped.
 */
export type Resource = { id: string; name: string };
/** resources: the workspace's active resources, the only ids a resource field accepts. now: for "in the future". */
/**
 * files: what the hosted form stored for each file field. Without it (a webhook, MCP, a test run, the Run button)
 * file fields are not part of the payload at all. With it, a file field's value is only ever what is listed here,
 * never what the client sent.
 */
export type PayloadContext = { resources?: Resource[]; now?: number; files?: Record<string, FileRef[]> };

export function payloadSchema(fields: FormField[], { resources = [], now, files }: PayloadContext = {}) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    if (f.type === "file") {
      if (!files) continue;
      const given = files[f.name] ?? [];
      const list = z.array(z.custom<FileRef>(), required("must be files")).max(FILES_PER_FIELD, `must be at most ${FILES_PER_FIELD} files`);
      shape[f.name] = z.preprocess(() => (given.length === 0 ? undefined : given), f.required ? list : list.optional());
      continue;
    }
    let base: z.ZodType;
    if (f.type === "datetime") {
      base = z.string(required("must be a date and time like 2027-01-20T14:00")).transform((v, ctx) => {
        const r = parseZoned(v.trim(), { timezone: f.timezone!, slotMinutes: f.slotMinutes }, now ?? Date.now());
        if (r.ok) return r.value;
        ctx.addIssue({ code: "custom", message: r.error });
        return z.NEVER;
      });
    } else if (f.type === "resource") {
      // The name is copied from the database row, so a later rename leaves this run's payload as it was.
      const choices = resources.map((r) => `${r.name} (${r.id})`).join(", ");
      base = z
        .string(required("must be a resource id"))
        .transform((v, ctx) => {
          const r = resources.find((x) => x.id === v.trim());
          if (r) return { id: r.id, name: r.name };
          ctx.addIssue({ code: "custom", message: "must be one of this workspace's resources" });
          return z.NEVER;
        })
        .describe(choices ? `A resource id: ${choices}` : "A resource id");
    } else if (f.type === "number") {
      let n = z.number(required("must be a number"));
      if (f.min !== undefined) n = n.min(f.min, `must be at least ${f.min}`);
      if (f.max !== undefined) n = n.max(f.max, `must be at most ${f.max}`);
      if (f.integer) n = n.int("must be a whole number");
      base = n;
    } else if (f.type === "email") {
      base = z.email(required("must be an email address")).max(254, "must be at most 254 characters");
    } else {
      const max = f.type === "textarea" ? 5000 : 500;
      base = z.string(required("must be text")).trim().max(max, `must be at most ${max} characters`);
    }
    const read = (v: unknown) => (notGiven(v) ? undefined : f.type === "number" && typeof v === "string" && NUMBER_TEXT.test(v.trim()) ? Number(v) : typeof v === "string" && f.type === "email" ? v.trim() : v);
    shape[f.name] = z.preprocess(read, f.required ? base : base.optional());
  }
  return z.object(shape);
}

/** Checks a payload against its fields. Errors read "<field>: <problem>", one per field, in field order. */
export function parsePayload(fields: FormField[], data: unknown, context?: PayloadContext): { ok: true; data: Record<string, unknown> } | { ok: false; errors: string[] } {
  // zod skips an absent key, so file fields get a key here and their preprocess reads context.files.
  const files = context?.files ? Object.fromEntries(fields.filter((f) => f.type === "file").map((f) => [f.name, null])) : {};
  const r = payloadSchema(fields, context).safeParse({ ...((data ?? {}) as Record<string, unknown>), ...files });
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`) };
}

const STEP_REF = /\{\{\s*steps\.([a-z][a-z0-9_]*)/g;
/**
 * L7 (decision 0119): what a price read from other steps comes from. Each step the template reads is followed through
 * its own config, so model output or a stranger's text cannot become an amount by way of an http, stay_quote or any
 * other step. Returns the first untrusted source, or null.
 */
function untrustedSource(template: string, steps: Map<string, Step>, trigger: Trigger, seen = new Set<string>()): string | null {
  for (const [, id] of template.matchAll(STEP_REF)) {
    const s = steps.get(id!);
    if (!s || seen.has(id!)) continue;
    seen.add(id!);
    if (s.type === "ai") return `the AI step "${id}"`;
    const config = JSON.stringify(s.config);
    if (!priceTrusted(trigger) && /\{\{\s*trigger\./.test(config)) return `step "${id}", which reads a ${trigger.type} trigger that anyone can fill in`;
    const deeper = untrustedSource(config, steps, trigger, seen);
    if (deeper) return deeper;
  }
  return null;
}

const priceTrusted = (t: Trigger) => t.type === "manual" || t.type === "schedule" || t.type === "payment" || t.type === "shopify_order" || (t.type === "webhook" && t.config.hmacSecret !== undefined);

export const definitionSchema = z
  .object({
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1).max(100),
    edges: z.array(edgeSchema).max(200).default([]),
  })
  .superRefine((def, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });

    const fields = triggerFields(def.trigger);
    if ((def.trigger.type === "webhook" || def.trigger.type === "sub_workflow") && def.trigger.config.fields?.some((f) => f.type === "file")) {
      fail(`file fields are for forms; a ${def.trigger.type} cannot take files`);
    }
    if (fields) {
      const names = new Set<string>();
      for (const f of fields) {
        if (names.has(f.name)) fail(`duplicate form field "${f.name}"`);
        names.add(f.name);
      }
    }

    const byId = new Map<string, Step>();
    for (const s of def.steps) {
      if (byId.has(s.id)) fail(`duplicate step id "${s.id}"`);
      byId.set(s.id, s);
      if (s.type === "drive" && !((def.trigger.type === "form" && def.trigger.config.fields.some((f) => f.type === "file")) || def.trigger.type === "meta_dm" || def.trigger.type === "telegram_message")) {
        fail(`drive step "${s.id}" needs a form trigger with at least one file field`);
      }
      if (s.type === "ai") {
        const fileFields = triggerFileFields(def.trigger);
        for (const name of s.config.files ?? []) if (!fileFields.includes(name)) fail(`ai step "${s.id}" reads "${name}", which is not a file field of the form`);
      }
      if (s.type === "telegram" && s.config.chatId !== undefined && def.trigger.type !== "telegram_message") fail(`telegram step "${s.id}" can only set a chat with a Telegram message trigger`);
      if (s.type === "payment_status" && !def.steps.some((o) => o.id === s.config.link && (o.type === "paymongo_link" || o.type === "payment_due"))) fail(`payment_status step "${s.id}" needs link to be the id of a paymongo_link or payment_due step`);
      if (s.type === "payment_expire" && !def.steps.some((o) => o.id === s.config.due && o.type === "payment_due")) fail(`payment_expire step "${s.id}" needs due to be the id of a payment_due step`);
      if (s.type === "payment_due" && s.config.booking !== undefined && !def.steps.some((o) => o.id === s.config.booking && o.type === "booking" && o.config.action === "create")) fail(`payment_due step "${s.id}" needs booking to be the id of a booking step that creates a booking`);
      // The price of a due is what counts as paid, so a public visitor must not choose it (review of 22 November, M4).
      // A signed webhook is the shop's own server; staff start manual runs; schedule and payment triggers carry no visitor text.
      if (s.type === "payment_due" && !priceTrusted(def.trigger) && [s.config.amount, s.config.total].some((t) => t !== undefined && /\{\{\s*trigger\./.test(t))) {
        fail(`payment_due step "${s.id}" cannot take its amount or total from a ${def.trigger.type} trigger, which anyone can fill in. Use a fixed amount, a signed webhook or a manual run.`);
      }
      // A product step writes to the owner's store, so what a stranger typed (a public form, an email, a message) must not choose its fields.
      if ((s.type === "shopify_create_product" || s.type === "shopify_update_product") && !priceTrusted(def.trigger) && Object.values(s.config).some((v) => typeof v === "string" && /\{\{\s*trigger\./.test(v))) {
        fail(`${s.type} step "${s.id}" cannot take its fields from a ${def.trigger.type} trigger, which anyone can fill in. Use fixed values, a signed webhook, a Shopify order or a manual run.`);
      }
      if (s.type === "conversation_update" && def.trigger.type !== "meta_dm" && def.trigger.type !== "email") fail(`conversation_update step "${s.id}" needs a meta_dm or email trigger, which starts a conversation`);
      if (s.type !== "booking") continue;
      if (s.config.start !== undefined && !bookingStartField(def.trigger, s.config)) fail(`booking step "${s.id}" needs start to be {{trigger.<field>}} for a datetime field of the trigger`);
      // Changing a booking is for staff (the Run button), MCP (its own tools) and signed webhooks, never a public form.
      const signed = def.trigger.type === "manual" || (def.trigger.type === "webhook" && def.trigger.config.hmacSecret !== undefined);
      if (s.config.action !== "create" && !signed) fail(`booking step "${s.id}" can reschedule or cancel only from a manual trigger or a webhook with a signing secret`);
      // C5 (decision 0120): a stay is created by staff, after a confirmed payment or via a signed webhook, never from guest text alone.
      const stayTrusted = signed || def.trigger.type === "payment";
      if (s.config.mode === "stay" && s.config.action === "create" && !stayTrusted) {
        fail(`booking step "${s.id}" in stay mode can only run from a manual trigger, a confirmed payment trigger, or a webhook with a signing secret`);
      }
    }

    // A reply of "2" means the second choice, so every email menu of one workflow must number its choices the same way.
    const emailMenus = def.steps.flatMap((s) => ((s.type === "email" || s.type === "outlook") && s.config.menu ? [s.config.menu.map((m) => m.choice).join(",")] : []));
    if (new Set(emailMenus).size > 1) fail("every email menu in a workflow must list the same choices in the same order, so a reply's number means one thing");

    for (const s of def.steps) {
      if (s.type === "payment_due") {
        const source = untrustedSource([s.config.amount, s.config.total ?? ""].join(" "), byId, def.trigger);
        if (source) fail(`payment_due step "${s.id}" cannot take its amount or total from ${source}. Take prices from a stay_quote step, a fixed amount or a manual run.`);
      }
      if (s.type === "booking" && s.config.mode === "stay" && s.config.action === "create") {
        const source = untrustedSource([s.config.resource ?? "", s.config.checkIn ?? "", String(s.config.nights ?? ""), s.config.conversation ?? ""].join(" "), byId, def.trigger);
        if (source) fail(`booking step "${s.id}" in stay mode cannot take its details from ${source}. Confirm stays from staff, a confirmed payment or a signed webhook.`);
      }
    }

    for (const s of def.steps) if (s.disabled && BRANCHES[s.type]) fail(`${s.type} step "${s.id}" branches, so it cannot be turned off`);

    for (const e of def.edges) {
      for (const id of [e.from, e.to]) if (!byId.has(id)) fail(`edge refers to unknown step "${id}"`);
    }
    // Graph checks below assume every edge points at a real step.
    if (def.edges.some((e) => !byId.has(e.from) || !byId.has(e.to))) return;

    const seen = new Set<string>();
    for (const e of def.edges) {
      const from = byId.get(e.from)!;
      const labels = BRANCHES[from.type];
      if (labels && e.on === undefined) fail(`edge from ${from.type} step "${from.id}" needs a branch label`);
      if (labels && e.on !== undefined && !labels.includes(e.on)) {
        fail(`"${e.on}" is not a branch of ${from.type} step "${from.id}"`);
      }
      // A delay until a time may add a "late" edge next to its usual one (decision 0031).
      if (!labels && e.on === "late" && from.type === "delay") {
        if (from.config.until === undefined) fail(`only a delay with "until" can have a "late" edge, and "${from.id}" waits a fixed time`);
        // A Meta reply may add fallbacks for a closed 24-hour window and for a conversation staff took over (decision 0115).
      } else if (!labels && from.type === "meta_reply" && (e.on === "outside_window" || e.on === "paused")) {
        // allowed
      } else if (!labels && e.on !== undefined) fail(`step "${from.id}" does not branch, so its edge cannot have a label`);

      const label = e.on ?? "next";
      const key = `${e.from}\u0000${label}`;
      if (seen.has(key)) fail(`step "${e.from}" has more than one "${label}" edge`);
      seen.add(key);
    }

    // Kahn's algorithm: if some steps never reach in-degree 0, there is a cycle.
    const inDegree = new Map(def.steps.map((s) => [s.id, 0]));
    for (const e of def.edges) inDegree.set(e.to, inDegree.get(e.to)! + 1);
    const roots = [...inDegree].filter(([, d]) => d === 0).map(([id]) => id);
    if (roots.length !== 1) fail(`a workflow needs exactly one entry step, found ${roots.length}`);

    const queue = [...roots];
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.pop()!;
      visited++;
      for (const e of def.edges) {
        if (e.from !== id) continue;
        const d = inDegree.get(e.to)! - 1;
        inDegree.set(e.to, d);
        if (d === 0) queue.push(e.to);
      }
    }
    if (visited !== def.steps.length) fail("the workflow contains a cycle");
  });

export type WorkflowDefinition = z.infer<typeof definitionSchema>;
