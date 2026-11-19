import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Connection } from "../Connections";
import { GoogleDriveCard, GoogleSheetsCard } from "../GoogleConnect";
import { LanguageContext } from "../Language";

const render = (element: ReactElement, language: "en" | "tl" = "en") => renderToStaticMarkup(createElement(LanguageContext.Provider, { value: { language, setLanguage: () => undefined } }, element));
const onChange = async () => undefined;
const oauthSheets: Connection = { provider: "google_sheets", status: "active", authMethod: "oauth", account: "ana@clinic.example", destination: null, lastError: null, lastTestedAt: null };

// Decision 0060: Connect with Google first, the service account form under Advanced, today's form alone without a client.
describe("Google Sheets and Drive cards", () => {
  it("keep today's service account form as the whole card when the installation has no Google client", () => {
    const html = render(createElement(GoogleSheetsCard, { conn: null, configured: false, onChange }));
    expect(html).toContain("Service account key file (JSON)");
    expect(html).toContain("Connect Google Sheets");
    expect(html).not.toContain("Connect with Google");
    expect(html).not.toContain("<details>");
  });

  it("offer Connect with Google first, with one heading and the service account form under Advanced", () => {
    const html = render(createElement(GoogleSheetsCard, { conn: null, configured: true, outcome: "missing_scope", onChange }));
    expect(html).toContain(">Connect with Google</button>");
    expect(html).toContain("use only the files you pick or that Daloy creates");
    expect(html).toContain("Some of the permissions Daloy asked for were not allowed");
    expect(html.match(/<h3/g)).toHaveLength(1);
    expect(html).toMatch(/<details><summary>Advanced: use a key or token instead<\/summary>.*Service account key file \(JSON\).*<\/details>/s);
    expect(render(createElement(GoogleSheetsCard, { conn: null, configured: true, onChange }), "tl")).toContain("Ikonekta gamit ang Google");
  });

  it("after a Google sign-in, offer to create or pick the sheet, and reconnect", () => {
    const html = render(createElement(GoogleSheetsCard, { conn: oauthSheets, configured: true, onChange }));
    expect(html).toContain("Account <strong>ana@clinic.example</strong>");
    expect(html).toContain("Create a sheet for me");
    expect(html).toContain("Pick an existing sheet");
    expect(html).toContain("Reconnect Google Sheets");
    expect(html).not.toContain("Add a test row");
    const chosen = render(createElement(GoogleSheetsCard, { conn: { ...oauthSheets, destination: { spreadsheetId: "abc1234567", tab: "Sheet1", title: "Daloy requests" } }, configured: true, onChange }), "tl");
    expect(chosen).toContain("Gumawa ng sheet para sa akin");
    expect(chosen).toContain("Magdagdag ng test row");
    expect(chosen).toContain("Daloy requests");
  });

  it("show the service account connection with its label when that is what is connected", () => {
    const html = render(createElement(GoogleSheetsCard, { conn: { ...oauthSheets, authMethod: "service_account", account: "sa@x.iam.gserviceaccount.com", destination: { spreadsheetId: "abc1234567", tab: "Requests", title: "Shared" } }, configured: true, onChange }));
    expect(html).toContain("Service account <strong>sa@x.iam.gserviceaccount.com</strong>");
    expect(html).not.toContain("Create a sheet for me");
    expect(html).toContain("leave empty to keep the current key");
  });

  it("offer Drive a Daloy uploads folder or a picked folder", () => {
    const html = render(createElement(GoogleDriveCard, { conn: { ...oauthSheets, provider: "google_drive" }, configured: true, onChange }));
    expect(html).toContain("Create a Daloy uploads folder");
    expect(html).toContain("Pick a folder");
    expect(html).toContain("It can be in My Drive");
    expect(render(createElement(GoogleDriveCard, { conn: null, configured: false, onChange }))).toContain("Folder link");
  });
});
