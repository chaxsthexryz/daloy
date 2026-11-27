import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminShell, AuditTab, OverviewTab, type Overview } from "./Admin";
import { ADMIN_TABS } from "./lib/admin-route";
import { Shell } from "./Nav";

const shell = (tab: Parameters<typeof AdminShell>[0]["tab"], tabs?: Parameters<typeof AdminShell>[0]["tabs"]) =>
  renderToStaticMarkup(<AdminShell tab={tab} email="boss@daloy.test" tabs={tabs} badges={{ feedback: 3 }} onSignOut={() => undefined}><p>Body</p></AdminShell>);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");

const overview: Overview = {
  users: { total: 12, new7: 1, new30: 4 },
  workspaces: { total: 9, new7: 1, new30: 3, rows: [] },
  runs30: { succeeded: 40, failed: 2 },
  attention: { runsFailed: 2, runsNeedsReview: 1, deliveriesFailed: 0, deliveriesNeedsReview: 0 },
  usage: { ai: 15, sms: 3 },
  actions: [],
};

describe("admin console shell", () => {
  it("links the six tabs and marks the open one", () => {
    const html = shell("runs");
    expect(hrefs(html)).toEqual(expect.arrayContaining(ADMIN_TABS.map((t) => `#/${t}`)));
    expect([...html.matchAll(/href="([^"]*)" aria-current="page"/g)].map((m) => m[1])).toEqual(["#/runs"]);
    expect(html).toContain("<h1>Runs</h1>");
    expect(html).toContain("Signed in as boss@daloy.test");
    expect(html).toContain('aria-label="3 new"');
  });

  it("has no workspace sidebar, only a way back to the console at /", () => {
    const html = shell("overview");
    expect(hrefs(html).filter((h) => !h.startsWith("#/") && h !== "/" && h !== "/logo.svg")).toEqual([]);
    for (const workspaceRoute of ["#/inbox", "#/automations", "#/bookings", "#/business", "#/settings"]) expect(html).not.toContain(`href="${workspaceRoute}"`);
  });

  it("leaves a hidden tab out of the navigation", () => {
    expect(shell("overview", ADMIN_TABS.filter((t) => t !== "feedback"))).not.toContain("#/feedback");
  });

  it("makes the totals open the tab behind them", () => {
    const html = renderToStaticMarkup(<OverviewTab data={overview} newFeedback={2} />);
    expect(html).toContain('href="#/runs?state=failed"');
    expect(html).toContain('href="#/runs?state=needs_review"');
    expect(html).toContain('href="#/workspaces"');
    expect(html).toContain('href="#/audit"');
    expect(html).toContain('href="#/feedback?status=new"');
  });

  it("writes each kind of audit entry as a sentence without ids", () => {
    const html = renderToStaticMarkup(<AuditTab actions={[
      { id: "1", adminEmail: "boss@daloy.test", action: "shared_mail", workspaceEmail: "owner@test.local", before: { sharedMailDailyLimit: null }, after: { sharedMailDailyLimit: 25 }, createdAt: "2026-11-28T00:00:00Z" },
      { id: "2", adminEmail: "boss@daloy.test", action: "ai", workspaceEmail: null, before: {}, after: { preset: "gemini", model: "gemini-flash" }, createdAt: "2026-11-28T00:00:00Z" },
      { id: "3", adminEmail: "boss@daloy.test", action: "feedback_close", workspaceEmail: "owner@test.local", before: { feedbackId: "f1", status: "new" }, after: { feedbackId: "f1", status: "closed" }, createdAt: "2026-11-28T00:00:00Z" },
    ]} />);
    expect(html).toContain("boss@daloy.test changed shared mail for owner@test.local, none → 25");
    expect(html).toContain("boss@daloy.test changed the shared AI model, none → gemini, gemini-flash");
    expect(html).toContain("closed feedback from owner@test.local, new → closed");
    expect(html).not.toContain("f1");
  });
});

describe("workspace console", () => {
  it("does not link to the admin console, even for a platform admin", () => {
    const html = renderToStaticMarkup(<Shell user={{ id: "u", workspaceId: "w", email: "boss@daloy.test", role: "owner", admin: true }} hash="#/settings" onSignOut={() => undefined}><main>Page</main></Shell>);
    expect(html).not.toMatch(/href="[^"]*admin/);
  });
});
