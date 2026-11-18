import { randomUUID } from "node:crypto";
import {
  createKeyedRun,
  EMAIL_UID_CHANGED,
  emailSourcePassword,
  emailSources,
  publishedVersion,
  WorkflowPausedError,
  triggers,
  workflows,
  type Db,
} from "@daloy/db";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

export const UID_CHANGED = EMAIL_UID_CHANGED;
export type EmailPayload = {
  from: string;
  replyTo: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string | null;
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
  signal?: AbortSignal;
};

const READ_FAILED = "Could not read this mailbox. Check its address, app password and folder, then check again.";
const RETRYING = "Could not reach the mailbox. Daloy will try again shortly.";
const CLAIM_MS = 45_000;

/** A short, bounded poll. Each result is fenced by both credential revision and claim, including late errors. */
export async function pollEmailSources({ db, secretsKey, adapter, enqueue, intervalMs = 60_000, signal }: EmailPollOptions) {
  if (signal?.aborted) return;
  const claim = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .select()
      .from(emailSources)
      .where(
        and(
          or(
            eq(emailSources.status, "pending"),
            and(
              eq(emailSources.status, "active"),
              sql`exists (select 1 from triggers where workflow_id = ${emailSources.workflowId} and type = 'email')`,
            ),
          ),
          lte(emailSources.nextPollAt, now),
          or(isNull(emailSources.claimUntil), lte(emailSources.claimUntil, now)),
        ),
      )
      .orderBy(emailSources.nextPollAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    const [owned] = await tx
      .update(emailSources)
      .set({ claimId: randomUUID(), claimUntil: new Date(Date.now() + CLAIM_MS), nextPollAt: new Date(Date.now() + intervalMs) })
      .where(eq(emailSources.id, row.id))
      .returning();
    return owned!;
  });
  if (!claim) return;
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
          // Paused (N11b): the message is skipped, and the checkpoint below still moves past it, so a resume does not replay a burst.
          const result = await createKeyedRun(
            tx,
            current.workflowId,
            version.id,
            message.payload,
            `imap:${current.mailboxId}:${session!.uidValidity}:${message.uid}`,
          ).catch((err: unknown) => {
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
        nextPollAt: new Date(Date.now() + Math.max(intervalMs, 500)),
      })
      .where(fence);
  } finally {
    await session?.close().catch(() => {});
    await db.update(emailSources).set({ claimId: null, claimUntil: null }).where(fence);
  }
}
