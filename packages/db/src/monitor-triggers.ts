import { createHash } from "node:crypto";
import { definitionSchema, type Trigger } from "@daloy/engine";
import { and, eq, sql } from "drizzle-orm";
import { pollDelay } from "./google-triggers";
import type { Db } from "./index";
import { createKeyedRun, publishedVersion, WorkflowPausedError } from "./runs";
import { triggerPolls, workflows } from "./schema";
import { claimUsage, planOf, PLANS, QuotaError } from "./usage";

/**
 * G4 (decision 0133): Web page and RSS/Atom feed monitor trigger (`page_changed`), reusing `trigger_polls`.
 * Pure cursor/diff evaluation lives here alongside the DB polling loop; the worker injects the SSRF-guarded fetcher.
 */

export type PageChangedTrigger = Extract<Trigger, { type: "page_changed" }>;
export const isMonitorTrigger = (type: string): type is "page_changed" => type === "page_changed";

export type PageCursor = {
  mode: "page";
  hash: string;
  value: string;
  title: string;
  etag?: string;
  lastModified?: string;
};

export type FeedCursor = {
  mode: "feed";
  seenIds: string[];
  etag?: string;
  lastModified?: string;
};

export type MonitorCursor = PageCursor | FeedCursor;

export type FeedItem = {
  itemId: string;
  title: string;
  link: string;
  summary: string;
  published: string;
  author: string;
};

export type MonitorFetchResult =
  | { kind: "not_modified"; etag?: string; lastModified?: string }
  | { kind: "page"; title: string; text: string; value: string; etag?: string; lastModified?: string }
  | { kind: "feed"; feedTitle: string; items: FeedItem[]; etag?: string; lastModified?: string };

