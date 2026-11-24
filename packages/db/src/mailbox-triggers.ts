import { definitionSchema, type Trigger, type WorkflowDefinition } from "@daloy/engine";
import { and, eq, sql } from "drizzle-orm";
import { connectionCredential, markConnectionFailed } from "./connections";
import { decryptSecret } from "./crypto";
import { createdSince, pollDelay, type TimeCursor } from "./google-triggers";
import type { Db } from "./index";
import { sanitizeMessageId, sanitizeReferences } from "./mail";
import { markSenderFailed } from "./mail-senders";
import { gmail, GMAIL_GRANT, gmailLabels, gmailMessageGet, gmailMessagesList, outlook, withFreshToken } from "./oauth";
import { outlookFolders, outlookMessagesSince, ProviderError, type ProviderUrls } from "./providers";
import { createKeyedRun, publishedVersion, WorkflowPausedError } from "./runs";
import { connections, mailSenders, triggerPolls, workflows, type AuthMethod } from "./schema";
import { planOf, PLANS } from "./usage";

/**
 * G3 (decision 0132): Connected mailbox triggers (gmail_message, outlook_message) reusing trigger_polls and
 * existing Gmail / Outlook OAuth grants. Pure helpers first, then the DB poll and editor status query.
 */

export const MAILBOX_TRIGGER_APPS = { gmail_message: "gmail", outlook_message: "outlook" } as const;
export type MailboxTriggerType = keyof typeof MAILBOX_TRIGGER_APPS;
type MailboxTrigger = Extract<Trigger, { type: MailboxTriggerType }>;
export const isMailboxTrigger = (type: string): type is MailboxTriggerType => type in MAILBOX_TRIGGER_APPS;

const GMAIL_READ_SCOPES = new Set(["https://www.googleapis.com/auth/gmail.readonly", "https://mail.google.com/"]);
const OUTLOOK_READ_SCOPES = new Set(["mail.read", "https://graph.microsoft.com/mail.read", "mail.readwrite", "https://graph.microsoft.com/mail.readwrite"]);
const BASE_MS = 5 * 60_000;
const MAX_PER_POLL = 20;

export type MailboxConnectionInfo = {
  status: "active" | "failed" | "disconnected" | "unverified";
  authMethod: AuthMethod | "app_password";
  scopes: string | null;
  account?: string | null;
} | null;

/** Why this mailbox trigger cannot read mail now, in plain words for the owner, or null when ready. Needs no network. */
export function mailboxConnectionProblem(type: MailboxTriggerType, conn: MailboxConnectionInfo): string | null {
  if (type === "gmail_message") {
    if (!conn) return "Gmail is not connected. Connect Gmail with Google in Apps.";
    if (conn.authMethod !== "oauth") return "Gmail is connected with an app password. Connect Gmail with Google in Apps, or use the Email trigger instead.";
    if (conn.status !== "active") return "Gmail stopped accepting kymavo's access. Reconnect Gmail in Apps.";
    const have = (conn.scopes ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!have.some((s) => GMAIL_READ_SCOPES.has(s))) {
      return "Gmail is connected for sending only. Reading mail needs the gmail.readonly permission (a Google restricted scope requiring verification before public launch). Use the Email trigger with an app password, or reconnect Gmail with read access.";
    }
    return null;
  }
  if (!conn) return "Outlook is not connected. Connect Outlook in Apps.";
  if (conn.authMethod !== "oauth" || conn.status !== "active") return "Outlook stopped accepting kymavo's access. Reconnect Outlook in Apps.";
  const have = (conn.scopes ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!have.some((s) => OUTLOOK_READ_SCOPES.has(s))) {
    return "Reconnect Outlook in Apps and allow reading mail (Mail.Read).";
  }
  return null;
}

/** Extracts a lowercased email address from "Name <addr@example.com>" or "addr@example.com". */
export function extractEmailAddress(value: string): string {
  const angled = /<([^<>@\s]+@[^<>@\s]+)>/.exec(value)?.[1];
  return (angled ?? value).trim().toLowerCase();
}

function literalRecipientEmails(to: string): string[] {
  return to
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.includes("{{"))
    .map(extractEmailAddress);
}

