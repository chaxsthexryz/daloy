import * as z from "zod";
import { BRANCHES, definitionSchema, type WorkflowDefinition } from "./definition";
import { stepJsonSchemas } from "./step-schemas";
import { TEMPLATES } from "./templates";

/**
 * Turning a plain-language request into a workflow draft (decision 0017). The model writes the whole definition as
 * JSON; the same definitionSchema as a hand-built workflow checks it. A draft is never saved or published by itself.
 */
const replySchema = z.object({ name: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(500), definition: definitionSchema });

export type DraftResult = { ok: true; name: string; summary: string; definition: WorkflowDefinition } | { ok: false; errors: string[] };

const example = TEMPLATES[0]!;

// "files" is the owner's consent to let the model read a form file, so Build with AI never hears of it. Menus (decision
// 0118) come from templates, and leaving them out keeps the prompt inside a local model's default context. A local model
// also drafts without the concierge answer task or stay-mode booking fields (both belong to the resort concierge).
const without = (schema: unknown, keys: readonly string[], full: boolean) => {
  const properties = { ...(schema as { properties: Record<string, { enum?: string[] }> }).properties };
  for (const key of keys) delete properties[key];
  if (!full && properties.task?.enum) {
    properties.task = { ...properties.task, enum: properties.task.enum.filter((t) => t !== "answer") };
  }
  return { ...(schema as object), properties };
};
const LEFT_OUT: Record<string, readonly string[]> = { ai: ["files"], email: ["menu"], outlook: ["menu"], meta_reply: ["quickReplies"], whatsapp_reply: ["quickReplies"] };
const LOCAL_LEFT_OUT: Record<string, readonly string[]> = { email: ["attachments"], booking: ["mode", "checkIn", "nights", "timezone", "checkInTime", "checkOutTime", "conversation"], sheets: ["rows", "header"] };

/**
 * The part of the prompt that describes a definition: trigger, steps, edges and the rules a draft has to follow.
 * Exported so the chat prompt (ai-chat.ts) describes workflows in exactly the same words.
 */
const spec = (full: boolean) => [
  "A definition is {trigger, steps, edges}.",
  'trigger is one of: {"type":"manual","config":{}}, {"type":"webhook","config":{}}, {"type":"schedule","config":{"cron":"0 9 * * 1"}},',
  '{"type":"form","config":{"fields":[{"name":"email","label":"Email","type":"email","required":true}]}} (field types: text, email, number, textarea, datetime, resource, file).',
  ...(full ? [FULL_TRIGGERS] : []),
  'A datetime field needs "timezone" (an IANA name such as "Asia/Manila") and can set "slotMinutes"; times must be in the future and on the slot grid. A resource field takes one of the resources of the workspace (a therapist, a room); use {{trigger.<field>.name}} in messages. A delay can wait "until" a datetime field with "offsetSeconds" (e.g. -86400 for a day before); if that time has passed, the run ends at the delay unless it has an edge with "on": "late".',
  'A file field ("type":"file") holds photos and PDFs, up to 3 per field. To read one, add it and an ai step (task extract or summarize); the owner ticks "Let the AI read these files" on that step, so name that box in the summary. A drive step saves form files to Google Drive.',
  'A number field can set "min", "max" and "integer": true, e.g. {"name":"amount","label":"Amount","type":"number","required":true,"min":0.01}. Put limits on the field instead of adding condition steps that check them; a submission outside the limits is refused before the workflow runs. A webhook trigger can list "fields" the same way to check incoming events, and set "eventKey" (such as "{{trigger.event_id}}") so a repeated event starts no second run.',
  'A condition comparing with gt, gte, lt or lte takes its "invalid" branch when a side is missing or not a number. Give it an "invalid" edge when bad data needs its own handling (such as manual review); without one, the run fails with a message.',
  'steps is a list of {"id","type","config"}. ids use a-z, 0-9 and _. The config of each step type follows this JSON Schema:',
  JSON.stringify(
    Object.fromEntries(
      Object.entries(stepJsonSchemas())
        .filter(([type]) => full || !HOSTED_ONLY.includes(type))
        .map(([type, schema]) => {
          const drop = [...(LEFT_OUT[type] ?? []), ...(full ? [] : (LOCAL_LEFT_OUT[type] ?? []))];
          return [type, drop.length ? without(schema, drop, full) : schema];
        }),
    ),
  ),
  'edges is a list of {"from","to"} and, from a branching step, "on": ' +
    Object.entries(BRANCHES)
      .map(([type, labels]) => `${type} has ${labels!.map((l) => `"${l}"`).join(", ")}`)
      .join("; ") +
    ". Each branch label and each non-branching step has at most one outgoing edge. No cycles. The first step is the one no edge points to.",
  "A sheets step adds a row to the owner's connected Google Sheet; a slack step posts to their connected Slack channel. An outlook step sends an email (to, subject, text) from their connected Outlook mailbox; a teams step posts text to their connected Teams channel. Keep names, emails and other private details out of slack and teams text.",
  "Text fields can use {{trigger.<field>}} and {{steps.<id>.output.<path>}}. An ai step with task classify outputs {label}, so a condition reads {{steps.<id>.output.label}}.",
  'An http POST or PATCH is sent once: when its outcome is unknown (a timeout or a 5xx), the run waits for a person instead of resending. Set "idempotent": true only when the request names an API that is safe to call twice with the same request.',
  'Give an approval step an edge for each of "approved", "rejected" and "timeout", so the requester is told either way, and make sure every label of a classify step reaches a step.',
  "Use real-looking placeholders such as you@example.com when the request gives no address. Keep steps to what was asked.",
  "Mock test runs in kymavo fake every email, HTTP call, approval and connected app, and the tester can pick AI labels and approval outcomes, so never add dry-run flags, test fields or branches for testing.",
  ...(full ? FULL_RULES : []),
];

