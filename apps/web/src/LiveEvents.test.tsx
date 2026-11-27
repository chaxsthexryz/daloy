import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageContext } from "./Language";
import { NotificationBell } from "./LiveEvents";
import type { Notice } from "./lib/live-events";

const notice = (unread: boolean): Notice => ({ key: String(Math.random()), kind: "run_failed", id: "11111111-1111-4111-8111-111111111111", title: "Receipt archive", at: new Date().toISOString(), unread });
const html = (items: Notice[], language: "en" | "tl" = "en") =>
  renderToStaticMarkup(
    <LanguageContext.Provider value={{ language, setLanguage: () => undefined }}>
      <NotificationBell live={{ items, markAllRead: () => undefined, markRead: () => undefined }} />
    </LanguageContext.Provider>,
  );

describe("NotificationBell", () => {
  it("shows no count when everything is read, and the unread count in the label otherwise", () => {
    expect(html([notice(false)])).not.toContain("notif-dot");
    expect(html([notice(false)])).toContain('aria-label="Notifications"');
    const unread = html([notice(true), notice(true), notice(false)]);
    expect(unread).toContain('aria-label="Notifications, 2 unread"');
    expect(unread).toContain(">2</span>");
  });

  it("is labelled in Taglish and starts closed", () => {
    const out = html([notice(true)], "tl");
    expect(out).toContain("Mga notification, 1 hindi pa nababasa");
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain("class=\"notif-panel\"");
  });

  it("moves its panel in only when the person has not asked for reduced motion", () => {
    const css = readFileSync(resolve(__dirname, "live-events.css"), "utf8");
    const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(motion).toContain("animation: notif-in");
    expect(css.slice(0, css.indexOf("@media (prefers-reduced-motion"))).not.toMatch(/animation|transition/);
  });
});