/** Static self-loop guard: pauses an automation whose email/outlook step sends directly to the mailbox it watches. */
export function mailboxSelfLoopProblem(def: WorkflowDefinition, connectedAddress: string | null | undefined): string | null {
  const addr = connectedAddress ? extractEmailAddress(connectedAddress) : "";
  if (!addr) return null;
  const live = def.steps.filter((s) => !s.disabled);
  if (def.trigger.type === "gmail_message" && live.some((s) => s.type === "email" && literalRecipientEmails(s.config.to).includes(addr))) {
    return "This automation sends an email to the same Gmail address it watches, which would start it again. Change the recipient or use another automation.";
  }
  if (def.trigger.type === "outlook_message" && live.some((s) => s.type === "outlook" && literalRecipientEmails(s.config.to).includes(addr))) {
    return "This automation sends an email to the same Outlook address it watches, which would start it again. Change the recipient or use another automation.";
  }
  return null;
}

/** Dynamic self-loop guard: skips messages authored by the connected mailbox itself. */
export function isSelfAuthoredMessage(from: string, connectedAddress: string | null | undefined): boolean {
  const addr = connectedAddress ? extractEmailAddress(connectedAddress) : "";
  return addr.length > 0 && extractEmailAddress(from) === addr;
}

export type FilterableMessage = {
  from: string;
  subject: string;
  labelIds?: string[];
  parentFolderId?: string;
};

/** Checks optional sender, subject, label and folder filters (case-insensitive substring for from/subject). */
export function matchesMailboxFilters(
  msg: FilterableMessage,
  config: { from?: string; subjectContains?: string; label?: string; folder?: string },
  resolved?: { labelId?: string; folderId?: string },
): boolean {
  if (config.from && !msg.from.toLowerCase().includes(config.from.trim().toLowerCase())) return false;
  if (config.subjectContains && !msg.subject.toLowerCase().includes(config.subjectContains.trim().toLowerCase())) return false;
  if (config.label) {
    const target = (resolved?.labelId ?? config.label).trim().toLowerCase();
    const labels = (msg.labelIds ?? []).map((l) => l.toLowerCase());
    if (!labels.includes(target)) return false;
  }
  if (config.folder && resolved?.folderId && msg.parentFolderId) {
    if (msg.parentFolderId.toLowerCase() !== resolved.folderId.toLowerCase()) return false;
  }
  return true;
}

export function mailboxSourceOf(trigger: MailboxTrigger, account: string): string {
  const acct = extractEmailAddress(account);
  if (trigger.type === "gmail_message") return `gmail:${acct}:${trigger.config.label ?? ""}`;
  return `outlook:${acct}:${trigger.config.folder ?? ""}`;
}

// ---------------------------------------------------------------- the poll

export type MailboxPollOptions = {
  db: Db;
  secretsKey: Buffer;
  urls: ProviderUrls;
  enqueue: (runId: string) => Promise<void>;
  limit?: number;
  intervalMs?: number;
};

type MailboxItem = { key: string; payload: Record<string, unknown> };

/** Claims due gmail_message / outlook_message rows in trigger_polls (SKIP LOCKED) and polls each. */
export async function pollMailboxTriggers(o: MailboxPollOptions): Promise<number> {
  const { db } = o;
  await db.execute(sql`insert into trigger_polls (workflow_id) select workflow_id from triggers where type in ('gmail_message', 'outlook_message') on conflict do nothing`);
  const claimed = await db.execute<{ workflow_id: string }>(sql`
    update trigger_polls set claim_until = now() + interval '2 minutes'
    where workflow_id in (
      select tp.workflow_id from trigger_polls tp
      join workflows w on w.id = tp.workflow_id
      join triggers t on t.workflow_id = tp.workflow_id
      where tp.next_poll_at <= now() and (tp.claim_until is null or tp.claim_until < now()) and w.paused_at is null
        and t.type in ('gmail_message', 'outlook_message')
      order by tp.next_poll_at limit ${o.limit ?? 10} for update of tp skip locked)
    returning workflow_id`);
  for (const { workflow_id } of claimed.rows) {
    await pollOneMailbox(o, workflow_id).catch((err: unknown) => {
      // Never log provider responses, bodies, or credentials.
      console.error(`mailbox trigger poll failed for ${workflow_id}: ${err instanceof Error ? err.name : "error"}`);
    });
  }
  return claimed.rows.length;
}

const asTime = (c: Record<string, unknown> | null): TimeCursor | null => (c && typeof c.since === "string" ? { since: c.since } : null);

