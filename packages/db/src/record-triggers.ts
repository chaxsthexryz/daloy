import { createHash } from "node:crypto";
import { definitionSchema, type Trigger, type WorkflowDefinition } from "@daloy/engine";
import { and, eq, sql } from "drizzle-orm";
import { connectionCredential, PROVIDER_NAMES } from "./connections";
import { createdSince, pollDelay, type TimeCursor, type TriggerConnection } from "./google-triggers";
import type { Db } from "./index";
import { notionId, oauthProvider, trelloAuthOf, withRecordAuth } from "./oauth";
import { airtableListRecords, notionQueryDatabase, ProviderError, trelloListActions, trelloListCards, type ProviderUrls } from "./providers";
import { createKeyedRun, publishedVersion, WorkflowPausedError } from "./runs";
import { connections, triggerPolls, workflows } from "./schema";
import { planOf, PLANS } from "./usage";

/**
 * G5 (decision 0134): Airtable, Notion and Trello triggers, read by polling via trigger_polls (migration 0056).
 * Pure helpers come first (connection/scope check, self-loop guard, cursors, status diffing, run keys), then the poll.
 */

export const RECORD_TRIGGER_APPS = { airtable_record: "airtable", notion_page: "notion", trello_card: "trello" } as const;
export type RecordTriggerType = keyof typeof RECORD_TRIGGER_APPS;
type RecordTrigger = Extract<Trigger, { type: RecordTriggerType }>;
export const isRecordTrigger = (type: string): type is RecordTriggerType => type in RECORD_TRIGGER_APPS;

const BASE_MS = 5 * 60_000;
const MAX_ITEMS_PER_POLL = 50;
const OVERLAP_MS = 2 * 60_000;

/** Why this trigger cannot read its record app now, in words for the owner, or null when it can. Needs no network. */
export function recordConnectionProblem(type: RecordTriggerType, conn: TriggerConnection): string | null {
  const name = PROVIDER_NAMES[RECORD_TRIGGER_APPS[type]];
  if (!conn) return `${name} is not connected. Connect it in Apps.`;
  if (conn.status !== "active") return `${name} stopped accepting kymavo's access. Reconnect ${name} in Apps.`;
  if (conn.authMethod === "oauth" && conn.scopes !== null) {
    const have = conn.scopes.split(/[\s,]+/).filter(Boolean);
    if (type === "airtable_record" && !have.includes("data.records:read")) {
      return "Airtable sign-in cannot read records yet. Connect Airtable with a personal access token (with data.records:read) in Apps.";
    }
    if (type === "trello_card" && !have.includes("read:board:trello")) {
      return "Reconnect Trello in Apps and allow board read access.";
    }
  }
  const dest = conn.destination;
  if (type === "airtable_record") {
    if (!dest?.baseId || !dest?.tableId) return "Pick a base and table for Airtable in Apps.";
    if (!dest.tableId.startsWith("tbl")) {
      return "Airtable is connected by table name, which can point to another table after a rename. Reconnect Airtable with the table id (it starts with tbl) in Apps.";
    }
  }
  if (type === "notion_page" && !dest?.databaseId) return "Pick a database for Notion in Apps.";
  if (type === "trello_card" && !dest?.listId) return "Pick a list for Trello in Apps.";
  return null;
}

/** An automation that would start itself again: it writes to the same record destination its trigger watches. */
export function recordSelfLoopProblem(def: WorkflowDefinition): string | null {
  const live = def.steps.filter((s) => !s.disabled);
  if (def.trigger.type === "airtable_record" && live.some((s) => s.type === "airtable")) {
    return "This automation adds records to the Airtable table it watches, so each record would start it again. Remove the Airtable step, or use another automation for it.";
  }
  if (def.trigger.type === "notion_page" && live.some((s) => s.type === "notion")) {
    return "This automation adds pages to the Notion database it watches, so each page would start it again. Remove the Notion step, or use another automation for it.";
  }
  if (def.trigger.type === "trello_card" && def.trigger.config.on === "created" && live.some((s) => s.type === "trello")) {
    return "This automation adds cards to the Trello list it watches, so each card would start it again. Remove the Trello step, or use another automation for it.";
  }
  return null;
}

