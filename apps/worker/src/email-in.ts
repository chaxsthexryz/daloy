import { randomUUID } from "node:crypto";
import {
  conversationPayload,
  createKeyedRun,
  recordInbound,
  sanitizeMessageId,
  sanitizeReferences,
  EMAIL_UID_CHANGED,
  emailSourcePassword,
  emailSources,
  publishedVersion,
  WorkflowPausedError,
  triggers,
  workflows,
  type Db,
} from "@daloy/db";
import { emailMenu, numberedChoice } from "@daloy/engine";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

export const UID_CHANGED = EMAIL_UID_CHANGED;
export type EmailPayload = {
  from: string;
  replyTo: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo?: string | null;
  references?: string[];
  receivedAt: string;
};
export type ImapMessage = { uid: number; payload: EmailPayload | null; warning?: string };
export type ImapSession = {
  uidValidity: string;
  uidNext: number;
  readBatch: (afterUid: number) => Promise<{ messages: ImapMessage[]; throughUid: number }>;
  close: () => Promise<void>;
};
export type ImapAdapter = (
  source: { host: string; username: string; password: string; folder: string },
  signal?: AbortSignal,
) => Promise<ImapSession>;
export type EmailPollOptions = {
  db: Db;
  secretsKey: Buffer;
  adapter: ImapAdapter;
  enqueue: (runId: string) => Promise<void>;
  intervalMs?: number;
  maxWorkspaces?: number;
  signal?: AbortSignal;
};

const READ_FAILED = "Could not read this mailbox. Check its address, app password and folder, then check again.";
const RETRYING = "Could not reach the mailbox. kymavo will try again shortly.";
const CLAIM_MS = 45_000;
const MAX_BACKOFF_MS = 3_600_000;
export const MAX_POLL_WORKSPACES = 10;
// A workspace is the owner of the source's workflow.
const workspaceOf = sql`(select user_id from workflows where id = ${emailSources.workflowId})`;

/** A short, bounded, per-workspace fair poll. Claims at most one mailbox per workspace and runs up to maxWorkspaces in parallel. */
export async function pollEmailSources(opts: EmailPollOptions) {
  const { db, intervalMs = 60_000, maxWorkspaces = MAX_POLL_WORKSPACES, signal } = opts;
  if (signal?.aborted) return;
  const claims = await db.transaction(async (tx) => {
    // Serializes claims so the one-poller-per-workspace check below cannot race.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('email-claim', 0))`);
    const now = new Date();
    // Live: a published email trigger. A live source back to pending after a transient failure keeps its priority.
    const published = sql`exists (select 1 from triggers where workflow_id = ${emailSources.workflowId} and type = 'email')`;
    const live = sql`(${emailSources.status} = 'active' and ${published})`;
    const picked: (typeof emailSources.$inferSelect)[] = [];
    for (let i = 0; i < maxWorkspaces; i++) {
      const [row] = await tx
        .select()
        .from(emailSources)
        .where(
          and(
            or(
              eq(emailSources.status, "pending"),
              live,
            ),
            sql`not exists (select 1 from email_sources o join workflows ow on ow.id = o.workflow_id where ow.user_id = ${workspaceOf} and o.id <> ${emailSources.id} and o.claim_until > ${now})`,
            lte(emailSources.nextPollAt, now),
            or(isNull(emailSources.claimUntil), lte(emailSources.claimUntil, now)),
          ),
        )
        .orderBy(
          sql`${published} desc`,
          sql`(select max(es.last_checked_at) from email_sources es join workflows ew on ew.id = es.workflow_id where ew.user_id = ${workspaceOf}) asc nulls first`,
          emailSources.nextPollAt,
        )
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) break;
      const [owned] = await tx
        .update(emailSources)
        .set({ claimId: randomUUID(), claimUntil: new Date(Date.now() + CLAIM_MS), nextPollAt: new Date(Date.now() + intervalMs) })
        .where(eq(emailSources.id, row.id))
        .returning();
      picked.push(owned!);
    }
    return picked;
  });
  if (claims.length === 0) return;
  await Promise.all(claims.map((claim) => pollOneSource(claim, opts)));
}

