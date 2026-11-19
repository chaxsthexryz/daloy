import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import type { Db } from "../index";
import { connections, mailSenders, users, type Provider } from "../schema";
import { sharedGrants } from "./shared";

// Plan R14: a provider may keep one grant per account and client, so a revoke in one place can end Daloy's access in another.
let db: Db;
let pool: Pool;
let seq = 0;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);
afterAll(async () => {
  await pool?.end();
});

async function workspace() {
  const [u] = await db.insert(users).values({ email: `sh${++seq}@test.local`, passwordHash: "x" }).returning();
  return u!.id;
}
const grant = (userId: string, provider: Provider, externalId: string | null, authMethod: "oauth" | "token" = "oauth") =>
  db.insert(connections).values({ userId, provider, status: "active", account: "a", credentialCiphertext: "c", credentialIv: `iv${++seq}`, credentialAuthTag: "t", authMethod, externalId });
const gmail = (userId: string, externalId: string, overrides: Partial<typeof mailSenders.$inferInsert> = {}) =>
  db.insert(mailSenders).values({
    userId,
    address: `g${++seq}@gmail.test`,
    status: "active",
    authMethod: "oauth",
    externalId,
    passwordCiphertext: "c",
    passwordIv: `iv${++seq}`,
    passwordAuthTag: "t",
    ...overrides,
  });

describe("shared grants", () => {
  it("flags the same provider account in two workspaces, in both", async () => {
    const [a, b] = [await workspace(), await workspace()];
    await grant(a, "slack", "T-SHARED");
    await grant(b, "slack", "T-SHARED");
    expect(await sharedGrants(db, a)).toEqual(["slack"]);
    expect(await sharedGrants(db, b)).toEqual(["slack"]);
  });

  it("does not flag another account of the same provider, a pasted token or a grant without an account id", async () => {
    const [a, b] = [await workspace(), await workspace()];
    await grant(a, "trello", "member-1");
    await grant(b, "trello", "member-2");
    await grant(a, "airtable", "usr-1");
    await grant(b, "airtable", "usr-1", "token");
    await grant(a, "notion", null);
    await grant(b, "notion", null);
    expect(await sharedGrants(db, a)).toEqual([]);
  });

  it("treats every Google app and Gmail as one Google account, in the same workspace too", async () => {
    const [a, b] = [await workspace(), await workspace()];
    await grant(a, "google_sheets", "sub-1");
    await grant(a, "google_calendar", "sub-1");
    await grant(a, "google_drive", "sub-2");
    await gmail(b, "sub-2");
    expect((await sharedGrants(db, a)).sort()).toEqual(["google_calendar", "google_drive", "google_sheets"]);
    expect(await sharedGrants(db, b)).toEqual(["gmail"]);
  });

  it("does not match a Google account id against another provider's id", async () => {
    const [a, b] = [await workspace(), await workspace()];
    await grant(a, "google_sheets", "same-id");
    await grant(b, "trello", "same-id");
    expect(await sharedGrants(db, a)).toEqual([]);
    expect(await sharedGrants(db, b)).toEqual([]);
  });

  it("ignores a disconnected Gmail sender and one without a stored credential (L4)", async () => {
    const [a, b, c] = [await workspace(), await workspace(), await workspace()];
    await grant(a, "google_sheets", "sub-disc");
    await gmail(a, "sub-disc", { status: "disconnected", passwordCiphertext: null, passwordIv: null, passwordAuthTag: null });
    await gmail(b, "sub-disc", { status: "disconnected", passwordCiphertext: "stale" });
    await gmail(c, "sub-disc", { status: "active", passwordCiphertext: null, passwordIv: null, passwordAuthTag: null });
    expect(await sharedGrants(db, a)).toEqual([]);
    expect(await sharedGrants(db, b)).toEqual([]);
    expect(await sharedGrants(db, c)).toEqual([]);
  });
});
