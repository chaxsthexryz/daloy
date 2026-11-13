import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import type { Db } from "./index";
import {
  claimVerifyToken,
  connectGmail,
  disconnectGmail,
  gmailCredential,
  issueVerifyToken,
  markSenderFailed,
  markSenderWorking,
  readProfile,
  readSender,
  removeGmail,
  resolveSender,
  saveProfile,
} from "./mail-senders";
import { mailSenders, users } from "./schema";

let db: Db;
let pool: Pool;
const key = randomBytes(32);
let seq = 0;
const newUser = async () => (await db.insert(users).values({ email: `owner${++seq}@test.local`, passwordHash: "x" }).returning())[0]!.id;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);
afterAll(async () => {
  await pool?.end();
});

const verified = async (userId: string, address = `shop${seq}@gmail.com`, appPassword = "abcd efgh ijkl mnop") => {
  await connectGmail(db, key, userId, { address, appPassword });
  expect(await claimVerifyToken(db, userId, await issueVerifyToken(db, userId))).toBe(true);
};

describe("business profile", () => {
  it("saves and reads the profile, and replaces it on a second save", async () => {
    const u = await newUser();
    expect(await readProfile(db, u)).toBeNull();
    await saveProfile(db, u, { businessName: "Lim Dental", website: "https://limdental.example", inquiryEmail: "front@limdental.example", replyTo: null });
    await saveProfile(db, u, { businessName: "Lim Dental Clinic", website: null, inquiryEmail: "front@limdental.example", replyTo: "hello@limdental.example" });
    expect(await readProfile(db, u)).toEqual({ businessName: "Lim Dental Clinic", website: null, inquiryEmail: "front@limdental.example", replyTo: "hello@limdental.example" });
  });
});

