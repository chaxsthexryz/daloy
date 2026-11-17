import { and, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import { connections, type Provider } from "./schema";

export const PROVIDER_NAMES: Record<Provider, string> = { google_sheets: "Google Sheets", slack: "Slack", outlook: "Outlook", teams: "Microsoft Teams", telegram: "Telegram", google_calendar: "Google Calendar", paymongo: "PayMongo", airtable: "Airtable", notion: "Notion", trello: "Trello" };

// The owner id is in the associated data (crypto.ts), so a credential copied to another owner's row does not decrypt.
const secretName = (provider: Provider) => `connection:${provider}`;

/** Connect and Reconnect: stores the credential encrypted, and makes the connection active again. */
export async function saveConnection(db: Db, key: Buffer, userId: string, provider: Provider, input: { account: string; credential: string; destination?: Record<string, string> | null }) {
  const e = encryptSecret(key, userId, secretName(provider), input.credential);
  const values = {
    status: "active" as const,
    account: input.account,
    credentialCiphertext: e.ciphertext,
    credentialIv: e.iv,
    credentialAuthTag: e.authTag,
    destination: input.destination ?? null,
    lastError: null,
    updatedAt: new Date(),
  };
  await db.insert(connections).values({ userId, provider, ...values }).onConflictDoUpdate({ target: [connections.userId, connections.provider], set: values });
}

/** The owner's connections for the console. Credentials never leave this module. */
export async function readConnections(db: Db, userId: string) {
  return db
    .select({ provider: connections.provider, status: connections.status, account: connections.account, destination: connections.destination, lastError: connections.lastError, lastTestedAt: connections.lastTestedAt })
    .from(connections)
    .where(eq(connections.userId, userId));
}

/** The decrypted credential with its status and destination, for a delivery or a test. Null when not connected. */
export async function connectionCredential(db: Db, key: Buffer, userId: string, provider: Provider) {
  const [row] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, provider)));
  if (!row) return null;
  const credential = decryptSecret(key, userId, secretName(provider), { ciphertext: row.credentialCiphertext, iv: row.credentialIv, authTag: row.credentialAuthTag });
  // revision changes on every save (a new IV), so a late answer about this credential can be told from one about its replacement.
  return { credential, status: row.status, account: row.account, destination: row.destination, revision: row.credentialIv };
}

/**
 * Stores a credential the provider replaced, such as Microsoft's rotated refresh token, but only over the revision it
 * was rotated from: a late rotation for a mailbox the owner has since reconnected changes nothing (Astra, 283fa1a).
 * Returns the new revision, or null when the stored credential is no longer that one. Status and destination stay.
 */
export async function updateCredential(db: Db, key: Buffer, userId: string, provider: Provider, credential: string, revision: string): Promise<string | null> {
  const e = encryptSecret(key, userId, secretName(provider), credential);
  const saved = await db
    .update(connections)
    .set({ credentialCiphertext: e.ciphertext, credentialIv: e.iv, credentialAuthTag: e.authTag, updatedAt: new Date() })
    .where(and(eq(connections.userId, userId), eq(connections.provider, provider), eq(connections.credentialIv, revision)))
    .returning({ revision: connections.credentialIv });
  return saved[0]?.revision ?? null;
}

/** A save function for a provider that rotates its credential: it follows conn.revision, so later status writes match. */
export const rotateInto = (db: Db, key: Buffer, userId: string, provider: Provider, conn: { revision: string }) => async (credential: string) => {
  const next = await updateCredential(db, key, userId, provider, credential, conn.revision);
  if (next) conn.revision = next;
};

export async function setDestination(db: Db, userId: string, provider: Provider, destination: Record<string, string>) {
  await db.update(connections).set({ destination, updatedAt: new Date() }).where(and(eq(connections.userId, userId), eq(connections.provider, provider)));
}

/**
 * The provider rejected the credential of this revision. Deliveries stop until the owner reconnects or a test goes
 * through. A refusal that arrives after the owner saved a new credential changes nothing (Astra, 8e2c5d8).
 */
export async function markConnectionFailed(db: Db, userId: string, provider: Provider, error: string, revision: string) {
  await db
    .update(connections)
    .set({ status: "failed", lastError: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(connections.userId, userId), eq(connections.provider, provider), eq(connections.credentialIv, revision)));
}

/** A test went through with the credential of this revision. */
export async function markConnectionWorking(db: Db, userId: string, provider: Provider, revision: string) {
  await db
    .update(connections)
    .set({ status: "active", lastError: null, lastTestedAt: sql`now()` })
    .where(and(eq(connections.userId, userId), eq(connections.provider, provider), eq(connections.credentialIv, revision)));
}

/** Disconnect: deletes the credential. Queued deliveries then fail with "not connected" and keep their payload for Retry. */
export async function removeConnection(db: Db, userId: string, provider: Provider) {
  const deleted = await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, provider))).returning({ userId: connections.userId });
  return deleted.length === 1;
}
