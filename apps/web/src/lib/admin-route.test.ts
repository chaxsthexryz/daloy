import { describe, expect, it } from "vitest";
import { ADMIN_TABS, adminRoute, tabHref } from "./admin-route";

describe("admin console routes", () => {
  it.each([
    ["", "overview"], ["#", "overview"], ["#/", "overview"], ["#/nope", "overview"],
    ["#/workspaces", "workspaces"], ["#/workspaces/", "workspaces"], ["#/runs?state=failed", "runs"],
    ["#/ai", "ai"], ["#/feedback?status=new", "feedback"], ["#/audit", "audit"],
  ])("opens %s on the %s tab", (hash, tab) => {
    expect(adminRoute(hash).tab).toBe(tab);
  });

  it("keeps the query for the tab", () => {
    expect(adminRoute("#/runs?state=needs_review").params.get("state")).toBe("needs_review");
    expect(adminRoute("#/runs").params.get("state")).toBeNull();
  });

  it("falls back to the overview for a tab the build hides", () => {
    expect(adminRoute("#/feedback", ADMIN_TABS.filter((t) => t !== "feedback")).tab).toBe("overview");
  });

  it("builds links with an optional query", () => {
    expect(tabHref("runs")).toBe("#/runs");
    expect(tabHref("runs", { state: "failed" })).toBe("#/runs?state=failed");
  });
});