/** Normalizes a field or cell value into a template-safe comparable string. */
export function statusValue(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) return raw.map((v) => statusValue(v)).filter(Boolean).join(", ");
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name === "string") return obj.name.trim();
    if (typeof obj.email === "string") return obj.email.trim();
    if (typeof obj.text === "string") return obj.text.trim();
    if (typeof obj.value === "string" || typeof obj.value === "number") return String(obj.value).trim();
  }
  return "";
}

/** Extracts plain text from one Notion property object. */
export function notionPropertyText(prop: unknown): string {
  if (prop === null || prop === undefined) return "";
  if (typeof prop !== "object") return statusValue(prop);
  const p = prop as Record<string, unknown>;
  const kind = typeof p.type === "string" ? p.type : undefined;
  const plain = (arr: unknown) =>
    Array.isArray(arr) ? arr.map((x) => (x && typeof x === "object" ? String((x as { plain_text?: unknown }).plain_text ?? "") : "")).join("").trim() : "";

  if (kind === "title" || (!kind && Array.isArray(p.title))) return plain(p.title);
  if (kind === "rich_text" || (!kind && Array.isArray(p.rich_text))) return plain(p.rich_text);
  if (kind === "status" || (!kind && p.status && typeof p.status === "object")) return statusValue((p.status as { name?: unknown } | null)?.name);
  if (kind === "select" || (!kind && p.select && typeof p.select === "object")) return statusValue((p.select as { name?: unknown } | null)?.name);
  if (kind === "multi_select") return Array.isArray(p.multi_select) ? p.multi_select.map((o) => statusValue((o as { name?: unknown })?.name)).filter(Boolean).join(", ") : "";
  if (kind === "number") return typeof p.number === "number" ? String(p.number) : "";
  if (kind === "checkbox") return typeof p.checkbox === "boolean" ? String(p.checkbox) : "";
  if (kind === "date") return statusValue((p.date as { start?: unknown } | null)?.start);
  if (kind === "email" || kind === "phone_number" || kind === "url" || kind === "created_time" || kind === "last_edited_time") {
    return typeof p[kind] === "string" ? (p[kind] as string).trim() : "";
  }
  if (kind === "formula" && p.formula && typeof p.formula === "object") {
    const f = p.formula as Record<string, unknown>;
    return statusValue(f.string ?? f.number ?? f.boolean ?? (f.date as { start?: unknown } | null)?.start);
  }
  if (kind === "unique_id" && p.unique_id && typeof p.unique_id === "object") {
    const u = p.unique_id as { prefix?: unknown; number?: unknown };
    if (typeof u.number !== "number") return "";
    return typeof u.prefix === "string" && u.prefix ? `${u.prefix}-${u.number}` : String(u.number);
  }
  return "";
}

/** Converts arbitrary field/property names into template-safe keys ({{trigger.cells.<key>}}). */
export function safeFields(raw: Record<string, unknown>, extract: (v: unknown) => string = statusValue): Record<string, string> {
  const cells: Record<string, string> = {};
  Object.entries(raw).forEach(([key, val], i) => {
    let name = key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || `field_${i + 1}`;
    if (!/^[a-z]/.test(name)) name = `col_${name}`;
    let unique = name;
    for (let n = 2; unique in cells; n++) unique = `${name}_${n}`;
    cells[unique] = extract(val);
  });
  return cells;
}

/**
 * Items created at or after cursor.since, sorted oldest-first and capped at max per poll.
 * First poll records now and returns none. If capped, cursor moves only to the last taken item.
 */