async function pollOneMailbox(o: MailboxPollOptions, workflowId: string) {
  const { db, secretsKey: key, urls } = o;
  const now = new Date();
  const [row] = await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, workflowId));
  const [wf] = await db.select({ userId: workflows.userId }).from(workflows).where(eq(workflows.id, workflowId));
  const version = await publishedVersion(db, workflowId);
  const parsed = version ? definitionSchema.safeParse(version.definition) : undefined;
  if (!row || !wf || !version || !parsed?.success || !isMailboxTrigger(parsed.data.trigger.type)) {
    await db.delete(triggerPolls).where(eq(triggerPolls.workflowId, workflowId));
    return;
  }
  const def = parsed.data;
  const trigger = def.trigger as MailboxTrigger;
  const ws = wf.userId;
  const { plan } = await planOf(db, ws);
  const planMinutes = plan ? PLANS[plan].minScheduleMinutes : null;
  const later = (failures: number, retryAfterMs?: number) => new Date(now.getTime() + pollDelay(failures, retryAfterMs, o.intervalMs ? null : planMinutes, o.intervalMs));
  const save = (values: Partial<typeof triggerPolls.$inferInsert>) => db.update(triggerPolls).set({ claimUntil: null, ...values }).where(eq(triggerPolls.workflowId, workflowId));
  const pause = (problem: string) => save({ problem: problem.slice(0, 500), failures: 0, nextPollAt: new Date(now.getTime() + (o.intervalMs ?? BASE_MS)) });

  let account = "";
  let read: { cursor: Record<string, unknown>; items: MailboxItem[] };

  if (trigger.type === "gmail_message") {
    const [sender] = await db.select().from(mailSenders).where(eq(mailSenders.userId, ws));
    const problem =
      mailboxConnectionProblem("gmail_message", sender ? { status: sender.status, authMethod: sender.authMethod, scopes: sender.scopes, account: sender.address } : null) ??
      mailboxSelfLoopProblem(def, sender?.address);
    if (problem || !sender?.passwordCiphertext || !sender.passwordIv || !sender.passwordAuthTag) {
      return pause(problem ?? "Gmail is not connected. Connect Gmail with Google in Apps.");
    }
    account = sender.address;
    const source = mailboxSourceOf(trigger, account);
    const cursor = row.source === source ? row.cursor : null;
    const grant = {
      credential: decryptSecret(key, ws, GMAIL_GRANT, { ciphertext: sender.passwordCiphertext, iv: sender.passwordIv, authTag: sender.passwordAuthTag }),
      revision: sender.passwordIv,
    };
    try {
      read = await withFreshToken(db, key, urls, ws, gmail, grant, (accessToken) => readGmail(urls, accessToken, trigger, account, cursor, now));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === "quota" || err.kind === "unavailable" || err.kind === "ambiguous") {
        const failures = row.failures + 1;
        return save({ failures, problem: err.message.slice(0, 500), nextPollAt: later(failures, err.retryAfterMs) });
      }
      if (err.kind === "auth") {
        await markSenderFailed(db, ws, "Gmail no longer accepts kymavo's access. Reconnect Gmail in Apps.");
        return pause("Gmail stopped accepting kymavo's access. Reconnect Gmail in Apps.");
      }
      return pause(err.message);
    }
    const pausedEarly = await runItems(o, workflowId, version.id, read.items, save, later);
    if (pausedEarly) return;
    return save({ source, cursor: read.cursor, failures: 0, problem: null, lastPolledAt: now, nextPollAt: later(0) });
  }

  // outlook_message
  const conn = await connectionCredential(db, key, ws, "outlook");
  const [meta] = await db.select({ scopes: connections.scopes }).from(connections).where(and(eq(connections.userId, ws), eq(connections.provider, "outlook")));
  const problem =
    mailboxConnectionProblem("outlook_message", conn && { status: conn.status, authMethod: conn.authMethod, scopes: meta?.scopes ?? null, account: conn.account }) ??
    mailboxSelfLoopProblem(def, conn?.account);
  if (problem || !conn) return pause(problem ?? "Outlook is not connected. Connect Outlook in Apps.");
  account = conn.account;
  const source = mailboxSourceOf(trigger, account);
  const cursor = row.source === source ? row.cursor : null;
  try {
    read = await withFreshToken(db, key, urls, ws, outlook, conn, (accessToken) => readOutlook(urls, accessToken, trigger, account, cursor, now));
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.kind === "quota" || err.kind === "unavailable" || err.kind === "ambiguous") {
      const failures = row.failures + 1;
      return save({ failures, problem: err.message.slice(0, 500), nextPollAt: later(failures, err.retryAfterMs) });
    }
    if (err.kind === "auth") {
      await markConnectionFailed(db, ws, "outlook", "Outlook no longer accepts kymavo's access. Reconnect Outlook in Apps.", conn.revision);
      return pause("Outlook stopped accepting kymavo's access. Reconnect Outlook in Apps.");
    }
    return pause(err.message);
  }
  const pausedEarly = await runItems(o, workflowId, version.id, read.items, save, later);
  if (pausedEarly) return;
  await save({ source, cursor: read.cursor, failures: 0, problem: null, lastPolledAt: now, nextPollAt: later(0) });
}

