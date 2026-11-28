import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Usage } from "./api";
import { AiMeter, initialTreeState, section, Shell, syncTreeForHash, toggleTreeGroup } from "./Nav";
import type { User } from "./Team";

const user: User = { id: "staff", workspaceId: "workspace", email: "staff@example.test", role: "owner" };
const render = (hash: string, role: User["role"] = "owner") => renderToStaticMarkup(
  <Shell user={{ ...user, role }} hash={hash} onSignOut={() => undefined}><main>Page</main></Shell>,
);

describe("staff navigation", () => {
  it.each([
    ["#/", "#/"],
    ["#/inbox", "#/inbox"], ["#/conversations", "#/inbox"], ["#/receipts", "#/inbox"],
    ["#/bookings", "#/bookings"], ["#/bookings?tab=rooms", "#/bookings"], ["#/resources", "#/bookings"],
    ["#/automations", "#/automations"], ["#/new", "#/automations"], ["#/ai", "#/automations"],
    ["#/activity", "#/automations"], ["#/activity/ask", "#/automations"],
    ["#/runs/run-id", "#/automations"], ["#/runs/run-id/ask", "#/automations"],
    ["#/w/workflow-id", "#/automations"], ["#/w/workflow-id/versions", "#/automations"], ["#/w/workflow-id/runs", "#/automations"],
    ["#/a/workflow-id", "#/automations"],
    ["#/business", "#/business"], ["#/business?tab=knowledge", "#/business"], ["#/business?tab=apps", "#/apps"], ["#/business?tab=team", "#/business"],
    ["#/knowledge", "#/business"], ["#/team", "#/business"], ["#/apps", "#/apps"], ["#/apps/gmail-connected", "#/apps"],
    ["#/settings/business", "#/business"], ["#/settings/business/outlook-connected", "#/apps"], ["#/verify-sender/token", "#/business"],
    ["#/settings", "#/settings"], ["#/settings/ai", "#/settings"], ["#/secrets", "#/settings"], ["#/tokens", "#/settings"], ["#/advanced", "#/settings"],
    ["#/account", "#/settings"], ["#/feedback", "#/feedback"],
  ])("marks the parent of %s", (hash, target) => {
    const selected = [...render(hash).matchAll(/<a [^>]*?href="([^"]*)"[^>]*aria-current="page"/g)].map((match) => match[1]);
    expect(selected.length).toBeGreaterThan(0);
    expect(new Set(selected)).toEqual(new Set([target]));
  });

  it("matches sub-routes and query/trailing-slash variants via section()", () => {
    expect(section("#/apps")).toBe("Apps");
    expect(section("#/apps/")).toBe("Apps");
    expect(section("#/apps/gmail-connected?ok=1")).toBe("Apps");
    expect(section("#/settings/business")).toBe("Business");
    expect(section("#/settings/business/")).toBe("Business");
    expect(section("#/activity/ask")).toBe("Automations");
    expect(section("#/activity/ask?ref=REQ-1")).toBe("Automations");
    expect(section("#/runs/1234-5678")).toBe("Automations");
    expect(section("#/runs/1234-5678/ask")).toBe("Automations");
    expect(section("#/account")).toBe("Settings");
    expect(section("#/account/")).toBe("Settings");
  });

  it("renders six destinations for owners without repeating Work, Build and Workspace labels", () => {
    const html = render("#/secrets");
    for (const href of ["#/", "#/inbox", "#/bookings", "#/automations", "#/apps", "#/business", "#/settings", "#/feedback"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).not.toContain('class="primary top-new"');
    expect(html).toContain('aria-controls="main-menu"');
  });

  it("keeps owner actions out of the operator menu", () => {
    const html = render("#/inbox", "operator");
    for (const href of ["#/automations", "#/business", "#/new", "#/ai", "#/team", "#/apps", "#/settings/business", "#/advanced"]) {
      expect(html).not.toContain(`href="${href}"`);
    }
    for (const href of ["#/", "#/inbox", "#/bookings", "#/settings", "#/feedback"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("limits approvers and requesters to Home and Settings", () => {
    for (const role of ["approver", "requester"] as const) {
      const html = render("#/", role);
      expect(html).toContain('href="#/"');
      expect(html).toContain('href="#/settings"');
      expect(html).not.toContain('href="#/inbox"');
      expect(html).not.toContain('href="#/bookings"');
      expect(html).not.toContain('href="#/automations"');
      expect(html).not.toContain('href="#/business"');
    }
  });

  it("shows the AI meter only to owners, and only once usage has loaded", () => {
    expect(render("#/")).not.toContain("ai-meter");
    expect(render("#/", "operator")).not.toContain("ai-meter");
  });

  it("renders a permanent 228px non-collapsible sidebar with hover pill and no Ctrl K button", () => {
    const html = render("#/");
    expect(html).not.toContain("data-expanded");
    expect(html).not.toContain("rail-collapse-btn");
    expect(html).not.toContain('aria-label="Collapse sidebar"');
    expect(html).toContain("rail-hover-pill");
    expect(html).not.toContain("rail-quick-jump");
    expect(html).not.toContain("Ctrl K");
    expect(html).toContain(">kymavo</span>");
  });

  it("renders the Help and support button in the sidebar footer for owners and operators", () => {
    const ownerHtml = render("#/", "owner");
    expect(ownerHtml).toContain("rail-help-btn");
    expect(ownerHtml).toContain('aria-label="Help and support"');
    const opHtml = render("#/activity", "operator");
    expect(opHtml).toContain("rail-help-btn");
    expect(opHtml).not.toContain('href="#/apps"');
    expect(opHtml).not.toContain('href="#/onboarding"');
  });
});

const usage = (limit: number | null): Usage => ({
  plan: "pilot", label: "Pilot", limits: {},
  ai: { used: 120, limit, resetsOn: "2026-12-17" },
  email: { used: 0, limit: 100, resetsOn: "2026-11-18" }, http: { used: 0, limit: null, resetsOn: "2026-11-18" },
  automations: { live: 1, limit: 5 }, minScheduleMinutes: 15,
});

describe("AI meter", () => {
  it("puts the text in the bar's accessible name and fills it by the share used", () => {
    const html = renderToStaticMarkup(<AiMeter usage={usage(500)} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="AI 120 of 500 this month"');
    expect(html).toContain("width:24%");
  });
  it.each([["no AI limit", usage(null)], ["no usage yet", null]])("renders nothing with %s", (_name, u) => {
    expect(renderToStaticMarkup(<AiMeter usage={u} />)).toBe("");
  });
});

describe("sidebar account block", () => {
  it("shows the name with the role, and keeps the email as the title", () => {
    const html = renderToStaticMarkup(
      <Shell user={{ ...user, displayName: "Maria Santos", role: "operator" }} hash="#/" onSignOut={() => undefined}><main>Page</main></Shell>,
    );
    expect(html).toContain('<strong title="staff@example.test">Maria Santos</strong><span class="rail-who-role">Operator</span>');
    expect(html).toContain(">M</span>");
  });
  it.each([[undefined], [null], [""]])("falls back to the email when the name is %j", (displayName) => {
    const html = renderToStaticMarkup(<Shell user={{ ...user, displayName }} hash="#/" onSignOut={() => undefined}><main>Page</main></Shell>);
    expect(html).toContain('<strong title="staff@example.test">staff@example.test</strong><span class="rail-who-role">Owner</span>');
    expect(html).toContain(">S</span>");
  });
});

describe("sidebar tree state and blocks shell", () => {
  it("opens only the active section group on initial load", () => {
    expect(initialTreeState("#/")).toEqual({ bookings: false, automations: false, business: false });
    expect(initialTreeState("#/bookings?tab=rooms")).toEqual({ bookings: true, automations: false, business: false });
    expect(initialTreeState("#/new")).toEqual({ bookings: false, automations: true, business: false });
    expect(initialTreeState("#/business?tab=team")).toEqual({ bookings: false, automations: false, business: true });
  });

  it("syncs open group on hash change and toggles individual groups", () => {
    const start = initialTreeState("#/");
    const onAutomations = syncTreeForHash(start, "#/ai");
    expect(onAutomations).toEqual({ bookings: false, automations: true, business: false });

    const closedAutomations = toggleTreeGroup(onAutomations, "automations");
    expect(closedAutomations).toEqual({ bookings: false, automations: false, business: false });

    const openedBusiness = toggleTreeGroup(closedAutomations, "business");
    expect(openedBusiness).toEqual({ bookings: false, automations: false, business: true });

    expect(syncTreeForHash(openedBusiness, "#/bookings")).toEqual({ bookings: true, automations: false, business: false });
  });

  it("renders the search trigger, Work/Workspace labels, and expandable owner sub-trees without extra primary links", () => {
    const html = render("#/business?tab=team");
    expect(html).toContain('class="rail-search"');
    expect(html).toContain("<kbd");
    expect(html).toContain("⌘K</kbd>");
    expect(html).toContain('class="rail-group-label">Work</span>');
    expect(html).toContain('class="rail-group-label">Workspace</span>');

    // Only the 8 primary links are direct children of #main-menu.
    const navMatch = html.match(/<nav[^>]*id="main-menu"[^>]*>([\s\S]*?)<\/nav>/);
    expect(navMatch).toBeTruthy();
    const primaryMatches = [...navMatch![1]!.matchAll(/class="rail-link(?: [^"]*)?"[^>]*href="([^"]*)"/g)].map((m) => m[1]);
    expect(primaryMatches).toEqual(["#/", "#/inbox", "#/bookings", "#/automations", "#/apps", "#/business", "#/settings", "#/feedback"]);

    // Business group is open with Team sub-link marked data-active="true", never aria-current="page".
    expect(html).toContain('data-group="business" data-open="true"');
    expect(html).toContain('data-group="bookings" data-open="false"');
    expect(html).toContain('data-group="automations" data-open="false"');
    expect(html).toContain('href="#/business?tab=team" data-active="true"');
    expect(html).not.toMatch(/class="rail-sublink"[^>]*aria-current="page"/);
    expect(html).toContain('aria-label="Show Bookings pages" aria-expanded="false"');
    expect(html).toContain('aria-label="Hide Business pages" aria-expanded="true"');
  });

  it("renders the rail usage card header and Manage plan button when inside the sidebar", () => {
    const html = renderToStaticMarkup(<AiMeter usage={usage(500)} className="ai-meter rail-usage" />);
    expect(html).toContain("rail-usage-head");
    expect(html).toContain("Pilot");
    expect(html).toContain("Plan");
    expect(html).toContain("Manage plan");
    expect(html).toContain('role="progressbar"');
  });
});
