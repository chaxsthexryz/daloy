import { randomBytes } from "node:crypto";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { hashToken } from "./approvals";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import type { HeldConnection } from "./oauth/core";
import { GMAIL_GRANT } from "./oauth/gmail";
import { businessProfiles, mailSenders } from "./schema";

export type Profile = { businessName: string | null; website: string | null; inquiryEmail: string | null; replyTo: string | null };

/**
 * Who sends an owner's mail, and how. "installation" is the SMTP server from the env vars (Mailpit locally), used when
 * the owner connected no account. "gmail" is Gmail's SMTP server with an app password; "gmail_api" is the Gmail API
 * with a Google sign-in's token blob (decision 0063). "blocked" stops the send: an owner who connected Gmail never
 * silently falls back (decision 0020).
 */
export type ResolvedSender =
  | { kind: "installation"; fromName?: string; replyTo?: string }
  | { kind: "gmail"; address: string; password: string; fromName?: string; replyTo?: string }
  | { kind: "gmail_api"; address: string; grant: HeldConnection; fromName?: string; replyTo?: string }
  | { kind: "blocked"; reason: string };

// The owner id is in the associated data (crypto.ts), so a password copied to another owner's row does not decrypt.
const PASSWORD = "gmail_app_password";
const VERIFY_TTL_MS = 30 * 60_000;

export async function readProfile(db: Db, userId: string): Promise<Profile | null> {
  const [row] = await db.select().from(businessProfiles).where(eq(businessProfiles.userId, userId));
  return row ? { businessName: row.businessName, website: row.website, inquiryEmail: row.inquiryEmail, replyTo: row.replyTo } : null;
}

export async function saveProfile(db: Db, userId: string, profile: Profile) {
  const values = { ...profile, updatedAt: new Date() };
  await db.insert(businessProfiles).values({ userId, ...values }).onConflictDoUpdate({ target: businessProfiles.userId, set: values });
}

/** The sender's state for the console. The password never leaves this module. */
export async function readSender(db: Db, userId: string) {
  const [row] = await db
    .select({ address: mailSenders.address, status: mailSenders.status, lastError: mailSenders.lastError, verifiedAt: mailSenders.verifiedAt, lastTestedAt: mailSenders.lastTestedAt, authMethod: mailSenders.authMethod })
    .from(mailSenders)
    .where(eq(mailSenders.userId, userId));
  return row ?? null;
}

/**
 * Saves the address and app password. Google shows app passwords in groups of four with spaces, which are not part of it.
 * The same verified address stays verified (the link proved the mailbox, not the password); a new address starts unverified.
 */
export async function connectGmail(db: Db, key: Buffer, userId: string, input: { address: string; appPassword: string }) {
  const address = input.address.trim().toLowerCase();
  const e = encryptSecret(key, userId, PASSWORD, input.appPassword.replace(/\s+/g, ""));
  // Replaces a Google sign-in too (its grant at Google is not revoked here; Disconnect does that).
  const password = { passwordCiphertext: e.ciphertext, passwordIv: e.iv, passwordAuthTag: e.authTag, lastError: null, updatedAt: new Date(), authMethod: "app_password" as const, externalId: null, scopes: null, accessExpiresAt: null, refreshedAt: null };
  const [old] = await db.select({ address: mailSenders.address, verifiedAt: mailSenders.verifiedAt }).from(mailSenders).where(eq(mailSenders.userId, userId));
  const keepsVerification = old?.address === address && old.verifiedAt !== null;
  const state = keepsVerification
    ? { status: "active" as const }
    : { status: "unverified" as const, verifiedAt: null, verifyTokenHash: null, verifyExpiresAt: null };
  await db
    .insert(mailSenders)
    .values({ userId, address, ...password, ...state })
    .onConflictDoUpdate({ target: mailSenders.userId, set: { address, ...password, ...state } });
}

/** The decrypted app password, whatever the status, for the test email. Null when nothing is connected or Gmail uses a Google sign-in. */
export async function gmailCredential(db: Db, key: Buffer, userId: string) {
  const [row] = await db.select().from(mailSenders).where(eq(mailSenders.userId, userId));
  if (!row?.passwordCiphertext || !row.passwordIv || !row.passwordAuthTag || row.authMethod !== "app_password") return null;
  const password = decryptSecret(key, userId, PASSWORD, { ciphertext: row.passwordCiphertext, iv: row.passwordIv, authTag: row.passwordAuthTag });
  return { address: row.address, password, status: row.status, verified: row.verifiedAt !== null };
}

