export type Role = "owner" | "operator" | "approver" | "requester";
export type Member = { userId: string; email: string; role: Role; createdAt: string };

/** Roles an owner can give. The owner row is never created or changed from the console. */
export const memberRoles = ["operator", "approver", "requester"] as const;
export type MemberRole = (typeof memberRoles)[number];

const ORDER: Role[] = ["owner", "operator", "approver", "requester"];

/** Members in the page's group order. A group with nobody in it is left out. */
export function groupMembers(list: Member[]): { role: Role; members: Member[] }[] {
  return ORDER.map((role) => ({
    role,
    members: list.filter((x) => x.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.email.localeCompare(b.email)),
  })).filter((g) => g.members.length > 0);
}

// These mirror what the API enforces (owner-only routes, immutable owner row); the API stays the authority.
export const canInvite = (actor: Role) => actor === "owner";
export const canChangeRole = (actor: Role, member: Member) => actor === "owner" && member.role !== "owner";
export const canRemove = canChangeRole;
