import { and, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import { connections, retiredSecrets, type AuthMethod, type Provider } from "./schema";

export const PROVIDER_NAMES: Record<Provider, string> = { google_sheets: "Google Sheets", slack: "Slack", outlook: "Outlook", teams: "Microsoft Teams", telegram: "Telegram", google_calendar: "Google Calendar", google_drive: "Google Drive", paymongo: "PayMongo", airtable: "Airtable", notion: "Notion", trello: "Trello", unisms: "UniSMS", meta_messenger: "Facebook Messenger & Instagram" };

/** What a pasted credential is, by provider. An Outlook credential is always a Microsoft grant. */
const PASTED: Record<Provider, AuthMethod> = { google_sheets: "service_account", google_calendar: "service_account", google_drive: "service_account", teams: "webhook_url", outlook: "oauth", slack: "token", telegram: "token", paymongo: "token", airtable: "token", notion: "token", trello: "token", unisms: "token", meta_messenger: "token" };

/**
 * The server's UniSMS settings: the only source of SMS credentials (decision 0100). Set when both UNISMS_SECRET_KEY and
 * UNISMS_SENDER_ID are present. Workspaces never hold a UniSMS key; each is limited by its plan's monthly sms quota.
 */
export function unismsConfig(env: NodeJS.ProcessEnv = process.env): { secretKey: string; senderId: string } | null {
  const secretKey = env.UNISMS_SECRET_KEY?.trim();
  const senderId = env.UNISMS_SENDER_ID?.trim();
  if (!secretKey || !senderId) return null;
  return { secretKey, senderId };
}

/** What a delivery or a publish says when the server has no UniSMS settings. */
export const SMS_NOT_SET_UP = "SMS is not set up on this server.";

/**
 * One-time clean-up for workspaces that saved their own UniSMS key before decision 0100: the key moves into
 * retired_secrets (so history still hides it and the daily purge scrubs it) and the connection row goes. Idempotent,
 * safe on every worker start. Returns how many keys it retired.
 */
export async function retireStoredUnismsKeys(db: Db): Promise<number> {
  const rows = await db.select({ userId: connections.userId }).from(connections).where(eq(connections.provider, "unisms"));
  for (const { userId } of rows) {
    await db.transaction(async (tx) => {
      await retireConnectionInTx(tx, userId, "unisms");
      await tx.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, "unisms")));
    });
  }
  return rows.length;
}

// The owner id is in the associated data (crypto.ts), so a credential copied to another owner's row does not decrypt.
const secretName = (provider: Provider) => `connection:${provider}`;
const RETIRED_CONNECTION_PROVIDERS = new Set<Provider>(["unisms", "meta_messenger"]);

async function retireConnectionInTx(tx: Pick<Db, "select" | "insert" | "execute">, userId: string, provider: Provider) {
  const name = secretName(provider);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`secret:${userId}:${name}`}, 0))`);
  if (!RETIRED_CONNECTION_PROVIDERS.has(provider)) return;
  const [old] = await tx.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, provider)));
  if (old) {
    await tx.insert(retiredSecrets).values({
      userId,
      name,
      ciphertext: old.credentialCiphertext,
      iv: old.credentialIv,
      authTag: old.credentialAuthTag,
    });
  }
}

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
  await db.transaction(async (tx) => {
    await retireConnectionInTx(tx, userId, provider);
    await tx.insert(connections).values({ userId, provider, ...values }).onConflictDoUpdate({ target: [connections.userId, connections.provider], set: values });
  });
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
  return db.transaction(async (tx) => {
    await retireConnectionInTx(tx, userId, provider);
    const deleted = await tx.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, provider))).returning({ userId: connections.userId });
    return deleted.length === 1;
  });
}