// Left out of a small local model's prompt to keep it inside that model's context; a hosted model gets all of them.
// The stress test (apps/api/scripts/ai-stress.ts) showed a hosted model without them builds http or telegram steps instead.
const HOSTED_ONLY = ["airtable", "notion", "trello", "payment_status", "payment_due", "payment_expire", "sms", "meta_reply", "whatsapp_reply", "conversation_update", "stay_quote", "assistant_read", "discord", "google_docs", "read_page", "invoice_pdf", "shopify_create_product", "shopify_update_product", "browser", "call_workflow", "switch", "transform"];
const FULL_TRIGGERS =
  'More triggers: {"type":"meta_dm","config":{"channel":"both"}} for a Facebook Messenger or Instagram DM to the connected Page (channel messenger, instagram or both; fields {{trigger.text}}, {{trigger.senderId}}, {{trigger.channel}}); ' +
  '{"type":"whatsapp_message","config":{"requireImage":false}} for an inbound WhatsApp Cloud API message (fields {{trigger.text}}, {{trigger.senderId}}, {{trigger.senderName}}; use whatsapp_reply mode "text" inside 24h or mode "template" outside 24h); ' +
  '{"type":"payment","config":{"events":["paid"]}} for a PayMongo payment (fields {{trigger.reference}}, {{trigger.amountPesos}}, {{trigger.status}}); ' +
  '{"type":"shopify_order","config":{}} for a new order in the connected Shopify store (fields {{trigger.order_number}}, {{trigger.customer_name}}, {{trigger.customer_email}}, {{trigger.customer_phone}}, {{trigger.total}}, {{trigger.items}}); ' +
  '{"type":"telegram_message","config":{"from":"my_chat","requireFile":true}} for a photo, PDF or message sent to the Telegram bot of the owner (from my_chat or anyone; fields {{trigger.text}}, {{trigger.chatId}}, {{trigger.fromName}}, {{trigger.date}}; the photo or PDF is the file field "file" for an ai step; reply with a telegram step whose chatId is {{trigger.chatId}}); ' +
  '{"type":"booking_event","config":{"events":["created"]}} when a kymavo booking is created, rescheduled or cancelled (fields {{trigger.event}}, {{trigger.bookingId}}, {{trigger.reference}}, {{trigger.resourceName}}, {{trigger.start}}, {{trigger.end}}, {{trigger.status}}, {{trigger.mode}}); ' +
  '{"type":"payment_event","config":{"events":["confirmed"]}} when a kymavo payment due settles as confirmed or expired (fields {{trigger.event}}, {{trigger.dueId}}, {{trigger.reference}}, {{trigger.amountPesos}}, {{trigger.kind}}, {{trigger.status}}); ' +
  '{"type":"sub_workflow","config":{}} for a reusable child workflow called by a call_workflow step; ' +
  '{"type":"sheets_row","config":{"tab":"Sheet1"}} for a new row in a tab of the connected Google Sheet (fields {{trigger.rowNumber}}, {{trigger.values}}, and {{trigger.cells.<header>}} with the header in lower case and _ for spaces); ' +
  '{"type":"calendar_event","config":{"on":"created","minutesBefore":60}} for a new event in the connected Google Calendar, or on "starting" that many minutes before an event (fields {{trigger.title}}, {{trigger.start}}, {{trigger.end}}, {{trigger.location}}, {{trigger.description}}, {{trigger.link}}); ' +
  '{"type":"drive_file","config":{"requireFile":false}} for a new file in the connected Google Drive folder (fields {{trigger.name}}, {{trigger.mimeType}}, {{trigger.size}}, {{trigger.link}}; a photo or PDF up to 5 MB is the file field "file" for an ai step); ' +
  '{"type":"gmail_message","config":{"from":"orders@example.com","subjectContains":"Invoice","label":"INBOX"}} for a message in the connected Gmail mailbox (optional filters from, subjectContains, label; fields {{trigger.from}}, {{trigger.replyTo}}, {{trigger.to}}, {{trigger.subject}}, {{trigger.text}}, {{trigger.messageId}}, {{trigger.receivedAt}}, {{trigger.labelIds}}); ' +
  '{"type":"outlook_message","config":{"from":"orders@example.com","subjectContains":"Invoice","folder":"Inbox"}} for a message in the connected Outlook mailbox (optional filters from, subjectContains, folder; fields {{trigger.from}}, {{trigger.replyTo}}, {{trigger.to}}, {{trigger.subject}}, {{trigger.text}}, {{trigger.messageId}}, {{trigger.receivedAt}}, {{trigger.folder}}); ' +
  '{"type":"page_changed","config":{"url":"https://example.com","mode":"page","maxChars":4000}} to monitor a public web page (optional CSS selector) or RSS/Atom feed ("mode":"feed") for changes (page fields {{trigger.title}}, {{trigger.value}}, {{trigger.previous}}, {{trigger.text}}, {{trigger.url}}; feed fields {{trigger.title}}, {{trigger.link}}, {{trigger.summary}}, {{trigger.published}}); ' +
  '{"type":"slack_message","config":{"signingSecret":"slack_signing_secret","ignoreBots":true}} for a signed Slack Events API message (fields {{trigger.text}}, {{trigger.channelId}}, {{trigger.userId}}, {{trigger.ts}}); ' +
  '{"type":"teams_message","config":{"signingSecret":"teams_webhook_secret"}} for a signed Microsoft Teams outgoing webhook message (fields {{trigger.text}}, {{trigger.senderName}}, {{trigger.channelId}}); ' +
  '{"type":"discord_message","config":{"signingSecret":"discord_webhook_secret"}} for a verified Discord slash command or signed message (fields {{trigger.text}}, {{trigger.commandName}}, {{trigger.channelId}}, {{trigger.username}}); ' +
  '{"type":"airtable_record","config":{"on":"created"}} for a new Airtable record or {"on":"status_changed","statusField":"Status"} in the connected Airtable table (fields {{trigger.recordId}}, {{trigger.cells.<field>}}, {{trigger.status}}, {{trigger.previousStatus}}); ' +
  '{"type":"notion_page","config":{"on":"created"}} for a new Notion page or {"on":"status_changed","statusProperty":"Status"} in the connected Notion database (fields {{trigger.title}}, {{trigger.url}}, {{trigger.cells.<property>}}, {{trigger.status}}, {{trigger.previousStatus}}); ' +
  '{"type":"trello_card","config":{"on":"created"}} for a new Trello card or {"on":"moved_to_list"} in the connected Trello list (fields {{trigger.cardId}}, {{trigger.name}}, {{trigger.desc}}, {{trigger.url}}, {{trigger.listName}}, {{trigger.previousListName}}); ' +
  '{"type":"email","config":{}} for an email to the workspace inbox.';