describe("sender resolution", () => {
  it("uses the installation mail server when the owner connected nothing, with the profile name and reply address", async () => {
    const u = await newUser();
    expect(await resolveSender(db, key, u)).toEqual({ kind: "installation", fromName: undefined, replyTo: undefined });
    await saveProfile(db, u, { businessName: "Cruz Bakery", website: null, inquiryEmail: null, replyTo: "orders@cruz.example" });
    expect(await resolveSender(db, key, u)).toEqual({ kind: "installation", fromName: "Cruz Bakery", replyTo: "orders@cruz.example" });
  });

  it("blocks a connected Gmail sender until the owner claims the verify link", async () => {
    const u = await newUser();
    await connectGmail(db, key, u, { address: "cruz.bakery@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    expect(await resolveSender(db, key, u)).toMatchObject({ kind: "blocked", reason: expect.stringContaining("confirm") });
    expect(await claimVerifyToken(db, u, await issueVerifyToken(db, u))).toBe(true);
    expect(await resolveSender(db, key, u)).toEqual({ kind: "gmail", address: "cruz.bakery@gmail.com", password: "abcdefghijklmnop", fromName: undefined, replyTo: undefined });
  });

  it("keeps the app password encrypted and bound to its owner", async () => {
    const a = await newUser();
    const b = await newUser();
    await verified(a, "a@gmail.com", "aaaa bbbb cccc dddd");
    const [row] = await db.select().from(mailSenders).where(eq(mailSenders.userId, a));
    expect(JSON.stringify(row)).not.toContain("aaaabbbbccccdddd");
    // A ciphertext copied to another owner's row does not decrypt.
    await db.insert(mailSenders).values({ ...row!, userId: b });
    await expect(resolveSender(db, key, b)).rejects.toThrow();
  });

  it("two owners resolve to their own accounts, and disconnecting one leaves the other active", async () => {
    const a = await newUser();
    const b = await newUser();
    await verified(a, "a.shop@gmail.com", "aaaa aaaa aaaa aaaa");
    await verified(b, "b.shop@gmail.com", "bbbb bbbb bbbb bbbb");
    expect(await resolveSender(db, key, a)).toMatchObject({ kind: "gmail", address: "a.shop@gmail.com", password: "aaaaaaaaaaaaaaaa" });
    await disconnectGmail(db, a);
    expect(await resolveSender(db, key, a)).toMatchObject({ kind: "blocked", reason: expect.stringContaining("disconnected") });
    expect(await resolveSender(db, key, b)).toMatchObject({ kind: "gmail", address: "b.shop@gmail.com", password: "bbbbbbbbbbbbbbbb" });
    const [row] = await db.select().from(mailSenders).where(eq(mailSenders.userId, a));
    expect(row).toMatchObject({ status: "disconnected", passwordCiphertext: null, passwordIv: null, passwordAuthTag: null });
    expect(await gmailCredential(db, key, a)).toBeNull();
  });

  it("blocks a sender whose password Google rejected until it is replaced or tested again", async () => {
    const u = await newUser();
    await verified(u, "c@gmail.com");
    await markSenderFailed(db, u, "Gmail rejected the app password.");
    expect(await resolveSender(db, key, u)).toMatchObject({ kind: "blocked", reason: expect.stringContaining("Reconnect Gmail") });
    expect(await readSender(db, u)).toMatchObject({ status: "failed", lastError: "Gmail rejected the app password." });
    // A test email that goes through restores a verified sender.
    await markSenderWorking(db, u);
    expect(await resolveSender(db, key, u)).toMatchObject({ kind: "gmail" });
  });

  it("replacing the password keeps a verified address verified; a new address needs a new link", async () => {
    const u = await newUser();
    await verified(u, "d@gmail.com", "1111 1111 1111 1111");
    await connectGmail(db, key, u, { address: "d@gmail.com", appPassword: "2222 2222 2222 2222" });
    expect(await resolveSender(db, key, u)).toMatchObject({ kind: "gmail", password: "2222222222222222" });
    await connectGmail(db, key, u, { address: "other.d@gmail.com", appPassword: "3333 3333 3333 3333" });
    expect(await resolveSender(db, key, u)).toMatchObject({ kind: "blocked" });
    expect(await readSender(db, u)).toMatchObject({ address: "other.d@gmail.com", status: "unverified", verifiedAt: null });
  });

  it("removing the sender returns the owner to the installation server", async () => {
    const u = await newUser();
    await verified(u);
    await removeGmail(db, u);
    expect(await resolveSender(db, key, u)).toMatchObject({ kind: "installation" });
    expect(await readSender(db, u)).toBeNull();
  });
});

describe("verify link", () => {
  it("works once", async () => {
    const u = await newUser();
    await connectGmail(db, key, u, { address: "e@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    const token = await issueVerifyToken(db, u);
    expect(await claimVerifyToken(db, u, token)).toBe(true);
    expect(await claimVerifyToken(db, u, token)).toBe(false);
  });

  it("only for the owner it was sent to", async () => {
    const a = await newUser();
    const b = await newUser();
    await connectGmail(db, key, a, { address: "f@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    await connectGmail(db, key, b, { address: "g@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    const token = await issueVerifyToken(db, a);
    expect(await claimVerifyToken(db, b, token)).toBe(false);
    expect(await resolveSender(db, key, b)).toMatchObject({ kind: "blocked" });
    expect(await claimVerifyToken(db, a, token)).toBe(true);
  });

  it("expires", async () => {
    const u = await newUser();
    await connectGmail(db, key, u, { address: "h@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    const token = await issueVerifyToken(db, u, -1000);
    expect(await claimVerifyToken(db, u, token)).toBe(false);
  });

  it("is replaced by a newer link and dropped when the address changes or Gmail is disconnected", async () => {
    const u = await newUser();
    await connectGmail(db, key, u, { address: "i@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    const first = await issueVerifyToken(db, u);
    const second = await issueVerifyToken(db, u);
    expect(await claimVerifyToken(db, u, first)).toBe(false);
    const third = await issueVerifyToken(db, u);
    await connectGmail(db, key, u, { address: "j@gmail.com", appPassword: "abcd efgh ijkl mnop" });
    expect(await claimVerifyToken(db, u, third)).toBe(false);
    const fourth = await issueVerifyToken(db, u);
    await disconnectGmail(db, u);
    expect(await claimVerifyToken(db, u, fourth)).toBe(false);
    expect(second).not.toBe(first);
  });
});
