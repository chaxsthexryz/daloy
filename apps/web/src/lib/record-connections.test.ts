import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordConnection, type Connection } from "../Connections";
import { LanguageContext } from "../Language";

const render = (element: ReactElement, language: "en" | "tl" = "en") => renderToStaticMarkup(createElement(LanguageContext.Provider, { value: { language, setLanguage: () => undefined } }, element));
const onChange = async () => undefined;
const apps = ["airtable", "notion", "trello"] as const;
const picker = { airtable: "Pick a table", notion: "Pick a database", trello: "Pick a list" };

// The real picker reads and writes are covered with the fake providers in the browser suite.
describe("record app connection panels", () => {
  for (const app of apps) {
    it(`${app} offers managed consent and keeps credentials under Advanced`, () => {
      const html = render(createElement(RecordConnection, { app, configured: true, conn: null, outcome: "declined", onChange }));
      expect(html).toContain("permission request was declined");
      expect(html).toMatch(/<details><summary>Advanced: use a key or token instead<\/summary>/);
      expect(html).toContain('type="password"');
      expect(html).not.toContain(picker[app]);
    });
    it(`${app} shows the picker only for an OAuth connection`, () => {
      const conn: Connection = { provider: app, authMethod: "oauth", account: "Test account", status: "active", destination: null, lastError: null, lastTestedAt: null };
      const html = render(createElement(RecordConnection, { app, configured: true, conn, onChange }));
      expect(html).toContain(picker[app]);
      expect(html).not.toContain('type="submit" class="primary" disabled=""');
      const pasted = render(createElement(RecordConnection, { app, configured: true, conn: { ...conn, authMethod: "token" }, onChange }));
      expect(pasted).not.toContain(picker[app]);
    });
    it(`${app} leaves the manual setup available without an OAuth client`, () => {
      const html = render(createElement(RecordConnection, { app, configured: false, conn: null, onChange }));
      expect(html).not.toContain("<details>");
      expect(html).toContain('type="password"');
    });
  }
  it("explains Notion page sharing in English and Tagalog", () => {
    const el = createElement(RecordConnection, { app: "notion", configured: true, conn: null, onChange });
    expect(render(el)).toContain("select the pages that contain your database");
    expect(render(el, "tl")).toContain("piliin ang mga page na naglalaman ng database mo");
  });
});
