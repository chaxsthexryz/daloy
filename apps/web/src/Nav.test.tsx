import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Usage } from "./api";
import { AiMeter, Shell } from "./Nav";
import type { User } from "./Team";

const user: User = { id: "staff", workspaceId: "workspace", email: "staff@example.test", role: "owner" };
const render = (hash: string, role: User["role"] = "owner") => renderToStaticMarkup(
  <Shell user={{ ...user, role }} hash={hash} onSignOut={() => undefined}><main>Page</main></Shell>,
);

describe("staff navigation", () => {
  it.each([
    ["#/", "#/"], ["#/new", "#/new"], ["#/ai", "#/ai"],
    ["#/activity", "#/activity"], ["#/runs/run-id", "#/activity"], ["#/runs/run-id/ask", "#/activity"],
    ["#/w/workflow-id", "#/"], ["#/w/workflow-id/versions", "#/"], ["#/w/workflow-id/runs", "#/"],
    ["#/a/workflow-id", "#/"], ["#/bookings", "#/bookings"],
    ["#/settings", "#/settings"], ["#/account", "#/account"],
    ["#/settings/ai", "#/advanced"], ["#/secrets", "#/advanced"], ["#/tokens", "#/advanced"], ["#/resources", "#/advanced"],
    ["#/settings/business", "#/settings/business"], ["#/settings/business/outlook-connected", "#/apps"],
    ["#/verify-sender/token", "#/apps"], ["#/team", "#/team"],
  ])("marks the parent of %s", (hash, target) => {
    const selected = [...render(hash).matchAll(/<a [^>]*?href="([^"]*)"[^>]*aria-current="page"/g)].map((match) => match[1]);
    expect(selected.length).toBeGreaterThan(0);
    expect(new Set(selected)).toEqual(new Set([target]));
  });

  it("keeps the same groups on child pages", () => {
    const html = render("#/secrets");
    expect(html).toContain(">Work</span>");
    expect(html).toContain(">Build</span>");
    expect(html).toContain(">Workspace</span>");
    expect(html).toContain('href="#/bookings"');
    expect(html).toContain('aria-controls="main-menu"');
  });

  it("keeps owner actions out of the operator menu", () => {
    const html = render("#/activity", "operator");
    for (const href of ["#/new", "#/ai", "#/team", "#/apps", "#/settings/business", "#/advanced"]) {
      expect(html).not.toContain(`href="${href}"`);
    }
    for (const href of ["#/", "#/activity", "#/bookings", "#/settings", "#/account"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("calls the #/new entry Library on the rail and the phone menu", () => {
    const html = render("#/new");
    expect(html).toContain(">Library</span>");
    expect(html).not.toContain(">New automation</span>");
  });

  it("shows the AI meter only to owners, and only once usage has loaded", () => {
    expect(render("#/")).not.toContain("ai-meter");
    expect(render("#/", "operator")).not.toContain("ai-meter");
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