export class MonitorPollError extends Error {
  override name = "MonitorPollError";
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const BASE_MS = 5 * 60_000;
const MAX_FEED_ITEMS_PER_POLL = 20;
const MAX_SEEN_FEED_IDS = 200;

export function monitorSourceOf(trigger: PageChangedTrigger): string {
  return `page:${trigger.config.mode}:${trigger.config.url}:${trigger.config.selector ?? ""}`;
}

const shortHash = (value: string, length = 16) => createHash("sha256").update(value).digest("hex").slice(0, length);

function dedupeAndCap(ids: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

export type MonitorRunItem = { key: string; payload: Record<string, unknown> };

/** Evaluates a fetched page (or 304) against the stored cursor. First poll baselines without starting a run. */
export function evaluatePagePoll(
  prev: PageCursor | null,
  fetched: Extract<MonitorFetchResult, { kind: "page" | "not_modified" }>,
  source: string,
  url: string,
  now: Date,
): { cursor: PageCursor | null; items: MonitorRunItem[] } {
  if (fetched.kind === "not_modified") {
    if (!prev) return { cursor: null, items: [] };
    return {
      cursor: {
        ...prev,
        ...(fetched.etag ? { etag: fetched.etag } : {}),
        ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
      },
      items: [],
    };
  }
  const hash = createHash("sha256").update(fetched.value).digest("hex");
  const nextCursor: PageCursor = {
    mode: "page",
    hash,
    value: fetched.value,
    title: fetched.title,
    ...(fetched.etag ? { etag: fetched.etag } : {}),
    ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
  };
  if (!prev || prev.mode !== "page") return { cursor: nextCursor, items: [] };
  if (hash === prev.hash) return { cursor: nextCursor, items: [] };
  const key = `page:${shortHash(source)}:${prev.hash.slice(0, 16)}:${hash.slice(0, 16)}`;
  return {
    cursor: nextCursor,
    items: [
      {
        key,
        payload: {
          url,
          title: fetched.title,
          text: fetched.text,
          value: fetched.value,
          previous: prev.value,
          hash,
          previousHash: prev.hash,
          checkedAt: now.toISOString(),
        },
      },
    ],
  };
}

/** Evaluates fetched feed items (or 304) against seen IDs. First poll records existing items without replaying them. */
export function evaluateFeedPoll(
  prev: FeedCursor | null,
  fetched: Extract<MonitorFetchResult, { kind: "feed" | "not_modified" }>,
  source: string,
  url: string,
  now: Date,
  maxItems = MAX_FEED_ITEMS_PER_POLL,
): { cursor: FeedCursor; items: MonitorRunItem[] } {
  if (fetched.kind === "not_modified") {
    return {
      cursor: prev
        ? {
            ...prev,
            ...(fetched.etag ? { etag: fetched.etag } : {}),
            ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
          }
        : { mode: "feed", seenIds: [] },
      items: [],
    };
  }
  const meta = {
    ...(fetched.etag ? { etag: fetched.etag } : {}),
    ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
  };
  if (!prev || prev.mode !== "feed") {
    return {
      cursor: { mode: "feed", seenIds: dedupeAndCap(fetched.items.map((i) => i.itemId), MAX_SEEN_FEED_IDS), ...meta },
      items: [],
    };
  }
  const seen = new Set(prev.seenIds);
  const fresh = fetched.items.filter((item) => item.itemId && !seen.has(item.itemId)).slice(0, maxItems);
  const nextSeenIds = dedupeAndCap([...fresh.map((i) => i.itemId), ...prev.seenIds], MAX_SEEN_FEED_IDS);
  const srcHash = shortHash(source);
  return {
    cursor: { mode: "feed", seenIds: nextSeenIds, ...meta },
    items: fresh.map((item) => ({
      key: `feed:${srcHash}:${shortHash(item.itemId, 24)}`,
      payload: {
        url,
        feedTitle: fetched.feedTitle,
        itemId: item.itemId,
        title: item.title,
        link: item.link,
        summary: item.summary,
        published: item.published,
        author: item.author,
        checkedAt: now.toISOString(),
      },
    })),
  };
}

function asMonitorCursor(raw: Record<string, unknown> | null, mode: "page" | "feed"): MonitorCursor | null {
  if (!raw || raw.mode !== mode) return null;
  if (mode === "page" && typeof raw.hash === "string" && typeof raw.value === "string") {
    return {
      mode: "page",
      hash: raw.hash,
      value: raw.value,
      title: typeof raw.title === "string" ? raw.title : "",
      ...(typeof raw.etag === "string" ? { etag: raw.etag } : {}),
      ...(typeof raw.lastModified === "string" ? { lastModified: raw.lastModified } : {}),
    };
  }
  if (mode === "feed" && Array.isArray(raw.seenIds)) {
    return {
      mode: "feed",
      seenIds: raw.seenIds.filter((x): x is string => typeof x === "string"),
      ...(typeof raw.etag === "string" ? { etag: raw.etag } : {}),
      ...(typeof raw.lastModified === "string" ? { lastModified: raw.lastModified } : {}),
    };
  }
  return null;
}

export type MonitorPollOptions = {
  db: Db;
  fetchMonitor: (input: {
    workspaceId: string;
    workflowId: string;
    trigger: PageChangedTrigger;
    cursor: MonitorCursor | null;
    claimHttp: () => Promise<void>;
  }) => Promise<MonitorFetchResult>;
  enqueue: (runId: string) => Promise<void>;
  limit?: number;
  intervalMs?: number;
};

/** Claims due `page_changed` automations with SKIP LOCKED and polls each once. Returns how many were claimed. */
export async function pollMonitorTriggers(o: MonitorPollOptions): Promise<number> {
  const { db } = o;
  await db.execute(sql`insert into trigger_polls (workflow_id) select workflow_id from triggers where type = 'page_changed' on conflict do nothing`);
  const claimed = await db.execute<{ workflow_id: string }>(sql`
    update trigger_polls set claim_until = now() + interval '2 minutes'
    where workflow_id in (
      select tp.workflow_id from trigger_polls tp
      join workflows w on w.id = tp.workflow_id
      join triggers t on t.workflow_id = tp.workflow_id
      where t.type = 'page_changed' and tp.next_poll_at <= now() and (tp.claim_until is null or tp.claim_until < now()) and w.paused_at is null
      order by tp.next_poll_at limit ${o.limit ?? 10} for update of tp skip locked)
    returning workflow_id`);
  for (const { workflow_id } of claimed.rows) {
    await pollOneMonitor(o, workflow_id).catch((err: unknown) => {
      console.error(`monitor trigger poll failed for ${workflow_id}: ${err instanceof Error ? err.name : "error"}`);
    });
  }
  return claimed.rows.length;
}

async function pollOneMonitor(o: MonitorPollOptions, workflowId: string) {
  const { db } = o;
  const now = new Date();
  const [row] = await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, workflowId));
  const [wf] = await db.select({ userId: workflows.userId }).from(workflows).where(eq(workflows.id, workflowId));
  const version = await publishedVersion(db, workflowId);
  const parsed = version ? definitionSchema.safeParse(version.definition) : undefined;
  if (!row || !wf || !version || !parsed?.success || parsed.data.trigger.type !== "page_changed") {
    await db.delete(triggerPolls).where(eq(triggerPolls.workflowId, workflowId));
    return;
  }
  const trigger = parsed.data.trigger;
  const ws = wf.userId;
  const { plan } = await planOf(db, ws);
  const planMinutes = plan ? PLANS[plan].minScheduleMinutes : null;
  const later = (failures: number, retryAfterMs?: number) => new Date(now.getTime() + pollDelay(failures, retryAfterMs, o.intervalMs ? null : planMinutes, o.intervalMs));
  const save = (values: Partial<typeof triggerPolls.$inferInsert>) => db.update(triggerPolls).set({ claimUntil: null, ...values }).where(eq(triggerPolls.workflowId, workflowId));
  const pause = (problem: string) => save({ problem: problem.slice(0, 500), failures: 0, nextPollAt: new Date(now.getTime() + (o.intervalMs ?? BASE_MS)) });

