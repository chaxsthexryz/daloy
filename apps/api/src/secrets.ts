import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { secrets, type Db } from "@daloy/db";
import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Put, UseGuards } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { CONFIG, CurrentUser, DB, ZodPipe, type ApiConfig, type SessionUser } from "./http";

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
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64")).setAAD(aad(userId, name));
  decipher.setAuthTag(Buffer.from(s.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(s.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

// shortcut: decryption lives in the API until the worker needs secrets (phase 4), then it moves to a shared package.
export async function readSecret(db: Db, key: Buffer, userId: string, name: string): Promise<string | undefined> {
  const [row] = await db.select().from(secrets).where(and(eq(secrets.userId, userId), eq(secrets.name, name)));
  return row && decryptSecret(key, userId, name, row);
}

const secretName = new ZodPipe(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/, "use a-z, 0-9 and _"));
const secretInput = z.object({ value: z.string().min(1).max(10_000) });

/** Write-only: values go in, only names come back out. */
@Controller("secrets")
@UseGuards(SessionGuard)
export class SecretsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.db.select({ name: secrets.name, createdAt: secrets.createdAt }).from(secrets).where(eq(secrets.userId, user.id)).orderBy(asc(secrets.name));
  }

  @Put(":name")
  @HttpCode(204)
  async put(@CurrentUser() user: SessionUser, @Param("name", secretName) name: string, @Body(new ZodPipe(secretInput)) body: z.output<typeof secretInput>) {
    const encrypted = encryptSecret(this.config.secretsKey, user.id, name, body.value);
    await this.db
      .insert(secrets)
      .values({ userId: user.id, name, ...encrypted })
      .onConflictDoUpdate({ target: [secrets.userId, secrets.name], set: encrypted });
  }

  @Delete(":name")
  @HttpCode(204)
  async remove(@CurrentUser() user: SessionUser, @Param("name", secretName) name: string) {
    const deleted = await this.db.delete(secrets).where(and(eq(secrets.userId, user.id), eq(secrets.name, name))).returning({ id: secrets.id });
    if (deleted.length === 0) throw new NotFoundException();
  }
}