/**
 * Called before every send, by the worker and by the API's test email. allowUnconfirmed is only for that test email,
 * which carries the confirmation link and checks a password Google rejected before; it still never uses another sender.
 */
export async function resolveSender(db: Db, key: Buffer, userId: string, { allowUnconfirmed = false } = {}): Promise<ResolvedSender> {
  const profile = await readProfile(db, userId);
  const extras = { fromName: profile?.businessName ?? undefined, replyTo: profile?.replyTo ?? undefined };
  const [row] = await db.select().from(mailSenders).where(eq(mailSenders.userId, userId));
  if (!row) return { kind: "installation", ...extras };
  if (row.status === "disconnected") return { kind: "blocked", reason: "Gmail is disconnected. Reconnect Gmail in Apps." };
  if (!allowUnconfirmed && row.status === "unverified") return { kind: "blocked", reason: "Gmail is connected but not confirmed. Send the test email and confirm it in Apps." };
  if (!allowUnconfirmed && row.status === "failed") return { kind: "blocked", reason: "Gmail could not send. Reconnect Gmail in Apps." };
  if (row.authMethod === "oauth") {
    // The token blob, refreshed under the row lock by the send (oauth/core.ts). The IV is the revision a refusal is marked against.
    const grant = { credential: decryptSecret(key, userId, GMAIL_GRANT, { ciphertext: row.passwordCiphertext!, iv: row.passwordIv!, authTag: row.passwordAuthTag! }), revision: row.passwordIv! };
    return { kind: "gmail_api", address: row.address, grant, ...extras };
  }
  const cred = (await gmailCredential(db, key, userId))!;
  return { kind: "gmail", address: cred.address, password: cred.password, ...extras };
}

/** A fresh one-time link token. Only its hash is stored, and a newer link replaces the older one. */
export async function issueVerifyToken(db: Db, userId: string, ttlMs = VERIFY_TTL_MS) {
  const token = randomBytes(32).toString("base64url");
  await db
    .update(mailSenders)
    .set({ verifyTokenHash: hashToken(token), verifyExpiresAt: new Date(Date.now() + ttlMs) })
    .where(eq(mailSenders.userId, userId));
  return token;
}

/** One guarded UPDATE: the token must be this owner's, unexpired and unused, and the credential still saved. */
export async function claimVerifyToken(db: Db, userId: string, token: string): Promise<boolean> {
  const claimed = await db
    .update(mailSenders)
    .set({ status: "active", verifiedAt: sql`now()`, verifyTokenHash: null, verifyExpiresAt: null, lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(mailSenders.userId, userId),
        eq(mailSenders.verifyTokenHash, hashToken(token)),
        gt(mailSenders.verifyExpiresAt, sql`now()`),
        isNotNull(mailSenders.passwordCiphertext),
      ),
    )
    .returning({ userId: mailSenders.userId });
  return claimed.length === 1;
}

/** Google rejected the login. Sends stay blocked until the owner replaces the password or a test goes through. */
export async function markSenderFailed(db: Db, userId: string, error: string) {
  await db.update(mailSenders).set({ status: "failed", lastError: error.slice(0, 500), updatedAt: new Date() }).where(eq(mailSenders.userId, userId));
}

/** A test email went through: record it, and bring a verified sender that had failed back to active. */
export async function markSenderWorking(db: Db, userId: string) {
  await db
    .update(mailSenders)
    .set({ lastTestedAt: sql`now()`, lastError: null, status: sql`case when ${mailSenders.verifiedAt} is not null then 'active' else 'unverified' end` })
    .where(and(eq(mailSenders.userId, userId), isNotNull(mailSenders.passwordCiphertext)));
}

/** Deletes the password and blocks sending. Runs already waiting to send fail instead of using another sender. */
export async function disconnectGmail(db: Db, userId: string) {
  await db
    .update(mailSenders)
    .set({ status: "disconnected", passwordCiphertext: null, passwordIv: null, passwordAuthTag: null, verifyTokenHash: null, verifyExpiresAt: null, updatedAt: new Date() })
    .where(eq(mailSenders.userId, userId));
}

/** The owner chose to send through the installation's mail server again. */
export async function removeGmail(db: Db, userId: string) {
  await db.delete(mailSenders).where(eq(mailSenders.userId, userId));
}
