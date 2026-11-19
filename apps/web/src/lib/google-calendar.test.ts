import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Connection } from "../Connections";
import { GoogleCalendarCard } from "../GoogleCalendar";
import { LanguageContext } from "../Language";

const render = (element: ReactElement, language: "en" | "tl" = "en") => renderToStaticMarkup(createElement(LanguageContext.Provider, { value: { language, setLanguage: () => undefined } }, element));
const onChange = async () => undefined;
const oauth: Connection = { provider: "google_calendar", status: "active", authMethod: "oauth", account: "ana@clinic.example", destination: null, lastError: null, lastTestedAt: null };

// Decision 0064: Connect with Google first, the service account form under Advanced, today's form alone without a client.
describe("Google Calendar card", () => {
  it("keeps today's service account form as the whole card when the installation has no Google client", () => {
    const html = render(createElement(GoogleCalendarCard, { conn: null, configured: false, onChange }));
    expect(html).toContain("Service account key file (JSON)");
    expect(html).toContain("Calendar id");
    expect(html).not.toContain("Connect with Google");
    expect(html).not.toContain("<details>");
  });

  it("offers Connect with Google first, with one heading and the key and calendar id under Advanced", () => {
    const html = render(createElement(GoogleCalendarCard, { conn: null, configured: true, outcome: "declined", onChange }));
    expect(html).toContain(">Connect with Google</button>");
    expect(html).toContain("use only the calendar Daloy creates");
    expect(html).toContain("The permission request was declined");
    expect(html.match(/<h3/g)).toHaveLength(1);
    expect(html).toMatch(/<details><summary>Advanced: use a key or token instead<\/summary>.*Service account key file \(JSON\).*Calendar id.*<\/details>/s);
    expect(render(createElement(GoogleCalendarCard, { conn: null, configured: true, onChange }), "tl")).toContain("Ikonekta gamit ang Google");
  });

  it("after a sign-in shows the calendar Daloy made, a test, and a way to make a new one, in both languages", () => {
    const made = { ...oauth, destination: { calendarId: "x@group.calendar.google.com", title: "Daloy bookings" } };
    const html = render(createElement(GoogleCalendarCard, { conn: made, configured: true, onChange }));
    expect(html).toContain("Account <strong>ana@clinic.example</strong>");
    expect(html).toContain("<strong>Daloy bookings</strong>");
    expect(html).toContain("Add a test event");
    expect(html).toContain("Create a new Daloy calendar");
    expect(html).toContain("Reconnect Google Calendar");
    expect(render(createElement(GoogleCalendarCard, { conn: made, configured: true, onChange }), "tl")).toContain("Gumawa ng bagong Daloy calendar");
  });

  it("offers to create the calendar when the sign-in has none yet", () => {
    const html = render(createElement(GoogleCalendarCard, { conn: oauth, configured: true, onChange }));
    expect(html).toContain("Create the Daloy bookings calendar");
    expect(html).not.toContain("Add a test event");
    expect(render(createElement(GoogleCalendarCard, { conn: oauth, configured: true, onChange }), "tl")).toContain("Gumawa ng Daloy bookings calendar");
  });

  it("shows a service account connection with its label and no create button", () => {
    const html = render(createElement(GoogleCalendarCard, { conn: { ...oauth, authMethod: "service_account", account: "sa@x.iam.gserviceaccount.com", destination: { calendarId: "c@group.calendar.google.com", title: "Clinic" } }, configured: true, onChange }));
    expect(html).toContain("Service account <strong>sa@x.iam.gserviceaccount.com</strong>");
    expect(html).not.toContain("Create a new Daloy calendar");
    expect(html).toContain("Calendar id");
  });
});