async function pollOneSource(claim: typeof emailSources.$inferSelect, { db, secretsKey, adapter, enqueue, intervalMs = 60_000, signal }: EmailPollOptions) {
  const fence = and(eq(emailSources.id, claim.id), eq(emailSources.revision, claim.revision), eq(emailSources.claimId, claim.claimId!));
  let session: ImapSession | undefined;
  try {
    const [workflow] = await db.select({ userId: workflows.userId }).from(workflows).where(eq(workflows.id, claim.workflowId));
    if (!workflow) return;
    session = await adapter(
      {
        host: claim.host,
        username: claim.username,
        folder: claim.folder,
        password: emailSourcePassword(secretsKey, workflow.userId, claim),
      },
      signal,
    );
    signal?.throwIfAborted();
    await db.update(emailSources).set({ failures: 0 }).where(fence);
    if (
      !/^[1-9]\d{0,9}$/.test(session.uidValidity) ||
      Number(session.uidValidity) > 4_294_967_295 ||
      !Number.isSafeInteger(session.uidNext) ||
      session.uidNext < 1 ||
      session.uidNext > 4_294_967_296
    )
      throw Object.assign(new Error("Invalid mailbox numbering"), { permanent: true });
    const initial = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(emailSources).where(fence).for("update");
      if (!current || !current.claimUntil || current.claimUntil.getTime() <= Date.now()) return "stale";
      const [trigger] = await tx.select().from(triggers).where(eq(triggers.workflowId, claim.workflowId));
      const version = trigger?.type === "email" ? await publishedVersion(tx, claim.workflowId) : null;
      if (!version) {
        await tx
          .update(emailSources)
          .set({ status: "active", listening: false, uidValidity: null, lastUid: null, lastCheckedAt: new Date(), lastError: null })
          .where(fence);
        return "ready";
      }
      if (!current.listening || current.lastUid === null || current.uidValidity === null) {
        await tx
          .update(emailSources)
          .set({
            status: "active",
            listening: true,
            uidValidity: session!.uidValidity,
            lastUid: session!.uidNext - 1,
            lastCheckedAt: new Date(),
            lastError: null,
          })
          .where(fence);
        return "baseline";
      }
      if (current.uidValidity !== session!.uidValidity || current.lastUid >= session!.uidNext) {
        await tx
          .update(emailSources)
          .set({ status: "failed", listening: false, lastCheckedAt: new Date(), lastError: UID_CHANGED })
          .where(fence);
        return "changed";
      }
      await tx
        .update(emailSources)
        .set({ status: "active", lastCheckedAt: new Date(), lastError: current.lastError === RETRYING ? null : current.lastError })
        .where(fence);
      return current;
    });
    if (typeof initial === "string") return;
    const batch = await session.readBatch(initial.lastUid!);
    signal?.throwIfAborted();
    if (
      !Number.isInteger(batch.throughUid) ||
      batch.throughUid < initial.lastUid! ||
      batch.throughUid >= session.uidNext ||
      batch.messages.length > 20
    )
      throw new Error("Invalid mailbox batch");
    for (const message of batch.messages) {
      if (!Number.isInteger(message.uid) || message.uid <= initial.lastUid! || message.uid > batch.throughUid)
        throw new Error("Invalid message UID");
    }
    const runIds = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(emailSources).where(fence).for("update");
      if (
        !current ||
        !current.listening ||
        current.uidValidity !== session!.uidValidity ||
        !current.claimUntil ||
        current.claimUntil.getTime() <= Date.now()
      )
        return [];
      const [trigger] = await tx.select().from(triggers).where(eq(triggers.workflowId, current.workflowId));
      const version = trigger?.type === "email" ? await publishedVersion(tx, current.workflowId) : null;
      if (!version) return [];
      const ids: string[] = [];
      let warning: string | undefined;
      for (const message of batch.messages) {
        if (message.payload) {
          const key = `imap:${current.mailboxId}:${session!.uidValidity}:${message.uid}`;
          // The sender's conversation, keyed by the address replies go to (decision 0115). A message without a
          // Message-ID is deduplicated by its mailbox position instead.
          const p = message.payload;
          const safeMid = sanitizeMessageId(p.messageId);
          const safeInReplyTo = sanitizeMessageId(p.inReplyTo);
          const safeReferences = sanitizeReferences([
            ...(Array.isArray(p.references) ? p.references : typeof p.references === "string" ? [p.references] : []),
            ...(safeInReplyTo ? [safeInReplyTo] : []),
          ]);
          const convo = p.replyTo.trim()
            ? await recordInbound(tx, {
                userId: workflow.userId,
                channel: "email",
                externalId: p.replyTo.trim().toLowerCase(),
                mid: safeMid ?? key,
                emailReferences: safeReferences,
                text: `${p.subject}\n\n${p.text}`,
                at: new Date(p.receivedAt),
              })
            : undefined;
          // A reply of just a number picks that line of the workflow's email menu (decision 0118).
          const choice = numberedChoice(p.text, emailMenu(version.definition));
          const payload = {
            ...p,
            messageId: safeMid,
            ...(safeInReplyTo ? { inReplyTo: safeInReplyTo } : {}),
            ...(safeReferences.length > 0 ? { references: safeReferences } : {}),
            ...(choice ? { choice } : {}),
            ...(convo ? { conversation: await conversationPayload(tx, convo) } : {}),
          };
          // Paused (N11b): the message is skipped, and the checkpoint below still moves past it, so a resume does not replay a burst.
          const result = await createKeyedRun(tx, current.workflowId, version.id, payload, key, convo ? { conversationId: convo.id, conversationVersion: convo.version } : {}).catch((err: unknown) => {
            if (err instanceof WorkflowPausedError) return null;
            throw err;
          });
          if (result && !result.duplicate) ids.push(result.runId);
        } else if (message.warning) warning = message.warning;
      }
      await tx
        .update(emailSources)
        .set({ lastUid: batch.throughUid, ...(warning ? { lastError: warning } : {}) })
        .where(fence);
      return ids;
    });
    // A queue failure leaves the pending run and checkpoint committed. The worker's existing sweep resumes that run.
    for (const runId of runIds) await enqueue(runId).catch(() => {});
  } catch (err) {
    // Server errors can contain login commands and message text. Keep only our own fixed explanation.
    const permanent = !!(err && typeof err === "object" && "permanent" in err && err.permanent);
    await db
      .update(emailSources)
      .set({
        status: permanent ? "failed" : "pending",
        lastCheckedAt: new Date(),
        lastError: permanent ? READ_FAILED : RETRYING,
        failures: sql`${emailSources.failures} + 1`,
        nextPollAt: new Date(Date.now() + Math.min(Math.max(intervalMs * 2 ** claim.failures, 500), MAX_BACKOFF_MS)),
      })
      .where(fence);
  } finally {
    await session?.close().catch(() => {});
    await db.update(emailSources).set({ claimId: null, claimUntil: null }).where(fence);
  }
}