async function runItems(
  o: MailboxPollOptions,
  workflowId: string,
  versionId: string,
  items: MailboxItem[],
  save: (values: Partial<typeof triggerPolls.$inferInsert>) => Promise<unknown>,
  later: (failures: number) => Date,
): Promise<boolean> {
  for (const item of items) {
    let started: { runId: string; duplicate?: true };
    try {
      started = await createKeyedRun(o.db, workflowId, versionId, item.payload, item.key);
    } catch (err) {
      if (err instanceof WorkflowPausedError) {
        await save({ nextPollAt: later(0) });
        return true;
      }
      throw err;
    }
    if (!started.duplicate) await o.enqueue(started.runId);
  }
  return false;
}

async function readGmail(
  urls: ProviderUrls,
  accessToken: string,
  trigger: Extract<MailboxTrigger, { type: "gmail_message" }>,
  account: string,
  cursor: Record<string, unknown> | null,
  now: Date,
): Promise<{ cursor: Record<string, unknown>; items: MailboxItem[] }> {
  const prev = asTime(cursor);
  if (!prev) return { cursor: { since: now.toISOString() }, items: [] };

  let resolvedLabelId: string | undefined;
  if (trigger.config.label) {
    const labels = await gmailLabels(urls, accessToken);
    const want = trigger.config.label.trim().toLowerCase();
    const match = labels.find((l) => l.id.toLowerCase() === want || l.name.toLowerCase() === want);
    if (!match) throw new ProviderError(`The Gmail label "${trigger.config.label}" was not found. Check the label in the trigger.`, "invalid");
    resolvedLabelId = match.id;
  }

  const sinceMs = Date.parse(prev.since);
  const sinceSec = Math.max(0, Math.floor(sinceMs / 1000) - 60);
  const list = await gmailMessagesList(urls, accessToken, {
    q: `after:${sinceSec}`,
    ...(resolvedLabelId ? { labelIds: [resolvedLabelId] } : {}),
    maxResults: MAX_PER_POLL,
  });

  // Gmail lists newest first; reverse so runs start in arrival order.
  const fetched = [];
  for (const m of [...list.messages].reverse()) {
    fetched.push(await gmailMessageGet(urls, accessToken, m.id));
  }

  // If Gmail had >20 matching messages, keep the cursor at prev.since so older unread messages are not skipped; run_keys dedups.
  const r = createdSince(
    prev,
    fetched.map((m) => ({ ...m, at: m.receivedAt })),
    now,
    false,
  );
  const nextCursor = list.more ? prev : r.cursor;

  const items: MailboxItem[] = [];
  const allowSent = resolvedLabelId?.toUpperCase() === "SENT";
  for (const m of r.fresh) {
    if (m.labelIds.some((l) => l === "DRAFT" || l === "TRASH" || l === "SPAM") && !resolvedLabelId) continue;
    if (!allowSent && isSelfAuthoredMessage(m.from, account)) continue;
    if (!matchesMailboxFilters(m, trigger.config, { labelId: resolvedLabelId })) continue;
    const safeMid = sanitizeMessageId(m.messageId);
    const safeInReplyTo = sanitizeMessageId(m.inReplyTo);
    const safeReferences = sanitizeReferences([...m.references, ...(safeInReplyTo ? [safeInReplyTo] : [])]);
    items.push({
      key: `gmail:${m.id}`,
      payload: {
        from: m.from,
        replyTo: m.replyTo,
        to: m.to,
        subject: m.subject,
        text: m.text,
        messageId: safeMid,
        ...(safeInReplyTo ? { inReplyTo: safeInReplyTo } : {}),
        ...(safeReferences.length > 0 ? { references: safeReferences } : {}),
        receivedAt: m.receivedAt,
        gmailMessageId: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
      },
    });
  }
  return { cursor: nextCursor, items };
}

