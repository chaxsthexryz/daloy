import { BRANCHES, mockAiOutput, stepEntry, triggerEntry, type Step } from "@daloy/engine";
import { entryOf, type Draft } from "./graph";

/** What happens after a step: one path per outgoing edge, each the chain of steps until a fork, a join already listed, or the end. */
export function nextPaths(draft: Draft, id: string): { on?: string; steps: Step[] }[] {
  const byId = new Map(draft.steps.map((s) => [s.id, s]));
  const outgoing = (from: string) => draft.edges.filter((e) => e.from === from);
  const starts = id === "trigger" ? (entryOf(draft) ? [{ on: undefined, to: entryOf(draft)!.id }] : []) : outgoing(id).map((e) => ({ on: e.on, to: e.to }));
  return starts.map(({ on, to }) => {
    const steps: Step[] = [];
    for (let at: string | undefined = to; at && byId.has(at) && !steps.some((s) => s.id === at); ) {
      steps.push(byId.get(at)!);
      const next = outgoing(at);
      at = next.length === 1 ? next[0]!.to : undefined;
    }
    return { on, steps };
  });
}

const EMAIL_FIELDS = ["from", "subject", "text"];
const META_DM_FIELDS = ["channel", "senderId", "messageId", "text", "timestamp"];
const TELEGRAM_FIELDS = ["text", "chatId", "fromName", "username", "date", "fileRefused"];
const SHOPIFY_ORDER_FIELDS = ["order_number", "order_id", "customer_name", "customer_email", "customer_phone", "total", "currency", "item_count", "items", "financial_status", "created_at", "shop"];
// G2 (decision 0127). A sheet row's header cells are {{trigger.cells.<header>}}, which depend on the sheet.
const GOOGLE_TRIGGER_FIELDS: Record<string, string[]> = {
  sheets_row: ["rowNumber", "values", "cells", "tab", "spreadsheetId"],
  calendar_event: ["title", "start", "end", "location", "description", "link", "eventId", "event"],
  drive_file: ["name", "mimeType", "size", "link", "createdTime", "fileId", "fileSkipped"],
};
const RECORD_TRIGGER_FIELDS: Record<string, string[]> = {
  airtable_record: ["recordId", "fields", "cells", "createdTime", "event", "status", "previousStatus", "baseId", "tableId"],
  notion_page: ["pageId", "title", "fields", "cells", "url", "createdTime", "lastEditedTime", "event", "status", "previousStatus", "databaseId"],
  trello_card: ["cardId", "name", "desc", "url", "shortUrl", "listId", "listName", "boardId", "event", "previousListId", "previousListName"],
};
const BOOKING_EVENT_FIELDS = ["event", "bookingId", "reference", "resourceId", "resourceName", "start", "end", "minutes", "timezone", "status", "version", "mode", "nights", "checkIn", "checkOut", "conversationId"];
const PAYMENT_EVENT_FIELDS = ["event", "dueId", "reference", "kind", "status", "amountCentavos", "amountPesos", "bookingId", "conversationId"];

/** Every step that can have run before this one: reachable backwards along edges. A sibling branch and anything after it are not; the step itself never is. */
export function upstreamIds(draft: Draft, id: string): Set<string> {
  const before = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const to = queue.pop()!;
    for (const e of draft.edges) {
      if (e.to !== to || before.has(e.from)) continue;
      before.add(e.from);
      queue.push(e.from);
    }
  }
  before.delete(id);
  return before;
}

/** The template references a step can use: the trigger's fields, then the output of each step that runs before it, in step order. */
export function insertables(draft: Draft, id: string): string[] {
  const trigger = draft.trigger;
  const fields =
    trigger.type === "email"
      ? EMAIL_FIELDS
      : trigger.type === "meta_dm"
        ? META_DM_FIELDS
        : trigger.type === "shopify_order"
          ? SHOPIFY_ORDER_FIELDS
          : trigger.type === "telegram_message"
            ? TELEGRAM_FIELDS
            : trigger.type === "booking_event"
              ? BOOKING_EVENT_FIELDS
              : trigger.type === "payment_event"
                ? PAYMENT_EVENT_FIELDS
                : GOOGLE_TRIGGER_FIELDS[trigger.type]
                  ? GOOGLE_TRIGGER_FIELDS[trigger.type]!
                : RECORD_TRIGGER_FIELDS[trigger.type]
                  ? RECORD_TRIGGER_FIELDS[trigger.type]!
                : trigger.type === "form" || trigger.type === "webhook" || trigger.type === "sub_workflow"
                  ? (trigger.config.fields ?? []).map((f) => f.name)
                  : [];
  const before = upstreamIds(draft, id);
  const outputs = draft.steps
    .filter((s) => before.has(s.id))
    .flatMap((s) => (s.type === "ai" ? Object.keys(mockAiOutput(s.config)).map((k) => `steps.${s.id}.output.${k}`) : s.type === "booking" ? ["reference", "start", "end", "nights", "checkIn", "checkOut", "timezone"].map((k) => `steps.${s.id}.output.${k}`) : s.type === "stay_quote" ? ["title", "checkIn", "guests", "subtotal", "extraGuests", "extraGuestFee", "total", "deposit", "knowledgeVersion"].map((k) => `steps.${s.id}.output.${k}`) : s.type === "read_page" ? ["title", "text", "value", "previous", "changed"].map((k) => `steps.${s.id}.output.${k}`) : s.type === "google_docs" ? ["url", "documentId", "name"].map((k) => `steps.${s.id}.output.${k}`) : s.type === "call_workflow" ? ["runId", "workflowId", "workflowSlug", "duplicate"].map((k) => `steps.${s.id}.output.${k}`) : s.type === "browser" ? [...s.config.actions.flatMap((a) => (a.action === "extract" ? [a.name] : [])), "url"].map((k) => `steps.${s.id}.output.${k}`) : [`steps.${s.id}.output`]));
  return [...fields.map((f) => `trigger.${f}`), ...outputs].map((r) => `{{${r}}}`);
}

