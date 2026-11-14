import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./index";
import { retiredSecrets, secrets } from "./schema";

export type EncryptedSecret = { ciphertext: string; iv: string; authTag: string };

// The owner and name are bound in as associated data, so a ciphertext copied to another row or user fails to decrypt.
const aad = (userId: string, name: string) => Buffer.from(`${userId}:${name}`);

/** AES-256-GCM with a fresh 12-byte IV per write. */
export function encryptSecret(key: Buffer, userId: string, name: string, plaintext: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(aad(userId, name));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
}

export function decryptSecret(key: Buffer, userId: string, name: string, s: EncryptedSecret): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"), { authTagLength: 16 }).setAAD(aad(userId, name));
  decipher.setAuthTag(Buffer.from(s.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(s.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export async function readSecret(db: Db, key: Buffer, userId: string, name: string): Promise<string | undefined> {
  const [row] = await db.select().from(secrets).where(and(eq(secrets.userId, userId), eq(secrets.name, name)));
  return row && decryptSecret(key, userId, name, row);
}

/** Every secret a user owns, decrypted, by name. The worker uses this to fill {{secrets.<name>}}. */
export async function readSecrets(db: Db, key: Buffer, userId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(secrets).where(eq(secrets.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.name, decryptSecret(key, userId, r.name, r)]));
}


/**
 * Keeps the current value of a secret that is about to be replaced or deleted, as it is, for redaction only
 * (decision 0025). Call it in the same transaction as the replace or delete. It first takes a transaction lock on this
 * workspace and secret name, so concurrent replaces and deletes run one after another and each retires the value the
 * previous one wrote; without it two could retire the same old value and lose the one in between. The lock also covers
 * a name with no row yet, which a row lock could not.
 */
export async function retireSecret(tx: Pick<Db, "select" | "insert" | "execute">, userId: string, name: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`secret:${userId}:${name}`}, 0))`);
  const [row] = await tx.select().from(secrets).where(and(eq(secrets.userId, userId), eq(secrets.name, name)));
  if (row) await tx.insert(retiredSecrets).values({ userId, name, ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag });
}

/**
 * Every value a workspace's run history may contain: current secrets and retired ones. Never given to a workflow.
 * One statement, so one snapshot: a rotation or deletion commits the retired copy and the change together, so a value
 * is either still current or already retired here, never missing from both (retest of 6e603de).
 */
export async function secretValuesToHide(db: Db, key: Buffer, userId: string): Promise<string[]> {
  const { rows } = await db.execute<EncryptedSecret & { name: string }>(sql`
    select name, ciphertext, iv, auth_tag as "authTag" from secrets where user_id = ${userId}
    union all
    select name, ciphertext, iv, auth_tag as "authTag" from retired_secrets where user_id = ${userId}`);
  return rows.map((r) => decryptSecret(key, userId, r.name, r));
}

/**
 * The forms a secret takes once it is written somewhere: as is, inside a JSON string, and URL or form encoded.
 * Longest first, so a secret that contains another is fully hidden.
 */
export function secretForms(values: string[]): string[] {
  const forms = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(encodeURIComponent(v));
    forms.add(new URLSearchParams({ v }).toString().slice(2));
  }
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** Replaces every form of every secret value in strings (keys too) with [secret], at any depth. Returns a copy. */
export function redactSecrets(value: unknown, forms: string[]): unknown {
  if (forms.length === 0) return value;
  if (typeof value === "string") return forms.reduce((s, f) => s.replaceAll(f, "[secret]"), value);
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, forms));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactSecrets(k, forms), redactSecrets(v, forms)]));
  }
  return value;
}
