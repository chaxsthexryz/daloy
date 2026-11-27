import { describe, expect, it } from "vitest";
import { canChangeRole, canInvite, canRemove, groupMembers, inviteLinkForOrigin, memberRoles, type Member } from "./team";

const m = (userId: string, role: Member["role"], createdAt = "2026-03-01T00:00:00Z"): Member => ({ userId, email: `${userId}@x.ph`, displayName: null, role, createdAt });

describe("groupMembers", () => {
  it("orders groups owner, operator, approver, requester and drops empty ones", () => {
    const groups = groupMembers([m("p", "requester"), m("o", "owner"), m("a", "approver")]);
    expect(groups.map((g) => g.role)).toEqual(["owner", "approver", "requester"]);
  });
  it("sorts a group by join date, then email", () => {
    const group = groupMembers([m("late", "operator", "2026-04-02T00:00:00Z"), m("b", "operator", "2026-03-10T00:00:00Z"), m("a", "operator", "2026-03-10T00:00:00Z")]);
    expect(group[0]!.members.map((x) => x.userId)).toEqual(["a", "b", "late"]);
  });
  it("returns nothing for an empty list", () => {
    expect(groupMembers([])).toEqual([]);
  });
});

describe("role restrictions", () => {
  const roles = ["owner", "operator", "approver", "requester"] as const;
  it("only an owner may invite", () => {
    expect(roles.map((r) => canInvite(r))).toEqual([true, false, false, false]);
  });
  it("only an owner may change a role or remove a member", () => {
    for (const actor of roles) {
      const allowed = actor === "owner";
      expect(canChangeRole(actor, m("x", "operator"))).toBe(allowed);
      expect(canRemove(actor, m("x", "requester"))).toBe(allowed);
    }
  });
  it("nobody may change or remove the owner row", () => {
    expect(canChangeRole("owner", m("o", "owner"))).toBe(false);
    expect(canRemove("owner", m("o", "owner"))).toBe(false);
  });
  it("offers the three member roles and never owner", () => {
    expect(memberRoles).toEqual(["operator", "approver", "requester"]);
  });

  it("builds invite links using the active workspace origin", () => {
    expect(inviteLinkForOrigin("abc123", "http://localhost:3000")).toBe("http://localhost:3000/#/invite/abc123");
    expect(inviteLinkForOrigin("https://tunnel.trycloudflare.com/#/invite/abc123", "http://localhost:3000/")).toBe("http://localhost:3000/#/invite/abc123");
    expect(inviteLinkForOrigin("https://other.example/#/invite/xyz-99", "https://app.daloy.ph")).toBe("https://app.daloy.ph/#/invite/xyz-99");
  });
});