  const source = monitorSourceOf(trigger);
  const cursor = row.source === source ? asMonitorCursor(row.cursor, trigger.config.mode) : null;

  let fetched: MonitorFetchResult;
  try {
    fetched = await o.fetchMonitor({
      workspaceId: ws,
      workflowId,
      trigger,
      cursor,
      claimHttp: () => claimUsage(db, ws, "http"),
    });
  } catch (err) {
    if (err instanceof QuotaError) return pause(err.message);
    if (err instanceof MonitorPollError) {
      if (err.retryable) {
        const failures = row.failures + 1;
        return save({ failures, problem: err.message.slice(0, 500), nextPollAt: later(failures, err.retryAfterMs) });
      }
      return pause(err.message);
    }
    throw err;
  }

  let nextCursor: MonitorCursor | null;
  let items: MonitorRunItem[];
  if (trigger.config.mode === "feed") {
    if (fetched.kind === "page") return pause("Monitor returned page data for feed mode.");
    const res = evaluateFeedPoll(cursor?.mode === "feed" ? cursor : null, fetched, source, trigger.config.url, now);
    nextCursor = res.cursor;
    items = res.items;
  } else {
    if (fetched.kind === "feed") return pause("Monitor returned feed data for page mode.");
    const res = evaluatePagePoll(cursor?.mode === "page" ? cursor : null, fetched, source, trigger.config.url, now);
    nextCursor = res.cursor;
    items = res.items;
  }

  for (const item of items) {
    let started: { runId: string; duplicate?: true } | null;
    try {
      started = await createKeyedRun(db, workflowId, version.id, item.payload, item.key);
    } catch (err) {
      if (err instanceof WorkflowPausedError) return save({ nextPollAt: later(0) });
      throw err;
    }
    if (started && !started.duplicate) await o.enqueue(started.runId);
  }
  await save({
    source,
    cursor: nextCursor as Record<string, unknown> | null,
    failures: 0,
    problem: null,
    lastPolledAt: now,
    nextPollAt: later(0),
  });
}

/** What the editor shows under a `page_changed` trigger: watcher status for the saved automation. */
export async function monitorTriggerStatus(db: Db, workspaceId: string, workflowId?: string) {
  const watching = workflowId
    ? (
        await db
          .select({
            problem: triggerPolls.problem,
            failures: triggerPolls.failures,
            started: sql<boolean>`${triggerPolls.cursor} is not null`,
            lastPolledAt: triggerPolls.lastPolledAt,
            nextPollAt: triggerPolls.nextPollAt,
          })
          .from(triggerPolls)
          .innerJoin(workflows, eq(workflows.id, triggerPolls.workflowId))
          .where(and(eq(triggerPolls.workflowId, workflowId), eq(workflows.userId, workspaceId)))
      )[0] ?? null
    : null;
  return { watching };
}