const FULL_RULES = [
  "When the person names an app or channel kymavo has no step for (such as TikTok, Viber or Lazada), say so plainly in the summary and name what the draft uses instead. Never say a step sends through an app it does not use.",
  "Pick the step the person names: text, SMS or i-text means an sms step; Facebook, Messenger, Instagram or page messages mean the meta_dm trigger, answered with a meta_reply step (recipientId {{trigger.senderId}}, channel {{trigger.channel}}); Discord, Trello, Notion, Airtable, Google Docs and Shopify have their own steps. Use telegram only when the person says Telegram, and http only for an app with no step of its own.",
  "To text the owner, use an sms step to +639170000000 as a placeholder and say in the summary that they should put their number in.",
  "An order, booking or inquiry with no source named comes in through a kymavo form, and a payment with no source named is a PayMongo payment. Use shopify_order only when the person says Shopify, and the email trigger only when they say emails come in.",
  "To watch a public page, such as a supplier's price, use a read_page step with a selector for the value. {{steps.<id>.output.changed}} is true when the value differs from the last run, so a condition with left {{steps.<id>.output.changed}}, op eq and right true can send the alert. read_page only reads public pages: it cannot log in or click.",
  'To bill a client, an invoice_pdf step draws the invoice and outputs {{steps.<id>.output.file}}, {{steps.<id>.output.total}} (pesos such as 1500.00, the amount a paymongo_link step takes) and {{steps.<id>.output.totalText}}. An email step sends the PDF with "attachments": ["{{steps.<id>.output.file}}"].',
  "shopify_create_product and shopify_update_product never take values from a form trigger, because anyone can fill in a form. When the person asks for that, do not ask about it: draft a manual trigger with example values in the step that they change before each run, and say so in the summary.",
  'A switch step compares "value" against up to 10 literal "cases" ({label, equals}) and uses "on": "<label>" or "on": "default" on outgoing edges. A transform step formats dates, pesos, PH mobile numbers, text case, splits or picks objects deterministically. A non-branching step that reaches an outside app may set "onError": "skip" (carry on) or "failed_edge" (follow its "on": "failed" edge); other steps may not.',
];