async function readOutlook(
  urls: ProviderUrls,
  accessToken: string,
  trigger: Extract<MailboxTrigger, { type: "outlook_message" }>,
  account: string,
  cursor: Record<string, unknown> | null,
  now: Date,
): Promise<{ cursor: Record<string, unknown>; items: MailboxItem[] }> {
  const prev = asTime(cursor);
  if (!prev) return { cursor: { since: now.toISOString() }, items: [] };

  let resolvedFolderId: string | undefined;
  let folderName = trigger.config.folder;
  if (trigger.config.folder) {
    const folders = await outlookFolders(urls, accessToken);
    const want = trigger.config.folder.trim().toLowerCase();
    const match = folders.find((f) => f.id.toLowerCase() === want || f.displayName.toLowerCase() === want);
    if (!match) throw new ProviderError(`The Outlook folder "${trigger.config.folder}" was not found. Check the folder name in the trigger.`, "invalid");
    resolvedFolderId = match.id;
    folderName = match.displayName;
  }

  const page = await outlookMessagesSince(urls, accessToken, { sinceIso: prev.since, folderId: resolvedFolderId, top: MAX_PER_POLL });
  const r = createdSince(
    prev,
    page.items.map((m) => ({ ...m, at: m.receivedAt })),
    now,
    page.more,
  );
  const items: MailboxItem[] = [];
  const allowSent = resolvedFolderId?.toLowerCase() === "sentitems" || folderName?.toLowerCase() === "sent items";
  for (const m of r.fresh) {
    if (m.isDraft) continue;
    if (!allowSent && isSelfAuthoredMessage(m.from, account)) continue;
    if (!matchesMailboxFilters(m, trigger.config, { folderId: resolvedFolderId })) continue;
    const safeMid = sanitizeMessageId(m.internetMessageId);
    items.push({
      key: `outlook:${m.id}`,
      payload: {
        from: m.from,
        replyTo: m.replyTo,
        to: m.to,
        subject: m.subject,
        text: m.text,
        messageId: safeMid,
        receivedAt: m.receivedAt,
        outlookMessageId: m.id,
        folder: folderName ?? "Inbox",
      },
    });
  }
  return { cursor: r.cursor, items };
}

/** What the editor shows under a Gmail or Outlook trigger: whether the connection is ready, and what the watcher last did. */
export async function mailboxTriggerStatus(db: Db, workspaceId: string, type: MailboxTriggerType, workflowId?: string) {
  const app = MAILBOX_TRIGGER_APPS[type];
  let info: MailboxConnectionInfo = null;
  let account: string | null = null;
  if (type === "gmail_message") {
    const [sender] = await db
      .select({ status: mailSenders.status, authMethod: mailSenders.authMethod, scopes: mailSenders.scopes, address: mailSenders.address })
      .from(mailSenders)
      .where(eq(mailSenders.userId, workspaceId));
    if (sender) {
      info = { status: sender.status, authMethod: sender.authMethod, scopes: sender.scopes, account: sender.address };
      account = sender.address;
    }
  } else {
    const [conn] = await db
      .select({ status: connections.status, authMethod: connections.authMethod, scopes: connections.scopes, account: connections.account })
      .from(connections)
      .where(and(eq(connections.userId, workspaceId), eq(connections.provider, "outlook")));
    if (conn) {
      info = { status: conn.status, authMethod: conn.authMethod, scopes: conn.scopes, account: conn.account };
      account = conn.account;
    }
  }
  const problem = mailboxConnectionProblem(type, info);
  const watching = workflowId
    ? (
        await db
          .select({ problem: triggerPolls.problem, failures: triggerPolls.failures, started: sql<boolean>`${triggerPolls.cursor} is not null`, lastPolledAt: triggerPolls.lastPolledAt, nextPollAt: triggerPolls.nextPollAt })
          .from(triggerPolls)
          .innerJoin(workflows, eq(workflows.id, triggerPolls.workflowId))
          .where(and(eq(triggerPolls.workflowId, workflowId), eq(workflows.userId, workspaceId)))
      )[0] ?? null
    : null;
  return { app, problem, account, watching };
}
