import { and, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import { connections, type AuthMethod, type Provider } from "./schema";

export const PROVIDER_NAMES: Record<Provider, string> = { google_sheets: "Google Sheets", slack: "Slack", outlook: "Outlook", teams: "Microsoft Teams", telegram: "Telegram", google_calendar: "Google Calendar", google_drive: "Google Drive", paymongo: "PayMongo", airtable: "Airtable", notion: "Notion", trello: "Trello", unisms: "UniSMS" };

/** What a pasted credential is, by provider. An Outlook credential is always a Microsoft grant. */
const PASTED: Record<Provider, AuthMethod> = { google_sheets: "service_account", google_calendar: "service_account", google_drive: "service_account", teams: "webhook_url", outlook: "oauth", slack: "token", telegram: "token", paymongo: "token", airtable: "token", notion: "token", trello: "token", unisms: "token" };

/** Operator shared UniSMS fallback from env, enabled only when SHARED_UNISMS_KEY=open with both key and sender id set. */
export function sharedUnismsConfig(env: NodeJS.ProcessEnv = process.env): { secretKey: string; senderId: string } | null {
  if (env.SHARED_UNISMS_KEY !== "open") return null;
  const secretKey = env.UNISMS_SECRET_KEY?.trim();
  const senderId = env.UNISMS_SENDER_ID?.trim();
  if (!secretKey || !senderId) return null;
  return { secretKey, senderId };
}

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
    // A pasted credential replaces any OAuth grant, so its OAuth fields go too (OAuth saves are in oauth/core.ts).
    authMethod: PASTED[provider],
    externalId: null,
    scopes: null,
    oauthClientId: null,
    accessExpiresAt: null,
    refreshedAt: null,
  };
  await db.insert(connections).values({ userId, provider, ...values }).onConflictDoUpdate({ target: [connections.userId, connections.provider], set: values });
}

/** The owner's connections for the console. Credentials never leave this module. */
export async function readConnections(db: Db, userId: string) {
  return db
    .select({ provider: connections.provider, status: connections.status, authMethod: connections.authMethod, account: connections.account, destination: connections.destination, lastError: connections.lastError, lastTestedAt: connections.lastTestedAt })
    .from(connections)
    .where(eq(connections.userId, userId));
}

/** The decrypted credential with its status and destination, for a delivery or a test. Null when not connected. */
export async function connectionCredential(db: Db, key: Buffer, userId: string, provider: Provider) {
  const [row] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, provider)));
  if (!row) return null;
  const credential = decryptSecret(key, userId, secretName(provider), { ciphertext: row.credentialCiphertext, iv: row.credentialIv, authTag: row.credentialAuthTag });
  // revision changes on every save (a new IV), so a late answer about this credential can be told from one about its replacement.
  return { credential, status: row.status, account: row.account, destination: row.destination, revision: row.credentialIv, authMethod: row.authMethod, externalId: row.externalId };
}

export async function setDestination(db: Db, userId: string, provider: Provider, destination: Record<string, string>, revision?: string) {
  const changed = await db.update(connections).set({ destination, updatedAt: new Date() }).where(and(eq(connections.userId, userId), eq(connections.provider, provider), revision ? eq(connections.credentialIv, revision) : undefined)).returning({ userId: connections.userId });
  return changed.length === 1;
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
