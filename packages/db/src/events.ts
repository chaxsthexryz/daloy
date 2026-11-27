import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { runs, workflows, workflowVersions } from "./schema";

type AnyDb = NodePgDatabase<Record<string, unknown>>;

/**
 * Live console events (A6, decision 0155). Postgres NOTIFY on one channel; the API holds one LISTEN connection and fans
 * the events out to open console streams. The payload is a pointer, never content: it names a workspace, a kind, the id
 * of the run or conversation, and a short title (the workflow name, or the channel). Message text, customer names,
 * run errors and secrets are never put in it. NOTIFY allows 8,000 bytes; a payload stays far below that.
 */
export const EVENTS_CHANNEL = "kymavo_events";
export const EVENT_KINDS = ["run_succeeded", "run_failed", "conversation_new", "handoff_requested"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type LiveEvent = { workspaceId: string; kind: EventKind; id: string; title: string; at: string };

const TITLE_MAX = 80;
const CHANNEL_LABELS: Record<string, string> = { messenger: "Messenger", instagram: "Instagram", email: "Email", telegram: "Telegram", whatsapp: "WhatsApp" };

/** The NOTIFY payload as JSON, with the title cut to 80 characters. */
export function eventPayload(e: Omit<LiveEvent, "at"> & { at?: Date }): string {
  const title = [...e.title].slice(0, TITLE_MAX).join("");
  return JSON.stringify({ workspaceId: e.workspaceId, kind: e.kind, id: e.id, title, at: (e.at ?? new Date()).toISOString() });
}

type Log = (message: string) => void;
const logError: Log = (message) => console.error(message);

/**
 * Sends one event. It never throws: a failure is logged with the kind and id only, and the caller carries on. It runs
 * in its own (nested) transaction, so inside the caller's transaction a failure rolls back to a savepoint and does not
 * abort the caller's work, and the event is delivered only if the caller's transaction commits.
 */
export async function publishEvent(db: Pick<AnyDb, "transaction">, e: Omit<LiveEvent, "at"> & { at?: Date }, log: Log = logError): Promise<void> {
  try {
    const payload = eventPayload(e);
    await db.transaction((tx) => tx.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${payload})`));
  } catch (err) {
    log(`live event not published (${e.kind} ${e.id}): ${err instanceof Error ? err.name : "error"}`);
  }
}

/** A run reached succeeded or failed. Test runs that fake their steps are skipped, so the builder's previews stay out of the bell. */
export async function publishRunFinished(db: Pick<AnyDb, "select" | "transaction">, runId: string, state: "succeeded" | "failed", log: Log = logError): Promise<void> {
  try {
    const [row] = await db
      .select({ workspaceId: workflows.userId, name: workflows.name, test: runs.test, live: runs.live })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(eq(runs.id, runId));
    if (!row || (row.test && !row.live)) return;
    await publishEvent(db, { workspaceId: row.workspaceId, kind: state === "succeeded" ? "run_succeeded" : "run_failed", id: runId, title: row.name }, log);
  } catch (err) {
    log(`live event not published (run ${runId}): ${err instanceof Error ? err.name : "error"}`);
  }
}

/** A customer message arrived (conversation_new) or the bot asked for a person (handoff_requested). The title is the channel's name. */
export function publishConversationEvent(db: Pick<AnyDb, "transaction">, c: { id: string; userId: string; channel: string }, kind: "conversation_new" | "handoff_requested", log?: Log) {
  return publishEvent(db, { workspaceId: c.userId, kind, id: c.id, title: CHANNEL_LABELS[c.channel] ?? c.channel }, log);
}
