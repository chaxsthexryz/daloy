import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectPanel } from "../ConnectPanel";
import { OutlookConnection, type Connection } from "../Connections";
import { LanguageContext } from "../Language";

const render = (element: ReactElement, language: "en" | "tl" = "en") => renderToStaticMarkup(createElement(LanguageContext.Provider, { value: { language, setLanguage: () => undefined } }, element));
const onChange = async () => undefined;
const conn: Connection = { provider: "outlook", status: "active", account: "ana@contoso.example", destination: { mailbox: "ana@contoso.example" }, lastError: null, lastTestedAt: null };

// Decision 0058: one Connect panel for every app on the shared OAuth core.
describe("ConnectPanel", () => {
  it("offers Connect with the outcome from the address, and keeps the paste form under Advanced", () => {
    const html = render(createElement(ConnectPanel, { slug: "trello", name: "Trello", configured: true, conn: null, label: "Account", outcome: "missing_scope", onChange, form: createElement("form", null, "PASTE FORM") }));
    expect(html).toContain("Connect Trello");
    expect(html).toContain("Some of the permissions kymavo asked for were not allowed");
    expect(html).toMatch(/<details><summary>Advanced: use a key or token instead<\/summary><form>PASTE FORM<\/form><\/details>/);
    expect(render(createElement(ConnectPanel, { slug: "trello", name: "Trello", configured: true, conn: null, label: "Account", onChange }), "tl")).toContain("Ikonekta ang Trello");
  });

  it("shows only today's form when the installation has no client for the app", () => {
    const html = render(createElement(ConnectPanel, { slug: "trello", name: "Trello", configured: false, conn: null, label: "Account", outcome: "connected", onChange, form: createElement("form", null, "PASTE FORM") }));
    expect(html).toContain("PASTE FORM");
    expect(html).not.toContain("Connect Trello");
    expect(html).not.toContain("details");
    expect(html).not.toContain("is connected");
  });

  it("keeps the Outlook card's words, outcome texts and test button", () => {
    const html = render(createElement(OutlookConnection, { conn, setup: { configured: true, adminConsentUrl: "https://login.example/adminconsent" }, outcome: "admin_required", onChange }));
    expect(html).toContain("Reconnect Outlook");
    expect(html).toContain("Mailbox <strong>ana@contoso.example</strong>");
    expect(html).toContain("only lets an administrator approve new apps");
    expect(html).toContain("this approval link");
    expect(html).toContain("Send a test email to ana@contoso.example");
    expect(html).not.toContain("Advanced");
    expect(render(createElement(OutlookConnection, { conn: null, setup: { configured: false }, onChange }))).toContain("Outlook is not set up on this installation.");
  });
});