export function freshOldestFirst<T extends { at: string }>(cursor: TimeCursor | null, items: T[], now: Date, max = MAX_ITEMS_PER_POLL): { cursor: TimeCursor; fresh: T[] } {
  const ordered = [...items].filter((i) => !Number.isNaN(Date.parse(i.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!cursor) return createdSince(null, ordered, now, false);
  const since = Date.parse(cursor.since);
  const fresh = ordered.filter((i) => Date.parse(i.at) >= since);
  if (fresh.length <= max) {
    const next = Math.max(since, now.getTime() - OVERLAP_MS);
    return { cursor: { since: new Date(next).toISOString() }, fresh };
  }
  const taken = fresh.slice(0, max);
  const lastAt = Date.parse(taken[taken.length - 1]!.at);
  return { cursor: { since: new Date(Math.max(since, Math.min(lastAt, now.getTime()))).toISOString() }, fresh: taken };
}

export type StatusCursor = { statuses: Record<string, string>; seq: Record<string, number> };
export type StatusChange<T> = { item: T; status: string; previousStatus: string; seq: number };

/**
 * Detects non-empty status changes against the stored snapshot. First poll records the snapshot and emits none.
 * When more than max items changed at once, excess items keep their previous cursor state for the next poll.
 */
export function statusChanges<T extends { id: string }>(
  cursor: StatusCursor | null,
  items: T[],
  getStatus: (item: T) => string,
  max = MAX_ITEMS_PER_POLL,
  partial = false,
): { cursor: StatusCursor; changes: StatusChange<T>[] } {
  if (!cursor) {
    const statuses: Record<string, string> = {};
    for (const item of items) statuses[item.id] = getStatus(item);
    return { cursor: { statuses, seq: {} }, changes: [] };
  }
  const nextStatuses: Record<string, string> = partial ? { ...cursor.statuses } : {};
  const nextSeq: Record<string, number> = {};
  if (partial) {
    for (const [id, s] of Object.entries(cursor.seq)) nextSeq[id] = s;
  } else {
    for (const item of items) {
      if (item.id in cursor.seq) nextSeq[item.id] = cursor.seq[item.id]!;
    }
  }
  const changes: StatusChange<T>[] = [];
  for (const item of items) {
    const hasPrev = Object.hasOwn(cursor.statuses, item.id);
    const prev = hasPrev ? cursor.statuses[item.id]! : "";
    const next = getStatus(item);
    const changed = next !== "" && (!hasPrev || prev !== next);
    if (changed && changes.length < max) {
      const seq = (cursor.seq[item.id] ?? 0) + 1;
      changes.push({ item, status: next, previousStatus: prev, seq });
      nextStatuses[item.id] = next;
      nextSeq[item.id] = seq;
    } else if (changed) {
      if (hasPrev) nextStatuses[item.id] = prev;
      else delete nextStatuses[item.id];
    } else {
      nextStatuses[item.id] = next;
    }
  }
  return { cursor: { statuses: nextStatuses, seq: nextSeq }, changes };
}

export const statusRunKey = (prefix: string, id: string, seq: number, status: string) =>
  `${prefix}:${id}:status:${seq}:${createHash("sha256").update(status).digest("hex").slice(0, 12)}`;

// ---------------------------------------------------------------- the poll

export type RecordPollOptions = {
  db: Db;
  secretsKey: Buffer;
  urls: ProviderUrls;
  enqueue: (runId: string) => Promise<void>;
  limit?: number;
  intervalMs?: number;
};

type Item = { key: string; payload: Record<string, unknown> };

/** One short pass: claims due record-tool automations (SKIP LOCKED) and polls each. Returns how many it polled. */
export async function pollRecordTriggers(o: RecordPollOptions): Promise<number> {
  const { db } = o;
  await db.execute(
    sql`insert into trigger_polls (workflow_id) select workflow_id from triggers where type in ('airtable_record', 'notion_page', 'trello_card') on conflict do nothing`,
  );
  const claimed = await db.execute<{ workflow_id: string }>(sql`
    update trigger_polls set claim_until = now() + interval '2 minutes'
    where workflow_id in (
      select tp.workflow_id from trigger_polls tp
      join workflows w on w.id = tp.workflow_id
      join triggers t on t.workflow_id = tp.workflow_id
      where t.type in ('airtable_record', 'notion_page', 'trello_card')
        and tp.next_poll_at <= now() and (tp.claim_until is null or tp.claim_until < now()) and w.paused_at is null
      order by tp.next_poll_at limit ${o.limit ?? 10} for update of tp skip locked)
    returning workflow_id`);
  for (const { workflow_id } of claimed.rows) {
    await pollOne(o, workflow_id).catch((err: unknown) => {
      console.error(`record trigger poll failed for ${workflow_id}: ${err instanceof Error ? err.name : "error"}`);
    });
  }
  return claimed.rows.length;
}

async function pollOne(o: RecordPollOptions, workflowId: string) {
  const { db, secretsKey: key, urls } = o;
  const now = new Date();
  const [row] = await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, workflowId));
  const [wf] = await db.select({ userId: workflows.userId }).from(workflows).where(eq(workflows.id, workflowId));
  const version = await publishedVersion(db, workflowId);
  const parsed = version ? definitionSchema.safeParse(version.definition) : undefined;
  if (!row || !wf || !version || !parsed?.success || !isRecordTrigger(parsed.data.trigger.type)) {
    await db.delete(triggerPolls).where(eq(triggerPolls.workflowId, workflowId));
    return;
  }
  const def = parsed.data;
  const trigger = def.trigger as RecordTrigger;
  const app = RECORD_TRIGGER_APPS[trigger.type];
  const ws = wf.userId;
  const { plan } = await planOf(db, ws);
  const planMinutes = plan ? PLANS[plan].minScheduleMinutes : null;
  const later = (failures: number, retryAfterMs?: number) => new Date(now.getTime() + pollDelay(failures, retryAfterMs, o.intervalMs ? null : planMinutes, o.intervalMs));
  const save = (values: Partial<typeof triggerPolls.$inferInsert>) => db.update(triggerPolls).set({ claimUntil: null, ...values }).where(eq(triggerPolls.workflowId, workflowId));
  const pause = (problem: string) => save({ problem: problem.slice(0, 500), failures: 0, nextPollAt: new Date(now.getTime() + (o.intervalMs ?? BASE_MS)) });

  const conn = await connectionCredential(db, key, ws, app);
  const [meta] = await db.select({ scopes: connections.scopes }).from(connections).where(and(eq(connections.userId, ws), eq(connections.provider, app)));
  const problem =
    recordConnectionProblem(trigger.type, conn && { status: conn.status, authMethod: conn.authMethod, scopes: meta?.scopes ?? null, destination: conn.destination }) ??
    recordSelfLoopProblem(def);
  if (problem || !conn?.destination) return pause(problem ?? "Connect the app in Apps.");

  const dest = conn.destination;
  const source = sourceOf(trigger, dest);
  const cursor = row.source === source ? row.cursor : null;
  const oauth = conn.authMethod === "oauth" ? oauthProvider(app) : undefined;

  let read: { cursor: Record<string, unknown>; items: Item[] };
  try {
    read = await withRecordAuth(db, key, urls, ws, oauth, conn, (cred) => readRecordProvider(urls, trigger, dest, cursor, cred, conn.authMethod, now));
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    const name = PROVIDER_NAMES[app];
    if (err.kind === "quota" || err.kind === "unavailable" || err.kind === "ambiguous") {
      const failures = row.failures + 1;
      return save({ failures, problem: err.message.slice(0, 500), nextPollAt: later(failures, err.retryAfterMs) });
    }
    return pause(err.kind === "auth" ? `${name} stopped accepting kymavo's access. Reconnect ${name} in Apps.` : err.message);
  }

  // Runs first, cursor second: a crash in between reads the same items again, and run_keys finds the runs made.
  for (const item of read.items) {
    let started: { runId: string; duplicate?: true };
    try {
      started = await createKeyedRun(db, workflowId, version.id, item.payload, item.key);
    } catch (err) {
      if (err instanceof WorkflowPausedError) return save({ nextPollAt: later(0) });
      throw err;
    }
    if (!started.duplicate) await o.enqueue(started.runId);
  }
  await save({ source, cursor: read.cursor, failures: 0, problem: null, lastPolledAt: now, nextPollAt: later(0) });
}

