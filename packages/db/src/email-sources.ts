import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import * as z from "zod";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import { emailSources, triggers, workflows } from "./schema";

// Public names only here; the worker checks every DNS answer and pins the actual connection address as well.
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/);
const safeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127), "Must not contain control characters");
export const emailSourceInputSchema = z.strictObject({
  host: hostname,
  username: safeText(320),
  password: safeText(1024),
  folder: safeText(200).default("INBOX"),
});
export type EmailSourceInput = z.infer<typeof emailSourceInputSchema>;
export const EMAIL_UID_CHANGED = "The mailbox changed its message numbering. Check the mailbox to restart from new mail.";
export const emailSourceSecretName = (workflowId: string) => `imap:${workflowId}`;
type Source = typeof emailSources.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const safeSource = (r: Source) => ({
  host: r.host,
  username: r.username,
  folder: r.folder,
  status: r.status,
  listening: r.listening,
  lastCheckedAt: r.lastCheckedAt,
  lastError: r.lastError,
});

/** Callers authorize workspace ownership first. No credential or checkpoint appears in the settings response. */
export async function readEmailSource(db: Db, workflowId: string) {
  const [row] = await db.select().from(emailSources).where(eq(emailSources.workflowId, workflowId));
  return row ? safeSource(row) : null;
}

export async function saveEmailSource(db: Db, key: Buffer, workspaceId: string, workflowId: string, raw: EmailSourceInput) {
  const input = emailSourceInputSchema.parse(raw);
  return db.transaction(async (tx) => {
    // Covers the missing-row case too: simultaneous first connections cannot overwrite a newly established baseline.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`imap:${workflowId}`}, 0))`);
    const [workflow] = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.userId, workspaceId)));
    if (!workflow) throw new Error("Automation not found");
    const [old] = await tx.select().from(emailSources).where(eq(emailSources.workflowId, workflowId)).for("update");
    const sameMailbox = old?.host === input.host && old.username === input.username && old.folder === input.folder;
    const encrypted = encryptSecret(key, workspaceId, emailSourceSecretName(workflowId), input.password);
    const values = {
      host: input.host,
      username: input.username,
      folder: input.folder,
      ...encrypted,
      revision: randomUUID(),
      status: "pending" as const,
      claimId: null,
      claimUntil: null,
      nextPollAt: new Date(),
      lastError: null,
      ...(!sameMailbox ? { mailboxId: randomUUID(), listening: false, uidValidity: null, lastUid: null, lastCheckedAt: null } : {}),
    };
    const [row] = await tx
      .insert(emailSources)
      .values({ workflowId, ...values })
      .onConflictDoUpdate({ target: emailSources.workflowId, set: values })
      .returning();
    return safeSource(row!);
  });
}

export function emailSourcePassword(key: Buffer, workspaceId: string, row: Source): string {
  if (!row.ciphertext || !row.iv || !row.authTag) throw new Error("Mailbox disconnected");
  return decryptSecret(key, workspaceId, emailSourceSecretName(row.workflowId), {
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
  });
}

export async function disconnectEmailSource(db: Db, workflowId: string) {
  const [row] = await db
    .update(emailSources)
    .set({
      status: "disconnected",
      listening: false,
      ciphertext: null,
      iv: null,
      authTag: null,
      revision: randomUUID(),
      claimId: null,
      claimUntil: null,
      lastError: null,
    })
    .where(eq(emailSources.workflowId, workflowId))
    .returning();
  return row ? safeSource(row) : null;
}

export async function requestEmailSourceCheck(db: Db, workflowId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(emailSources).where(eq(emailSources.workflowId, workflowId)).for("update");
    if (!row || row.status === "disconnected") return row ? safeSource(row) : null;
    const reset = row.lastError === EMAIL_UID_CHANGED;
    const [updated] = await tx
      .update(emailSources)
      .set({
        status: "pending",
        revision: randomUUID(),
        claimId: null,
        claimUntil: null,
        nextPollAt: new Date(),
        lastError: null,
        ...(reset ? { uidValidity: null, lastUid: null, listening: false } : {}),
      })
      .where(eq(emailSources.id, row.id))
      .returning();
    return safeSource(updated!);
  });
}

/** Call before syncing the trigger in the publish transaction. Time spent on another trigger must never become backlog. */
export async function syncEmailSourceOnPublish(tx: Tx, workflowId: string, nextType: string) {
  const [old] = await tx.select({ type: triggers.type }).from(triggers).where(eq(triggers.workflowId, workflowId));
  if (old?.type === nextType || (old?.type !== "email" && nextType !== "email")) return;
  await tx
    .update(emailSources)
    .set({
      listening: false,
      uidValidity: null,
      lastUid: null,
      revision: randomUUID(),
      claimId: null,
      claimUntil: null,
      nextPollAt: new Date(),
    })
    .where(eq(emailSources.workflowId, workflowId));
}