/** Step types that need a connected app, with the provider name GET /settings/connections uses. */
// ponytail: copy of NEEDS in BuildWithAi.tsx; share one map when that file is next open for edits.
const NEEDS: Record<string, { provider: string; label: string }> = {
  sheets: { provider: "google_sheets", label: "Google Sheet" },
  slack: { provider: "slack", label: "Slack" },
  outlook: { provider: "outlook", label: "Outlook" },
  teams: { provider: "teams", label: "Teams" },
  drive: { provider: "google_drive", label: "Google Drive" },
  calendar: { provider: "google_calendar", label: "Google Calendar" },
  telegram: { provider: "telegram", label: "Telegram" },
  airtable: { provider: "airtable", label: "Airtable" },
  notion: { provider: "notion", label: "Notion" },
  trello: { provider: "trello", label: "Trello" },
  discord: { provider: "discord", label: "Discord" },
  google_docs: { provider: "google_drive", label: "Google Drive" },
  paymongo_link: { provider: "paymongo", label: "PayMongo" },
  payment_status: { provider: "paymongo", label: "PayMongo" },
  meta_reply: { provider: "meta_messenger", label: "Facebook Messenger & Instagram" },
  shopify_create_product: { provider: "shopify", label: "Shopify" },
  shopify_update_product: { provider: "shopify", label: "Shopify" },
};

function paymentApps(step: Extract<Step, { type: "payment_due" }>) {
  const apps = [];
  if (step.config.checkout) apps.push(NEEDS.paymongo_link!);
  if (step.config.channel === "messenger") apps.push(NEEDS.meta_reply!);
  return apps;
}

export type AppNeed = { provider: string; label: string; connected: boolean; steps: string[] };

/** Each app the draft's steps need, once, in step order, with whether the workspace has it connected. */
export function setupLeft(draft: Draft, connected: ReadonlySet<string>): AppNeed[] {
  const needs = new Map<string, AppNeed>();
  for (const s of draft.steps) {
    const apps = s.type === "payment_due" ? paymentApps(s) : [NEEDS[s.type]];
    for (const app of apps) {
      if (!app) continue;
      const need = needs.get(app.provider) ?? { ...app, connected: connected.has(app.provider), steps: [] };
      need.steps.push(s.id);
      needs.set(app.provider, need);
    }
  }
  return [...needs.values()];
}

export type ConnInfo = { provider: string; status: string; destination?: Record<string, string> | null };

/** The name of what the owner picked in Apps for a connection: a sheet, channel, chat, table, list or database. */
export function destinationName(c: ConnInfo): string | undefined {
  const d = c.destination;
  return (d && (d.title || d.channelName || d.chatTitle || d.tableName || d.listName || d.databaseTitle)) || undefined;
}

/** Each step's destination name, for the line under its title. Steps whose app has none picked are left out. */
export function chosenFor(draft: Draft, conns: readonly ConnInfo[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of draft.steps) {
    const provider = stepEntry(s.type).provider;
    const c = provider && conns.find((x) => x.provider === provider);
    const name = c ? destinationName(c) : undefined;
    if (name) out.set(s.id, name);
  }
  return out;
}

/**
 * The app each node needs and does not have yet, by node id ("trigger" for the trigger), named in English. An email
 * step needs Gmail only when no sender can send: mailReady is false when the workspace has no Gmail sender and the installation has none either.
 */
export function unconnectedNodes(draft: Draft, connected: ReadonlySet<string>, mailReady: boolean): Map<string, string> {
  const out = new Map<string, string>();
  const check = (id: string, entry: ReturnType<typeof stepEntry>) => {
    // SMS is the server's own, never connected by a workspace (decision 0100).
    if (!entry.provider || !entry.app || entry.provider === "unisms") return;
    const ok = entry.provider === "gmail" ? mailReady : connected.has(entry.provider);
    if (!ok) out.set(id, entry.app.en);
  };
  check("trigger", triggerEntry(draft.trigger.type));
  for (const step of draft.steps) {
    if (step.type === "payment_due") {
      const missing = paymentApps(step).filter(app => !connected.has(app.provider));
      if (missing.length) out.set(step.id, missing.map(app => app.label).join(", "));
    } else {
      check(step.id, stepEntry(step.type));
    }
  }
  return out;
}

/** Exits on `nodeId` that do not yet lead to a next step; primary branches exclude optional `condition.invalid`. */
export function openExits(draft: Draft, nodeId: string): { on?: string }[] {
  if (nodeId === "trigger") return draft.steps.length === 0 ? [{}] : [];
  const step = draft.steps.find((s) => s.id === nodeId);
  if (!step) return [];
  const branches =
    step.type === "condition"
      ? (["true", "false"] as const)
      : step.type === "booking"
        ? step.config.action === "create"
          ? (["done", "taken"] as const)
          : (["done", "not_found"] as const)
        : BRANCHES[step.type];
  if (!branches) return draft.edges.some((e) => e.from === nodeId) ? [] : [{}];
  const taken = new Set(draft.edges.filter((e) => e.from === nodeId && e.on).map((e) => e.on!));
  return branches.filter((on) => !taken.has(on)).map((on) => ({ on }));
}