function sourceOf(trigger: RecordTrigger, dest: Record<string, string>): string {
  if (trigger.type === "airtable_record") {
    return trigger.config.on === "status_changed"
      ? `airtable:${dest.baseId}:${dest.tableId}:status:${trigger.config.statusField}`
      : `airtable:${dest.baseId}:${dest.tableId}:created`;
  }
  if (trigger.type === "notion_page") {
    return trigger.config.on === "status_changed"
      ? `notion:${dest.databaseId}:status:${trigger.config.statusProperty}`
      : `notion:${dest.databaseId}:created`;
  }
  return `trello:${dest.listId}:${trigger.config.on}`;
}

const asTime = (c: Record<string, unknown> | null): TimeCursor | null => (c && typeof c.since === "string" ? { since: c.since } : null);
const asStatus = (c: Record<string, unknown> | null): StatusCursor | null =>
  c && c.statuses && typeof c.statuses === "object" && !Array.isArray(c.statuses)
    ? {
        statuses: c.statuses as Record<string, string>,
        seq: c.seq && typeof c.seq === "object" && !Array.isArray(c.seq) ? (c.seq as Record<string, number>) : {},
      }
    : null;

async function readRecordProvider(
  urls: ProviderUrls,
  trigger: RecordTrigger,
  dest: Record<string, string>,
  cursor: Record<string, unknown> | null,
  cred: string,
  authMethod: string,
  now: Date,
): Promise<{ cursor: Record<string, unknown>; items: Item[] }> {
  if (trigger.type === "airtable_record") {
    const baseId = dest.baseId!;
    const tableId = dest.tableId!;
    const { records, truncated } = await airtableListRecords(urls, cred, baseId, tableId);
    if (trigger.config.on === "status_changed") {
      const field = trigger.config.statusField!;
      const r = statusChanges(asStatus(cursor), records, (rec) => statusValue(rec.fields[field]), MAX_ITEMS_PER_POLL, truncated);
      return {
        cursor: r.cursor,
        items: r.changes.map((c) => ({
          key: statusRunKey(`airtable:${baseId}:${tableId}`, c.item.id, c.seq, c.status),
          payload: {
            baseId,
            tableId,
            event: "status_changed",
            recordId: c.item.id,
            createdTime: c.item.createdTime,
            fields: c.item.fields,
            cells: safeFields(c.item.fields),
            statusField: field,
            status: c.status,
            previousStatus: c.previousStatus,
          },
        })),
      };
    }
    const r = freshOldestFirst(asTime(cursor), records.map((rec) => ({ ...rec, at: rec.createdTime })), now);
    return {
      cursor: r.cursor,
      items: r.fresh.map((rec) => ({
        key: `airtable:${baseId}:${tableId}:${rec.id}:created`,
        payload: {
          baseId,
          tableId,
          event: "created",
          recordId: rec.id,
          createdTime: rec.createdTime,
          fields: rec.fields,
          cells: safeFields(rec.fields),
        },
      })),
    };
  }

  if (trigger.type === "notion_page") {
    const databaseId = dest.databaseId!;
    const titleProp = dest.titleProperty ?? "Name";
    const { pages, more } = await notionQueryDatabase(urls, cred, databaseId, trigger.config.on === "created" ? "created_time" : "last_edited_time");
    const pagePayload = (p: (typeof pages)[number]) => {
      const props = p.properties ?? {};
      const fields = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, notionPropertyText(v)]));
      const title = fields[titleProp] ?? Object.entries(props).map(([k, v]) => (v && typeof v === "object" && (v as { type?: unknown }).type === "title" ? fields[k] : "")).find(Boolean) ?? "";
      return { pageId: notionId(p.id), title, url: p.url ?? "", createdTime: p.created_time, lastEditedTime: p.last_edited_time, fields, cells: safeFields(fields, (v) => String(v ?? "")) };
    };
    if (trigger.config.on === "status_changed") {
      const prop = trigger.config.statusProperty!;
      const r = statusChanges(
        asStatus(cursor),
        pages.map((p) => ({ ...p, id: notionId(p.id) })),
        (p) => notionPropertyText(p.properties?.[prop]),
        MAX_ITEMS_PER_POLL,
        more,
      );
      return {
        cursor: r.cursor,
        items: r.changes.map((c) => ({
          key: statusRunKey(`notion:${databaseId}`, c.item.id, c.seq, c.status),
          payload: {
            databaseId,
            event: "status_changed",
            ...pagePayload(c.item),
            statusProperty: prop,
            status: c.status,
            previousStatus: c.previousStatus,
          },
        })),
      };
    }
    const r = freshOldestFirst(asTime(cursor), pages.map((p) => ({ ...p, at: p.created_time })), now);
    return {
      cursor: r.cursor,
      items: r.fresh.map((p) => ({
        key: `notion:${databaseId}:${notionId(p.id)}:created`,
        payload: {
          databaseId,
          event: "created",
          ...pagePayload(p),
        },
      })),
    };
  }

  const listId = dest.listId!;
  const trelloAuth = trelloAuthOf(authMethod, cred);
  const filter = trigger.config.on === "moved_to_list" ? "updateCard:idList" : "createCard";
  const actions = await trelloListActions(urls, trelloAuth, listId, filter);
  const matching = actions.filter((a) =>
    trigger.config.on === "moved_to_list"
      ? a.type === "updateCard" && a.data?.listAfter?.id === listId
      : a.type === "createCard" && (!a.data?.list?.id || a.data.list.id === listId),
  );
  const prev = asTime(cursor);
  const r = freshOldestFirst(prev, matching.map((a) => ({ ...a, at: a.date })), now);
  const cards = r.fresh.length ? await trelloListCards(urls, trelloAuth, listId) : [];
  const byCardId = new Map(cards.map((c) => [c.id, c]));
  return {
    cursor: r.cursor,
    items: r.fresh.map((a) => {
      const cardId = a.data?.card?.id ?? a.id;
      const card = byCardId.get(cardId);
      const listName = a.data?.listAfter?.name ?? a.data?.list?.name ?? dest.listName ?? "";
      const boardId = a.data?.board?.id ?? dest.boardId ?? "";
      return {
        key: trigger.config.on === "moved_to_list" ? `trello:${listId}:${a.id}:moved` : `trello:${listId}:${cardId}:created`,
        payload: {
          listId,
          listName,
          boardId,
          event: trigger.config.on,
          cardId,
          name: card?.name ?? a.data?.card?.name ?? "",
          desc: card?.desc ?? "",
          url: card?.url ?? "",
          shortUrl: card?.shortUrl ?? "",
          ...(trigger.config.on === "moved_to_list" ? { previousListId: a.data?.listBefore?.id ?? "", previousListName: a.data?.listBefore?.name ?? "" } : {}),
        },
      };
    }),
  };
}

