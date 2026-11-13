import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { hashToken } from "./approvals";
import { invites, sessions, users, workspaceMembers, type Role } from "./schema";

type AnyDb = NodePgDatabase<Record<string, unknown>>;
type Writer = Pick<AnyDb, "select" | "insert" | "update" | "delete">;

/** Roles that may answer an approval named to them (decision 0022). */
export const CAN_APPROVE: readonly Role[] = ["owner", "approver"];
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;

export type Membership = { workspaceId: string; role: Role };

export async function membershipOf(db: Writer, userId: string): Promise<Membership | null> {
  const [m] = await db.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
  return m ?? null;
}

/** Fails on a second workspace for the same account (primary key) and on an owner row that isn't the account's own (check). */
export async function joinWorkspace(db: Writer, userId: string, workspaceId: string, role: Role) {
  await db.insert(workspaceMembers).values({ userId, workspaceId, role });
}

export async function listMembers(db: AnyDb, workspaceId: string) {
  return db
    .select({ userId: workspaceMembers.userId, email: users.email, role: workspaceMembers.role, createdAt: workspaceMembers.createdAt })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(sql`${workspaceMembers.role} = 'owner' desc`, asc(workspaceMembers.createdAt));
}

/** The owner role can't be changed, given or taken. Returns false when nothing matched. */
export async function setMemberRole(db: AnyDb, workspaceId: string, userId: string, role: Role): Promise<boolean> {
  if (role === "owner") return false;
  const changed = await db
    .update(workspaceMembers)
    .set({ role })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), ne(workspaceMembers.role, "owner")))
    .returning({ userId: workspaceMembers.userId });
  return changed.length > 0;
}

/** Takes the member out of the workspace and signs them out everywhere. The account stays, so past decisions keep their author. */
export async function removeMember(db: AnyDb, workspaceId: string, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const gone = await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), ne(workspaceMembers.role, "owner")))
      .returning({ userId: workspaceMembers.userId });
    if (gone.length === 0) return false;
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    return true;
  });
}

/** A 32-byte url-safe token; only its SHA-256 is stored. The check constraint refuses an owner invite. */
export async function createInvite(db: AnyDb, workspaceId: string, email: string, role: Role, ttlMs = INVITE_MS): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(invites).values({ workspaceId, email: email.toLowerCase(), role, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) });
  return token;
}

/** Uses the invite: one guarded UPDATE, so a second use or an expired invite gets null. Run it in the transaction that adds the member. */
export async function claimInvite(db: Writer, token: string): Promise<{ workspaceId: string; email: string; role: Role } | null> {
  const [row] = await db
    .update(invites)
    .set({ usedAt: sql`now()` })
    .where(and(eq(invites.tokenHash, hashToken(token)), isNull(invites.usedAt), gt(invites.expiresAt, sql`now()`)))
    .returning({ workspaceId: invites.workspaceId, email: invites.email, role: invites.role });
  return row ?? null;
}

/** The member of the workspace with this sign-in email who may approve, or null. */
export async function findApprover(db: AnyDb, workspaceId: string, email: string): Promise<{ id: string; email: string } | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.email, email.trim().toLowerCase()), inArray(workspaceMembers.role, [...CAN_APPROVE])));
  return row ?? null;
}
