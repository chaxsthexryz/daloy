import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GmailCard, type Settings } from "../BusinessSetup";
import { LanguageContext } from "../Language";

const render = (element: ReactElement, language: "en" | "tl" = "en") => renderToStaticMarkup(createElement(LanguageContext.Provider, { value: { language, setLanguage: () => undefined } }, element));
const onChange = async () => undefined;
const base: Settings = { profile: null, sender: null, installationFrom: "daloy@localhost", installationAllowed: true, installationLocal: true, signInEmail: "owner@test.local" };
const google = { address: "ana@gmail.com", status: "active", lastError: null, verifiedAt: "2026-11-19T00:00:00Z", lastTestedAt: null, authMethod: "oauth" } as const;

// Decision 0063: Connect Gmail with Google first, the app password form under Advanced, and the app password card alone without a Google client.
describe("Gmail card", () => {
  it("keeps the app password card as it was when the installation has no Google client", () => {
    const html = render(createElement(GmailCard, { data: base, google: false, onChange }));
    expect(html).toContain("Gmail address");
    expect(html).not.toContain("Connect Gmail with Google");
    expect(html).not.toContain("<details>");
  });

  it("offers Connect Gmail with Google first, says reading mail still uses an app password, and keeps the form under Advanced", () => {
    const html = render(createElement(GmailCard, { data: base, google: true, outcome: "missing_scope", onChange }));
    expect(html).toContain(">Connect Gmail with Google</button>");
    expect(html).toContain("Daloy cannot read your mail");
    expect(html).toContain("still connect their inbox with an app password");
    expect(html).toContain("Some of the permissions Daloy asked for were not allowed");
    expect(html).toMatch(/<details><summary>Advanced: use a key or token instead<\/summary>.*Use an app password instead.*App password.*<\/details>/s);
    expect(render(createElement(GmailCard, { data: base, google: true, onChange }), "tl")).toContain("Ikonekta ang Gmail gamit ang Google");
  });

  it("shows a Google sign-in with its test email, Reconnect and Disconnect, and says Reconnect Gmail once it fails", () => {
    const html = render(createElement(GmailCard, { data: { ...base, sender: google }, google: true, onChange }));
    expect(html).toContain("Gmail: <strong>ana@gmail.com</strong>");
    expect(html).toContain("Send a test email to me");
    expect(html).toContain("Reconnect Gmail");
    expect(html).toContain(">Disconnect</button>");
    const failed = render(createElement(GmailCard, { data: { ...base, sender: { ...google, status: "failed", lastError: "Gmail no longer accepts Daloy's access. Reconnect Gmail in Apps." } }, google: true, onChange }));
    expect(failed).toContain("Google no longer accepts Daloy&#x27;s access");
    expect(failed).toContain("Reconnect Gmail to send again. Nothing is sent from another address");
  });
});
