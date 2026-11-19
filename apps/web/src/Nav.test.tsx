import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Shell } from "./Nav";
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
    const selected = [...render(hash).matchAll(/<a href="([^"]*)"[^>]*aria-current="page"/g)].map((match) => match[1]);
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
});