function destinationLabel(type: RecordTriggerType, d: Record<string, string> | null | undefined): string | null {
  if (!d) return null;
  if (type === "airtable_record") return d.tableName ?? d.tableId ?? null;
  if (type === "notion_page") return d.databaseTitle ?? d.databaseId ?? null;
  return d.listName ?? d.listId ?? null;
}

/** What the editor shows under a record trigger: whether the connection is ready, and what the watcher last did. */
export async function recordTriggerStatus(db: Db, workspaceId: string, type: RecordTriggerType, workflowId?: string) {
  const app = RECORD_TRIGGER_APPS[type];
  const [c] = await db
    .select({ status: connections.status, authMethod: connections.authMethod, scopes: connections.scopes, destination: connections.destination })
    .from(connections)
    .where(and(eq(connections.userId, workspaceId), eq(connections.provider, app)));
  const problem = recordConnectionProblem(type, c ?? null);
  const watching = workflowId
    ? (
        await db
          .select({ problem: triggerPolls.problem, failures: triggerPolls.failures, started: sql<boolean>`${triggerPolls.cursor} is not null`, lastPolledAt: triggerPolls.lastPolledAt, nextPollAt: triggerPolls.nextPollAt })
          .from(triggerPolls)
          .innerJoin(workflows, eq(workflows.id, triggerPolls.workflowId))
          .where(and(eq(triggerPolls.workflowId, workflowId), eq(workflows.userId, workspaceId)))
      )[0] ?? null
    : null;
  return { app, problem, destination: destinationLabel(type, c?.destination), watching };
}
