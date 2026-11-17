import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { disconnectEmailSource, emailSourceInputSchema, readEmailSource, requestEmailSourceCheck, saveEmailSource } from "./email-sources";
import type { Db } from "./index";
import { emailSources, users, workflows } from "./schema";

let db: Db;
let pool: Pool;
const key = randomBytes(32);
let seq = 0;
const input = { host: "imap.example.com", username: "office@example.com", password: "synthetic-app-password", folder: "INBOX" };
async function owner() {
  const user = (
    await db
      .insert(users)
      .values({ email: `mail${++seq}@test.local`, passwordHash: "x" })
      .returning()
  )[0]!;
  const wf = (await db.insert(workflows).values({ userId: user.id, name: "Email intake", slug: "email" }).returning())[0]!;
  return { userId: user.id, workflowId: wf.id };
}
beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);
afterAll(async () => {
  await pool?.end();
});

describe("email mailbox settings", () => {
  it("validates host-only names, bounded login fields and folders", () => {
    expect(emailSourceInputSchema.parse(input)).toEqual(input);
    for (const host of ["https://imap.example.com", "localhost", "127.0.0.1", "[::1]", "imap.example.com:143", "a\r\n.example.com"]) {
      expect(emailSourceInputSchema.safeParse({ ...input, host }).success).toBe(false);
    }
    expect(emailSourceInputSchema.safeParse({ ...input, password: "" }).success).toBe(false);
    expect(emailSourceInputSchema.safeParse({ ...input, folder: "INBOX\n" }).success).toBe(false);
  });
  it("encrypts the password and returns only safe status fields", async () => {
    const own = await owner();
    expect(await readEmailSource(db, own.workflowId)).toBeNull();
    const saved = await saveEmailSource(db, key, own.userId, own.workflowId, input);
    expect(saved).toMatchObject({ host: input.host, username: input.username, folder: "INBOX", status: "pending", lastError: null });
    expect(Object.keys(saved!)).toEqual(["host", "username", "folder", "status", "listening", "lastCheckedAt", "lastError"]);
    const [row] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    expect(JSON.stringify(row)).not.toContain(input.password);
    const another = await owner();
    await expect(saveEmailSource(db, key, another.userId, own.workflowId, input)).rejects.toThrow("Automation not found");
  });
  it("fences old polls on password replace and retains the same mailbox checkpoint", async () => {
    const own = await owner();
    await saveEmailSource(db, key, own.userId, own.workflowId, input);
    const [first] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    await db
      .update(emailSources)
      .set({ uidValidity: "77", lastUid: 42, status: "active", claimId: "00000000-0000-4000-8000-000000000001" })
      .where(eq(emailSources.workflowId, own.workflowId));
    await saveEmailSource(db, key, own.userId, own.workflowId, { ...input, password: "replacement-password" });
    const [replaced] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    expect(replaced).toMatchObject({ uidValidity: "77", lastUid: 42, status: "pending", claimId: null });
    expect(replaced!.revision).not.toBe(first!.revision);
    await saveEmailSource(db, key, own.userId, own.workflowId, { ...input, folder: "Website" });
    const [changed] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    expect(changed).toMatchObject({ uidValidity: null, lastUid: null });
  });
  it("disconnect erases the credential and invalidates in-flight checks; check cannot reconnect it", async () => {
    const own = await owner();
    await saveEmailSource(db, key, own.userId, own.workflowId, input);
    await disconnectEmailSource(db, own.workflowId);
    expect(await requestEmailSourceCheck(db, own.workflowId)).toMatchObject({ status: "disconnected" });
    const [row] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    expect(row).toMatchObject({ ciphertext: null, iv: null, authTag: null, claimId: null, status: "disconnected" });
    expect(await requestEmailSourceCheck(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
