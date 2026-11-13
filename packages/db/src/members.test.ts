import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { hashToken } from "./approvals";
import { claimInvite, createInvite, findApprover, joinWorkspace, listMembers, membershipOf, removeMember, setMemberRole } from "./members";
import { invites, sessions, users, workspaceMembers } from "./schema";
import type { Db } from "./index";

let db: Db;
let pool: Pool;
let ownerId: string;
let seq = 0;

async function account(email = `u${++seq}@test.local`) {
  const [u] = await db.insert(users).values({ email, passwordHash: "x" }).returning();
  return u!;
}

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  ownerId = (await account("owner@test.local")).id;
  await joinWorkspace(db, ownerId, ownerId, "owner");
}, 120_000);

afterAll(async () => {
  await pool?.end();
});

describe("workspace_members constraints", () => {
  it("keeps the owner row the one where workspace and user are the same", async () => {
    const u = await account();
    await expect(joinWorkspace(db, u.id, ownerId, "owner")).rejects.toThrow();
    await expect(joinWorkspace(db, u.id, u.id, "operator")).rejects.toThrow();
  });

  it("allows one workspace per account", async () => {
    const u = await account();
    await joinWorkspace(db, u.id, ownerId, "operator");
    const other = await account();
    await joinWorkspace(db, other.id, other.id, "owner");
    await expect(joinWorkspace(db, u.id, other.id, "operator")).rejects.toThrow();
    expect(await membershipOf(db, u.id)).toEqual({ workspaceId: ownerId, role: "operator" });
  });

  it("returns null for an account with no membership", async () => {
    expect(await membershipOf(db, (await account()).id)).toBeNull();
  });
});

describe("invites", () => {
  it("stores only the token hash and can be claimed once", async () => {
    const token = await createInvite(db, ownerId, "New@Test.local", "approver");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token)));
    expect(row!.email).toBe("new@test.local");
    expect(await claimInvite(db, token)).toEqual({ workspaceId: ownerId, email: "new@test.local", role: "approver" });
    expect(await claimInvite(db, token)).toBeNull();
  });

  it("refuses an expired or unknown invite", async () => {
    const token = await createInvite(db, ownerId, "late@test.local", "operator", -1000);
    expect(await claimInvite(db, token)).toBeNull();
    expect(await claimInvite(db, "z".repeat(43))).toBeNull();
  });

  it("can't invite an owner", async () => {
    await expect(createInvite(db, ownerId, "boss@test.local", "owner")).rejects.toThrow();
  });
});

describe("changing members", () => {
  it("changes a member's role but never the owner's, and never to owner", async () => {
    const u = await account();
    await joinWorkspace(db, u.id, ownerId, "requester");
    expect(await setMemberRole(db, ownerId, u.id, "approver")).toBe(true);
    expect((await membershipOf(db, u.id))?.role).toBe("approver");
    expect(await setMemberRole(db, ownerId, ownerId, "operator")).toBe(false);
    expect(await setMemberRole(db, ownerId, u.id, "owner")).toBe(false);
    expect((await membershipOf(db, ownerId))?.role).toBe("owner");
  });

  it("only changes members of the given workspace", async () => {
    const other = await account();
    await joinWorkspace(db, other.id, other.id, "owner");
    const theirs = await account();
    await joinWorkspace(db, theirs.id, other.id, "operator");
    expect(await setMemberRole(db, ownerId, theirs.id, "approver")).toBe(false);
    expect(await removeMember(db, ownerId, theirs.id)).toBe(false);
    expect(await membershipOf(db, theirs.id)).toEqual({ workspaceId: other.id, role: "operator" });
  });

  it("removing a member ends their sessions and keeps the owner", async () => {
    const u = await account();
    await joinWorkspace(db, u.id, ownerId, "operator");
    await db.insert(sessions).values({ idHash: `s${seq}`, userId: u.id, expiresAt: new Date(Date.now() + 60_000) });
    expect(await removeMember(db, ownerId, u.id)).toBe(true);
    expect(await membershipOf(db, u.id)).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(0);
    expect(await removeMember(db, ownerId, ownerId)).toBe(false);
  });

  it("lists the workspace's members with emails, owner first", async () => {
    const list = await listMembers(db, ownerId);
    expect(list[0]).toMatchObject({ userId: ownerId, email: "owner@test.local", role: "owner" });
    expect(list.every((m) => typeof m.email === "string")).toBe(true);
    const ids = (await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ownerId))).map((m) => m.userId);
    expect(list.map((m) => m.userId).sort()).toEqual(ids.sort());
  });
});

describe("findApprover", () => {
  it("finds an owner or approver of the workspace by email, and nobody else", async () => {
    const approver = await account("Approver.One@test.local".toLowerCase());
    await joinWorkspace(db, approver.id, ownerId, "approver");
    const operator = await account();
    await joinWorkspace(db, operator.id, ownerId, "operator");
    const stranger = await account();
    await joinWorkspace(db, stranger.id, stranger.id, "owner");

    expect(await findApprover(db, ownerId, "APPROVER.one@test.local")).toEqual({ id: approver.id, email: approver.email });
    expect(await findApprover(db, ownerId, "owner@test.local")).toMatchObject({ id: ownerId });
    expect(await findApprover(db, ownerId, operator.email)).toBeNull();
    expect(await findApprover(db, ownerId, stranger.email)).toBeNull();
    expect(await findApprover(db, ownerId, "nobody@test.local")).toBeNull();
  });
});
