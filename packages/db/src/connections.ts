import { and, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import { connections, type Provider } from "./schema";

export const PROVIDER_NAMES: Record<Provider, string> = { google_sheets: "Google Sheets", slack: "Slack", outlook: "Outlook", teams: "Microsoft Teams" };

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
  return { credential, status: row.status, account: row.account, destination: row.destination };
}

/** Stores a credential the provider replaced, such as Microsoft's rotated refresh token. Status and destination stay. */
export async function updateCredential(db: Db, key: Buffer, userId: string, provider: Provider, credential: string) {
  const e = encryptSecret(key, userId, secretName(provider), credential);
  await db
    .update(connections)
    .set({ credentialCiphertext: e.ciphertext, credentialIv: e.iv, credentialAuthTag: e.authTag, updatedAt: new Date() })
    .where(and(eq(connections.userId, userId), eq(connections.provider, provider)));
}

export async function setDestination(db: Db, userId: string, provider: Provider, destination: Record<string, string>) {
  await db.update(connections).set({ destination, updatedAt: new Date() }).where(and(eq(connections.userId, userId), eq(connections.provider, provider)));
}

/** The provider rejected the credential. Deliveries stop until the owner reconnects or a test goes through. */
export async function markConnectionFailed(db: Db, userId: string, provider: Provider, error: string) {
  await db
    .update(connections)
    .set({ status: "failed", lastError: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(connections.userId, userId), eq(connections.provider, provider)));
}

/** A test went through with the stored credential. */
export async function markConnectionWorking(db: Db, userId: string, provider: Provider) {
  await db
    .update(connections)
    .set({ status: "active", lastError: null, lastTestedAt: sql`now()` })
    .where(and(eq(connections.userId, userId), eq(connections.provider, provider)));
}

/** Disconnect: deletes the credential. Queued deliveries then fail with "not connected" and keep their payload for Retry. */
export async function removeConnection(db: Db, userId: string, provider: Provider) {
  const deleted = await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, provider))).returning({ userId: connections.userId });
  return deleted.length === 1;
}
