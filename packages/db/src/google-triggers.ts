import { createHash, randomUUID } from "node:crypto";
import { definitionSchema, FILE_MAX_BYTES, fileType, safeFileName, type FileRef, type Trigger, type WorkflowDefinition } from "@daloy/engine";
import { and, eq, sql } from "drizzle-orm";
import { connectionCredential, PROVIDER_NAMES } from "./connections";
import { withGoogle } from "./google-access";
import type { Db } from "./index";
import { GOOGLE_FEATURE_SCOPES } from "./oauth/google";
import { calendarEventsBetween, calendarEventsSince, driveDownload, driveFilesSince, ProviderError, sheetValues, type GoogleAuth, type GoogleEvent, type ProviderUrls } from "./providers";
import { createKeyedRun, publishedVersion, WorkflowPausedError } from "./runs";
import { connections, triggerPolls, workflows, type AuthMethod } from "./schema";
import type { NewUpload } from "./uploads";
import { planOf, PLANS, QuotaError, usageSummary } from "./usage";

/**
 * G2 (decision 0127): Google Workspace triggers, read by polling. The pure parts come first (cursors, the first-poll
 * rule, run keys, the connection and scope check, backoff, self-loops), then the poll the worker runs.
 */

export const GOOGLE_TRIGGER_APPS = { sheets_row: "google_sheets", calendar_event: "google_calendar", drive_file: "google_drive" } as const;
export type GoogleTriggerType = keyof typeof GOOGLE_TRIGGER_APPS;
type GoogleTrigger = Extract<Trigger, { type: GoogleTriggerType }>;
export const isGoogleTrigger = (type: string): type is GoogleTriggerType => type in GOOGLE_TRIGGER_APPS;

const FEATURE = { sheets_row: "sheets", calendar_event: "calendar", drive_file: "drive" } as const;
// The words Google shows for each scope on its consent page, so the owner knows which box to leave ticked.
const SCOPE_LABELS: Record<string, string> = {
  "https://www.googleapis.com/auth/drive.file": "See, edit, create and delete only the specific Google Drive files you use with this app",
  "https://www.googleapis.com/auth/calendar.app.created": "Make secondary Google calendars, and see, create, change and delete events on them",
};
const DESTINATION = {
  sheets_row: { key: "spreadsheetId", ask: "Pick a sheet for Google Sheets in Apps." },
  calendar_event: { key: "calendarId", ask: "Choose a calendar for Google Calendar in Apps." },
  drive_file: { key: "folderId", ask: "Pick a folder for Google Drive in Apps." },
} as const;

export type TriggerConnection = { status: "active" | "failed"; authMethod: AuthMethod; scopes: string | null; destination: Record<string, string> | null } | null;

/** Why this trigger cannot read Google now, in words for the owner, or null when it can. Needs no network. */
export function connectionProblem(type: GoogleTriggerType, conn: TriggerConnection): string | null {
  const name = PROVIDER_NAMES[GOOGLE_TRIGGER_APPS[type]];
  if (!conn) return `${name} is not connected. Connect it in Apps.`;
  if (conn.status !== "active") return `${name} stopped accepting kymavo's access. Reconnect ${name} in Apps.`;
  // A service account key has no stored scopes: the read itself checks it, and a refusal names what to share.
  if (conn.authMethod === "oauth" && conn.scopes !== null) {
    const have = conn.scopes.split(/[\s,]+/);
    const missing = GOOGLE_FEATURE_SCOPES[FEATURE[type]].filter((s) => !have.includes(s));
    if (missing.length) return `Reconnect ${name} in Apps and leave this permission ticked on Google's page: "${missing.map((s) => SCOPE_LABELS[s] ?? s).join('", "')}".`;
  }
  if (!conn.destination?.[DESTINATION[type].key]) return DESTINATION[type].ask;
  return null;
}

/** An automation that would start itself again: it writes to what its own trigger watches. */
export function selfLoopProblem(def: WorkflowDefinition, destination: Record<string, string> | null | undefined): string | null {
  const live = def.steps.filter((s) => !s.disabled);
  if (def.trigger.type === "sheets_row" && destination?.tab === def.trigger.config.tab && live.some((s) => s.type === "sheets")) {
    return `This automation adds rows to the same tab it watches ("${def.trigger.config.tab}"), so each row would start it again. Watch another tab, or pick another tab for Google Sheets in Apps.`;
  }
  if (def.trigger.type === "drive_file" && live.some((s) => s.type === "drive" || s.type === "google_docs")) {
    return "This automation saves files to the Drive folder it watches, so each file would start it again. Remove the Drive step, or use another automation for it.";
  }
  return null;
}

