import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildSevenDayTrend, computeHealthSummary, HomePage, type HomePayload } from "./Home";
import { LanguageContext } from "./Language";
import type { Language } from "./lib/locale";
import type { User } from "./Team";

const ownerUser: User = {
  id: "u-owner",
  workspaceId: "w-1",
  email: "maria@resort.ph",
  role: "owner",
  ask: true,
};

const approverUser: User = {
  id: "u-approver",
  workspaceId: "w-1",
  email: "ana@resort.ph",
  role: "approver",
};

const samplePayload: HomePayload = {
  role: "owner",
  needsYou: { total: 4, conversations: 1, receipts: 2, approvals: 1, runs: 0 },
  problems: [
    {
      id: "prob-1",
      kind: "connection",
      title: "Google Drive",
      detail: "Token expired for Receipt archive",
      href: "#/apps",
      createdAt: "2026-11-27T08:00:00.000Z",
    },
  ],
  running: [
    {
      id: "wf-1",
      name: "Resort inquiry reply",
      runsToday: 18,
      lastRunAt: "2026-11-27T09:10:00.000Z",
      lastState: "succeeded",
    },
    {
      id: "wf-2",
      name: "GCash receipt check",
      runsToday: 0,
      lastRunAt: null,
      lastState: null,
    },
  ],
  recentRuns: [
    {
      id: "run-1",
      workflowId: "wf-1",
      workflowName: "Resort inquiry reply",
      version: 4,
      state: "succeeded",
      test: false,
      live: true,
      reference: "REQ-2026-0412",
      createdAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
      needsReview: false,
      deliveryFailed: false,
      superseded: false,
      error: null,
      triggerPayload: {},
    },
  ],
};

function renderHome(user: User, initialData: HomePayload, language: Language = "en") {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language, setLanguage: () => undefined }}>
      <HomePage
        user={user}
        initialData={initialData}
        initialConnections={[
          { provider: "gmail", status: "active" },
          { provider: "google_drive", status: "error" },
        ]}
      />
    </LanguageContext.Provider>,
  );
}

describe("HomePage Console Blocks", () => {
  it("renders 4 KPI cards, 7-day SVG chart, Health Donut, Connected apps, and Recent activity", () => {
    const html = renderHome(ownerUser, samplePayload);

    expect(html).toContain("<h1>Today</h1>");
    expect(html).toContain('href="#/new"');
    expect(html).toContain(">New automation</a>");
    expect(html).toContain('href="#/ai"');
    expect(html).toContain(">Build with AI</a>");

    // Four stretched-link KPI cards in .hm-kpi-grid
    expect(html).toContain('class="hm-kpi-grid"');
    const footLinks = [...html.matchAll(/<a[^>]*class="hm-kpi-foot"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(footLinks).toEqual(["#/automations", "#/automations", "#/inbox", "#/automations"]);

    // Real counts derived strictly from HomePayload
    expect(html).toContain("Live automations");
    expect(html).toContain("Runs today");
    expect(html).toContain("Needs you");
    expect(html).toContain("4 waiting on staff");
    expect(html).toContain("Success, 7 days");
    expect(html).toContain("18 ran today");
    expect(html).toContain("REQ-2026-0412");
    expect(html).toContain("Resort inquiry reply");
    expect(html).toContain("Google Drive");
    expect(html).toContain("Token expired for Receipt archive");
    expect(html).toContain('class="hm-area-svg"');
    expect(html).toContain('class="hm-donut-wrap"');
    expect(html).toContain("Connected apps");
    expect(html).toContain("Gmail");
    expect(html).toContain("Connected");
    expect(html).toContain('href="#/a/wf-1"');
  });

  it("keeps Needs you, Problems, and What ran as h2 headings and renders healthy zero states", () => {
    const emptyPayload: HomePayload = {
      role: "owner",
      needsYou: { total: 0, conversations: 0, receipts: 0, approvals: 0, runs: 0 },
      problems: [],
      running: [],
      recentRuns: [],
    };
    const html = renderHome(ownerUser, emptyPayload);

    expect(html).toMatch(/<h2[^>]*>Needs you<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Problems<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>What ran<\/h2>/);
    expect(html).toContain("All caught up");
    expect(html).toContain("No problems right now");
    expect(html).toContain("100%");
    expect(html).toContain("No automations are turned on yet.");
    expect(html).toContain("Nothing has happened yet.");
  });

  it("computes 7-day trend buckets and health summary from real runs", () => {
    const now = new Date(2026, 10, 28, 12, 0, 0).getTime();
    const runs = [
      { ...samplePayload.recentRuns[0]!, id: "r1", createdAt: new Date(2026, 10, 28, 9, 0, 0).toISOString(), state: "succeeded" },
      { ...samplePayload.recentRuns[0]!, id: "r2", createdAt: new Date(2026, 10, 27, 10, 0, 0).toISOString(), state: "failed" },
      { ...samplePayload.recentRuns[0]!, id: "r3", createdAt: new Date(2026, 10, 26, 11, 0, 0).toISOString(), state: "waiting", needsReview: true },
    ];
    const trend = buildSevenDayTrend(runs, now, "en");
    expect(trend).toHaveLength(7);
    expect(trend[6]!.total).toBe(1);
    expect(trend[6]!.ok).toBe(1);
    expect(trend[5]!.failed).toBe(1);
    expect(trend[4]!.waiting).toBe(1);

    const summary = computeHealthSummary(runs, 0);
    expect(summary).toEqual({ total: 3, ok: 1, waiting: 1, failed: 1, pct: 33 });
  });

  it("renders non-staff fallback inside Console Block card markup", () => {
    const html = renderHome(approverUser, {
      role: "approver",
      needsYou: { total: 2, conversations: 0, receipts: 0, approvals: 2, runs: 0 },
      problems: [],
      running: [],
      recentRuns: [],
    });
    expect(html).toContain("Your account has 2 pending approvals assigned to you.");
    expect(html).toContain('href="#/settings"');
    expect(html).not.toContain('class="hm-kpi-grid"');
  });

  it("defines stretched-link hit area, focus-visible ring on KPI cards, 13px floor, and reduced-motion rules in home.css", () => {
    const cssPath = fileURLToPath(new URL("./home.css", import.meta.url));
    const css = readFileSync(cssPath, "utf8");

    expect(css).toMatch(/\.hm-kpi-card\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.hm-kpi-foot::after\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/);
    expect(css).toMatch(/\.hm-kpi-card:has\(\.hm-kpi-foot:focus-visible\)\s*\{[^}]*outline:\s*2px\s+solid/);
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).not.toContain("--ease-snappy");

    // Ensure no font-size declarations below 13px exist in home.css
    const smallPx = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)]
      .map((m) => Number(m[1]))
      .filter((px) => px < 13);
    expect(smallPx).toEqual([]);
  });
});
