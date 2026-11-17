import { describe, expect, it } from "vitest";
import { translate } from "./locale";
import { usageLines } from "./usage";
import type { Usage } from "../api";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageContext } from "../Language";
import { CalendarConnection, DeliveryList, PaymongoConnection, SheetsConnection, type Delivery } from "../Connections";
import { SchemaForm } from "../SchemaForm";
import { FormEmbed } from "../FormEmbed";

const render = (element: ReactElement, language: "en" | "tl") => renderToStaticMarkup(createElement(LanguageContext.Provider, { value: { language, setLanguage: () => undefined } }, element));

describe("management interface language", () => {
  it("translates management prompts while preserving customer values", () => {
    const source = "Cancel {reference} with {resource} on {time}? Its reminders stop.";
    const values = { reference: "REF-42", resource: "Room Settings", time: "2027-01-20 14:00" };
    expect(translate("en", source, values)).toBe("Cancel REF-42 with Room Settings on 2027-01-20 14:00? Its reminders stop.");
    expect(translate("tl", source, values)).toBe("Kanselahin ang REF-42 sa Room Settings sa 2027-01-20 14:00? Hihinto ang mga paalala nito.");
  });
  it("translates delivery feedback without changing provider details", () => {
    expect(translate("tl", "waiting to try again ({error})", { error: "Slack HTTP 429" })).toBe("naghihintay na subukan ulit (Slack HTTP 429)");
    expect(translate("tl", "{field} {number} name", { field: "Headers", number: 2 })).toBe("pangalan ng Headers 2");
  });
  it("translates composed limits and preserves the English wording", () => {
    const meter = { used: 80, limit: 100, resetsOn: "2026-12-17" };
    const usage = { ai: meter, email: { ...meter, used: 0 }, http: { ...meter, used: 0 }, automations: { live: 0, limit: 5 } } as Usage;
    expect(usageLines(usage)).toEqual(["You have used 80 of 100 AI actions. They come back on 17 December."]);
    expect(usageLines(usage, (source, values) => translate("tl", source, values))).toEqual(["Nagamit mo na ang 80 sa 100 AI actions. Babalik ang mga ito sa 17 Disyembre."]);
  });
  it("renders delivery states and action buttons in the selected language", () => {
    const delivery: Delivery = { id: "delivery-1", provider: "outlook", stepId: "email", state: "needs_review", checkFirst: false, attempts: 1, result: null, lastError: null };
    const element = createElement(DeliveryList, { deliveries: [delivery], onChange: async () => undefined });
    expect(render(element, "en")).toContain("Outlook email: may have been sent");
    const html = render(element, "tl");
    expect(html).toContain("Email sa Outlook: maaaring naipadala na");
    expect(html).toContain("Markahang naipadala");
    expect(html).toContain("Ipadala ulit");
    expect(html).toContain('data-state="needs_review"');
  });
  it("keeps schema enum values and map keys while translating visible labels", () => {
    const element = createElement(SchemaForm, { schema: { properties: { action: { type: "string", enum: ["create", "cancel"] }, headers: { type: "object", additionalProperties: { type: "string" } } } }, value: { action: "create", headers: { "X-Customer": "Settings" } }, onChange: () => undefined });
    const html = render(element, "tl");
    expect(html).toContain('value="create" selected="">gumawa</option>');
    expect(html).toContain('aria-label="pangalan ng Mga header 1"');
    expect(html).toContain('value="X-Customer"');
    expect(html).toContain('value="Settings"');
    expect(render(element, "en")).toContain('aria-label="Headers 1 name"');
  });
  it("translates connection setup and embed actions without changing provider names", () => {
    const html = render(createElement(SheetsConnection, { conn: null, onChange: async () => undefined }), "tl");
    expect(html).toContain("Google Sheets");
    expect(html).toContain("Ikonekta ang Google Sheets");
    expect(html).toContain("Paano gumawa ng service account");
    expect(render(createElement(FormEmbed, { link: "https://example.test/forms/customer" }), "tl")).toContain("Kopyahin ang embed code");
  });
  it("translates the calendar and payment connection cards", () => {
    const calendar = render(createElement(CalendarConnection, { conn: null, onChange: async () => undefined }), "tl");
    expect(calendar).toContain("Ikonekta ang Google Calendar");
    const payment = render(createElement(PaymongoConnection, { conn: null, webhookBase: "https://example.test", onChange: async () => undefined }), "tl");
    expect(payment).toContain("Ikonekta ang PayMongo");
    expect(payment).toContain("I-paste ang PayMongo secret key");
    expect(render(createElement(PaymongoConnection, { conn: null, webhookBase: "https://example.test", onChange: async () => undefined }), "en")).toContain("Connect PayMongo");
  });
});