export type RowCursor = { rows: number };
export type SheetRow = { rowNumber: number; values: string[] };

/** New rows below the cursor, at most max a poll. The first poll (no cursor) records the count and returns none. */
export function newRows(cursor: RowCursor | null, values: string[][], max = 50): { cursor: RowCursor; rows: SheetRow[] } {
  if (!cursor || values.length < cursor.rows) return { cursor: { rows: values.length }, rows: [] };
  const end = Math.min(values.length, cursor.rows + max);
  const rows: SheetRow[] = [];
  for (let i = cursor.rows; i < end; i++) if (values[i]!.some((v) => v.trim() !== "")) rows.push({ rowNumber: i + 1, values: values[i]! });
  return { cursor: { rows: end }, rows };
}

/** The row's run key. The hash tells a row typed into the place of a deleted one from the row that was there. */
export const rowKey = (spreadsheetId: string, tab: string, row: SheetRow) =>
  `sheets:${spreadsheetId}:${tab}:${row.rowNumber}:${createHash("sha256").update(JSON.stringify(row.values)).digest("hex").slice(0, 16)}`;

const column = (i: number): string => (i < 26 ? String.fromCharCode(97 + i) : column(Math.floor(i / 26) - 1) + column(i % 26));

/** Cells named after the header row as template-safe keys: "Customer Name" is {{trigger.cells.customer_name}}. */
export function rowCells(header: string[], values: string[]): Record<string, string> {
  const cells: Record<string, string> = {};
  values.forEach((value, i) => {
    let name = (header[i] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || column(i);
    if (!/^[a-z]/.test(name)) name = `col_${name}`;
    let unique = name;
    for (let n = 2; unique in cells; n++) unique = `${name}_${n}`;
    cells[unique] = value;
  });
  return cells;
}

export type TimeCursor = { since: string };
const OVERLAP_MS = 2 * 60_000;

/**
 * Items created at or after the cursor. The first poll records now and returns none. The cursor then steps to two
 * minutes before now (never back), so clock skew loses nothing; run keys make the overlap harmless. more: Google has
 * another page, so the cursor moves only to the last item read.
 */
export function createdSince<T extends { at: string }>(cursor: TimeCursor | null, items: T[], now: Date, more: boolean): { cursor: TimeCursor; fresh: T[] } {
  if (!cursor) return { cursor: { since: now.toISOString() }, fresh: [] };
  const since = Date.parse(cursor.since);
  const fresh = items.filter((i) => Date.parse(i.at) >= since);
  const last = items.length ? Math.max(...items.map((i) => Date.parse(i.at))) : since;
  const next = more ? last : Math.max(since, now.getTime() - OVERLAP_MS);
  return { cursor: { since: new Date(Math.max(since, next)).toISOString() }, fresh };
}

/**
 * Events whose reminder time (start minus minutesBefore) came after the cursor and that have not started. The first
 * poll records now, so events already inside the window when the trigger was turned on do not remind. All-day events
 * and cancelled ones are skipped.
 */
export function startingSoon<T extends { id: string; status?: string; start?: { dateTime?: string; date?: string } }>(cursor: TimeCursor | null, events: T[], now: Date, minutesBefore: number) {
  if (!cursor) return { cursor: { since: now.toISOString() }, due: [] as (T & { start: string })[] };
  const since = Date.parse(cursor.since);
  const due: (T & { start: string })[] = [];
  for (const e of events) {
    const start = e.start?.dateTime ? Date.parse(e.start.dateTime) : NaN;
    if (e.status === "cancelled" || Number.isNaN(start)) continue;
    const remind = start - minutesBefore * 60_000;
    if (remind > since && remind <= now.getTime() && start > now.getTime()) due.push({ ...e, start: new Date(start).toISOString() });
  }
  return { cursor, due };
}

const BASE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** Time to the next poll: 5 minutes or the plan's minimum schedule interval; after failures, doubled up to an hour, or Retry-After when longer. */
export function pollDelay(failures: number, retryAfterMs: number | undefined, planMinutes: number | null, baseMs = BASE_MS): number {
  const normal = Math.max(baseMs, (planMinutes ?? 0) * 60_000);
  if (failures === 0) return normal;
  return Math.max(Math.min(baseMs * 2 ** failures, MAX_BACKOFF_MS), retryAfterMs ?? 0, normal);
}

// ---------------------------------------------------------------- the poll

export type GooglePollOptions = {
  db: Db;
  secretsKey: Buffer;
  urls: ProviderUrls;
  enqueue: (runId: string) => Promise<void>;
  /** Automations polled per call. */
  limit?: number;
  /** Replaces the 5 minute base and the plan minimum, for the e2e suite. */
  intervalMs?: number;
};
type Item = { key: string; payload: Record<string, unknown>; file?: { name: string; type: NewUpload["type"]; data: Buffer } };

/** One short pass: claims due automations (SKIP LOCKED, so workers share them) and polls each. Returns how many it polled. */
export async function pollGoogleTriggers(o: GooglePollOptions): Promise<number> {
  const { db } = o;
  await db.execute(sql`insert into trigger_polls (workflow_id) select workflow_id from triggers where type in ('sheets_row', 'calendar_event', 'drive_file') on conflict do nothing`);
  const claimed = await db.execute<{ workflow_id: string }>(sql`
    update trigger_polls set claim_until = now() + interval '2 minutes'
    where workflow_id in (
      select tp.workflow_id from trigger_polls tp
      join workflows w on w.id = tp.workflow_id
      join triggers t on t.workflow_id = tp.workflow_id
      where t.type in ('sheets_row', 'calendar_event', 'drive_file') and tp.next_poll_at <= now() and (tp.claim_until is null or tp.claim_until < now()) and w.paused_at is null
      order by tp.next_poll_at limit ${o.limit ?? 10} for update of tp skip locked)
    returning workflow_id`);
  for (const { workflow_id } of claimed.rows) {
    await pollOne(o, workflow_id).catch((err: unknown) => {
      // Unexpected (a bug or the database): the claim lapses and the next pass tries again. Never logs Google's answer.
      console.error(`google trigger poll failed for ${workflow_id}: ${err instanceof Error ? err.name : "error"}`);
    });
  }
  return claimed.rows.length;
}

async function pollOne(o: GooglePollOptions, workflowId: string) {
  const { db, secretsKey: key, urls } = o;
  const now = new Date();
  const [row] = await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, workflowId));
  const [wf] = await db.select({ userId: workflows.userId }).from(workflows).where(eq(workflows.id, workflowId));
  const version = await publishedVersion(db, workflowId);
  const parsed = version ? definitionSchema.safeParse(version.definition) : undefined;
  if (!row || !wf || !version || !parsed?.success || !isGoogleTrigger(parsed.data.trigger.type)) {
    await db.delete(triggerPolls).where(eq(triggerPolls.workflowId, workflowId));
    return;
  }
  const def = parsed.data;
  const trigger = def.trigger as GoogleTrigger;
  const app = GOOGLE_TRIGGER_APPS[trigger.type];
  const ws = wf.userId;
  const { plan } = await planOf(db, ws);
  const planMinutes = plan ? PLANS[plan].minScheduleMinutes : null;
  const later = (failures: number, retryAfterMs?: number) => new Date(now.getTime() + pollDelay(failures, retryAfterMs, o.intervalMs ? null : planMinutes, o.intervalMs));
  const save = (values: Partial<typeof triggerPolls.$inferInsert>) => db.update(triggerPolls).set({ claimUntil: null, ...values }).where(eq(triggerPolls.workflowId, workflowId));
  // Paused: checked again every 5 minutes whatever the plan, so fixing the connection resumes it soon.
  const pause = (problem: string) => save({ problem: problem.slice(0, 500), failures: 0, nextPollAt: new Date(now.getTime() + (o.intervalMs ?? BASE_MS)) });

  const conn = await connectionCredential(db, key, ws, app);
  const [meta] = await db.select({ scopes: connections.scopes }).from(connections).where(and(eq(connections.userId, ws), eq(connections.provider, app)));
  const problem = connectionProblem(trigger.type, conn && { status: conn.status, authMethod: conn.authMethod, scopes: meta?.scopes ?? null, destination: conn.destination }) ?? selfLoopProblem(def, conn?.destination);
  if (problem || !conn?.destination) return pause(problem ?? DESTINATION[trigger.type].ask);
  const dest = conn.destination;
  const source = sourceOf(trigger, dest);
  const cursor = row.source === source ? row.cursor : null;

  let read: { cursor: Record<string, unknown>; items: Item[] };
  try {
    read = await withGoogle(db, key, urls, ws, app, conn, (auth) => readGoogle(o, ws, trigger, dest, cursor, auth, now));
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    const name = PROVIDER_NAMES[app];
    if (err.kind === "quota" || err.kind === "unavailable" || err.kind === "ambiguous") {
      const failures = row.failures + 1;
      return save({ failures, problem: err.message.slice(0, 500), nextPollAt: later(failures, err.retryAfterMs) });
    }
    return pause(err.kind === "auth" ? `${name} stopped accepting kymavo's access. Reconnect ${name} in Apps.` : err.message);
  }

  // Runs first, cursor second: a crash in between reads the same items again, and their keys find the runs made.
  const requireFile = trigger.type === "drive_file" && trigger.config.requireFile;
  for (const item of read.items) {
    if (requireFile && !item.file) continue;
    const files: NewUpload[] = item.file ? [{ id: randomUUID(), field: "file", ...item.file }] : [];
    const refs: FileRef[] = files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.data.length }));
    const payload = trigger.type === "drive_file" ? { ...item.payload, file: refs } : item.payload;
    const opts = files.length ? { uploads: { userId: ws, files, claimKey: `drive-upload:${workflowId}:${item.key}` } } : {};
    let started: { runId: string; duplicate?: true } | null;
    try {
      started = await createKeyedRun(db, workflowId, version.id, payload, item.key, opts).catch(async (err: unknown) => {
        // Out of upload space: start without the file, unless the trigger needs it.
        if (!(err instanceof QuotaError)) throw err;
        return requireFile ? null : createKeyedRun(db, workflowId, version.id, { ...item.payload, file: [], fileSkipped: "quota" }, item.key);
      });
    } catch (err) {
      // Paused between the claim and now: keep the cursor, so these items start once it is resumed.
      if (err instanceof WorkflowPausedError) return save({ nextPollAt: later(0) });
      throw err;
    }
    if (started && !started.duplicate) await o.enqueue(started.runId);
  }
  await save({ source, cursor: read.cursor, failures: 0, problem: null, lastPolledAt: now, nextPollAt: later(0) });
}

