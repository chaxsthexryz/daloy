import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SlackConnection, type Connection } from "../Connections";
import { LanguageContext } from "../Language";

const render = (element: ReactElement, language: "en" | "tl" = "en") => renderToStaticMarkup(createElement(LanguageContext.Provider, { value: { language, setLanguage: () => undefined } }, element));
const onChange = async () => undefined;
const conn: Connection = { provider: "slack", status: "active", account: "Acme Dental", destination: { channelId: "C0REQ", channelName: "office-requests" }, lastError: null, lastTestedAt: null };

// Decision 0061: the Slack card on the shared OAuth core.
describe("Slack card", () => {
  it("offers Connect Slack first and keeps the pasted token under Advanced when the installation has a Slack app", () => {
    const html = render(createElement(SlackConnection, { conn: null, configured: true, outcome: "missing_scope", onChange }));
    expect(html).toContain("Connect Slack");
    expect(html).toContain("Some of the permissions kymavo asked for were not allowed");
    expect(html).toContain("(chat:write)");
    expect(html).toMatch(/<details><summary>Advanced: use your own Slack app token<\/summary><form>/);
    expect(html).toContain("Bot token");
    expect(html).toContain("Save token");
    expect(render(createElement(SlackConnection, { conn: null, configured: true, onChange }), "tl")).toContain("Ikonekta ang Slack");
    expect(render(createElement(SlackConnection, { conn: null, configured: true, onChange }), "tl")).toContain("gamitin ang token ng sarili mong Slack app");
  });

  it("keeps the channel picker and test message for a connected workspace", () => {
    const html = render(createElement(SlackConnection, { conn, configured: true, onChange }));
    expect(html).toContain("Reconnect Slack");
    expect(html).toContain("Workspace <strong>Acme Dental</strong>");
    expect(html).toContain("Notes go to <strong>#office-requests</strong>");
    expect(html).toContain("Change channel");
    expect(html).toContain("Send a test message");
    expect(html).toContain("Disconnect");
  });

  it("is today's token form, with no Advanced section, when the installation has no Slack app", () => {
    const html = render(createElement(SlackConnection, { conn: null, configured: false, outcome: "connected", onChange }));
    expect(html).toContain("Bot token");
    expect(html).toContain("Connect Slack");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("is connected");
    expect(html).not.toContain("(chat:write)");
    const connected = render(createElement(SlackConnection, { conn, configured: false, onChange }));
    expect(connected).toContain("Replace token");
    expect(connected).toContain("Change channel");
  });
});