const EXAMPLE = JSON.stringify({ name: example.name, summary: example.description, definition: example.definition });

const system = (full: boolean) => [
  "You build workflow definitions for kymavo, a workflow automation tool. Reply with one JSON object and nothing else:",
  '{"name": "<short workflow name>", "summary": "<one sentence on what the workflow does, or what you changed>", "definition": <definition>}',
  "",
  ...spec(full),
  "",
  `Example, for "${example.description}":`,
  EXAMPLE,
].join("\n");

/**
 * The definition rules, for a prompt that answers in another shape (the chat in ai-chat.ts). `full` adds the triggers
 * and steps a small local model has no room for; callers pass it for a hosted model (isLocalModel in @daloy/db).
 */
export const definitionSpec = (full = false) => spec(full).join("\n");
/** A full worked example, so a small model copies the shape instead of inventing one. */
export const definitionExample = () => `Example, for "${example.description}":\n${EXAMPLE}`;

/** The request, and the current draft when changing one, go in the user message, never in the system prompt. */
export function draftPrompt(input: { request: string; current?: unknown }, full = false) {
  const content = input.current
    ? `Change this workflow definition:\n${JSON.stringify(input.current)}\n\nRequested change:\n${input.request}`
    : `Build a workflow for this request:\n${input.request}`;
  return { system: system(full), messages: [{ role: "user" as const, content }] };
}

// The outermost {...} in the reply, so text or a code fence around the JSON does not matter. When that does not parse,
// try ending at each earlier "}": models often close the object once too many ("...]}}}"), seen in the AI stress test.
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  for (let end = text.lastIndexOf("}"), tries = 0; end > start && tries < 4; end = text.lastIndexOf("}", end - 1), tries++) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // try the "}" before this one
    }
  }
  return undefined;
}

export function parseDraftReply(text: string): DraftResult {
  const json = extractJson(text);
  if (json === undefined || typeof json !== "object" || json === null) return { ok: false, errors: ["The reply was not a JSON object."] };
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 10).map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)) };
  return { ok: true, ...parsed.data };
}
