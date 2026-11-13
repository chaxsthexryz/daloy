import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index";
import { secrets } from "./schema";

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