function sourceOf(trigger: GoogleTrigger, dest: Record<string, string>) {
  if (trigger.type === "sheets_row") return `sheets:${dest.spreadsheetId}:${trigger.config.tab}`;
  if (trigger.type === "calendar_event") return `calendar:${dest.calendarId}:${trigger.config.on}`;
  return `drive:${dest.folderId}`;
}

const asTime = (c: Record<string, unknown> | null): TimeCursor | null => (c && typeof c.since === "string" ? { since: c.since } : null);
const eventPayload = (calendarId: string, event: "created" | "starting", e: GoogleEvent) => ({
  calendarId,
  event,
  eventId: e.id,
  title: e.summary ?? "",
  description: e.description ?? "",
  location: e.location ?? "",
  start: e.start?.dateTime ?? e.start?.date ?? "",
  end: e.end?.dateTime ?? e.end?.date ?? "",
  link: e.htmlLink ?? "",
});
const KEPT = new Set(["jpeg", "png", "webp", "heic", "pdf"]);

async function readGoogle(o: GooglePollOptions, ws: string, trigger: GoogleTrigger, dest: Record<string, string>, cursor: Record<string, unknown> | null, auth: GoogleAuth, now: Date): Promise<{ cursor: Record<string, unknown>; items: Item[] }> {
  if (trigger.type === "sheets_row") {
    const { tab } = trigger.config;
    const spreadsheetId = dest.spreadsheetId!;
    const values = await sheetValues(o.urls, auth, spreadsheetId, tab).catch((err: unknown) => {
      if (err instanceof ProviderError && err.kind === "invalid") throw new ProviderError(`The tab "${tab}" is not in the spreadsheet. Choose another tab in the trigger.`, "invalid");
      throw err;
    });
    const r = newRows(cursor && typeof cursor.rows === "number" ? { rows: cursor.rows } : null, values);
    const header = values[0] ?? [];
    return { cursor: r.cursor, items: r.rows.map((row) => ({ key: rowKey(spreadsheetId, tab, row), payload: { spreadsheetId, tab, rowNumber: row.rowNumber, values: row.values, cells: rowCells(header, row.values) } })) };
  }
  if (trigger.type === "calendar_event") {
    const calendarId = dest.calendarId!;
    const prev = asTime(cursor);
    if (trigger.config.on === "starting") {
      const events = prev ? await calendarEventsBetween(o.urls, auth, calendarId, now.toISOString(), new Date(now.getTime() + trigger.config.minutesBefore * 60_000).toISOString()) : [];
      const r = startingSoon(prev, events, now, trigger.config.minutesBefore);
      return { cursor: r.cursor, items: r.due.map((e) => ({ key: `gcal:${calendarId}:${e.id}:starting:${e.start}`, payload: eventPayload(calendarId, "starting", e) })) };
    }
    const page = prev ? await calendarEventsSince(o.urls, auth, calendarId, prev.since) : { items: [], more: false };
    // The cursor follows changes (updated); only events created since then are new.
    const changed = page.items.filter((e) => e.status !== "cancelled" && e.created).map((e) => ({ ...e, at: e.updated ?? e.created! }));
    const r = createdSince(prev, changed, now, page.more);
    const since = prev ? Date.parse(prev.since) : 0;
    return { cursor: r.cursor, items: r.fresh.filter((e) => Date.parse(e.created!) >= since).map((e) => ({ key: `gcal:${calendarId}:${e.id}:created`, payload: eventPayload(calendarId, "created", e) })) };
  }
  const folderId = dest.folderId!;
  const prev = asTime(cursor);
  const page = prev ? await driveFilesSince(o.urls, auth, folderId, prev.since) : { files: [], more: false };
  const r = createdSince(prev, page.files.map((f) => ({ ...f, at: f.createdTime })), now, page.more);
  const room = r.fresh.length ? await usageSummary(o.db, ws) : null;
  let left = room && room.upload.limit !== null ? room.upload.limit - room.upload.used : Infinity;
  const items: Item[] = [];
  for (const f of r.fresh) {
    const size = f.size === undefined ? undefined : Number(f.size);
    const payload: Record<string, unknown> = { folderId, fileId: f.id, name: f.name, mimeType: f.mimeType, size: size ?? null, createdTime: f.createdTime, link: f.webViewLink ?? "" };
    // Like a form upload: at most 5 MB, and only image or PDF bytes. Google Docs files have no size and are not downloaded.
    let file: Item["file"];
    if (size === undefined || f.mimeType.startsWith("application/vnd.google-apps.")) payload.fileSkipped = "type";
    else if (size > FILE_MAX_BYTES) payload.fileSkipped = "too_large";
    else if (left <= 0) payload.fileSkipped = "quota";
    else {
      const data = await driveDownload(o.urls, auth, f.id, FILE_MAX_BYTES);
      const type = data ? fileType(data) : null;
      if (!data) payload.fileSkipped = "too_large";
      else if (!type || !KEPT.has(type)) payload.fileSkipped = "type";
      else {
        file = { name: safeFileName(f.name), type, data };
        left--;
      }
    }
    items.push({ key: `gdrive:${f.id}`, payload, file });
  }
  return { cursor: r.cursor, items };
}

/** What the editor shows under a Google trigger: whether the connection is ready, and what the watcher last did. */
export async function googleTriggerStatus(db: Db, workspaceId: string, type: GoogleTriggerType, workflowId?: string) {
  const app = GOOGLE_TRIGGER_APPS[type];
  const [c] = await db
    .select({ status: connections.status, authMethod: connections.authMethod, scopes: connections.scopes, destination: connections.destination })
    .from(connections)
    .where(and(eq(connections.userId, workspaceId), eq(connections.provider, app)));
  const problem = connectionProblem(type, c ?? null);
  const watching = workflowId
    ? (
        await db
          .select({ problem: triggerPolls.problem, failures: triggerPolls.failures, started: sql<boolean>`${triggerPolls.cursor} is not null`, lastPolledAt: triggerPolls.lastPolledAt, nextPollAt: triggerPolls.nextPollAt })
          .from(triggerPolls)
          .innerJoin(workflows, eq(workflows.id, triggerPolls.workflowId))
          .where(and(eq(triggerPolls.workflowId, workflowId), eq(workflows.userId, workspaceId)))
      )[0] ?? null
    : null;
  return { app, problem, destination: c?.destination?.title ?? null, watching };
}
