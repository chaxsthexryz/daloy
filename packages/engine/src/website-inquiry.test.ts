import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { resolveTemplate } from "./expressions";
import { gmailInput, profileInput, websiteInquiryDefinition } from "./website-inquiry";

const profile = { businessName: "Lim Dental", inquiryEmail: "front@limdental.example" };

describe("website inquiry template", () => {
  it("builds a valid definition with no AI step: a reply to the customer and a notification to the business inbox", () => {
    const def = definitionSchema.parse(websiteInquiryDefinition(profile));
    expect(def.steps.map((s) => s.type)).toEqual(["email", "email"]);
    expect(def.trigger.type === "form" && def.trigger.config.fields.map((f) => f.name)).toEqual(["name", "email", "message"]);
    const [reply, notify] = def.steps;
    expect(reply!.config).toMatchObject({ to: "{{trigger.email}}" });
    expect(notify!.config).toMatchObject({ to: "front@limdental.example" });
  });

  it("names the business in the reply and the customer's address in the notification", () => {
    const ctx = { trigger: { name: "Rosa", email: "rosa@example.com", message: "Do you open on Saturdays?" }, steps: {} };
    const [reply, notify] = websiteInquiryDefinition(profile).steps.map((s) => s.config as { subject: string; text: string });
    expect(String(resolveTemplate(reply!.subject, ctx))).toContain("Lim Dental");
    expect(String(resolveTemplate(notify!.text, ctx))).toContain("rosa@example.com");
    expect(String(resolveTemplate(notify!.text, ctx))).toContain("Do you open on Saturdays?");
  });
});

describe("profile input", () => {
  it("turns empty answers into null and accepts a website with https", () => {
    expect(profileInput.parse({ businessName: " Lim Dental ", website: "", inquiryEmail: "front@limdental.example", replyTo: "" })).toEqual({
      businessName: "Lim Dental",
      website: null,
      inquiryEmail: "front@limdental.example",
      replyTo: null,
    });
    expect(profileInput.parse({ businessName: "A", website: "https://limdental.example/contact", inquiryEmail: "", replyTo: "" }).website).toBe("https://limdental.example/contact");
  });

  it("refuses names that would become placeholders or headers, other URL schemes and bad addresses", () => {
    const base = { businessName: "Lim Dental", website: "", inquiryEmail: "", replyTo: "" };
    for (const bad of [
      { ...base, businessName: "{{secrets.api_token}}" },
      { ...base, businessName: "Lim\r\nBcc: x@example.com" },
      { ...base, businessName: "" },
      { ...base, website: "javascript:alert(1)" },
      { ...base, website: "ftp://limdental.example" },
      { ...base, inquiryEmail: "front@" },
      { ...base, replyTo: "a@example.com, b@example.com" },
      { ...base, extra: "x" },
    ]) {
      expect(profileInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("gmail input", () => {
  it("accepts a 16-letter app password with or without Google's spaces", () => {
    expect(gmailInput.parse({ address: "Shop@Gmail.com", appPassword: "abcd efgh ijkl mnop" })).toEqual({ address: "shop@gmail.com", appPassword: "abcdefghijklmnop" });
  });

  it("refuses an account password, a short password and a bad address", () => {
    for (const bad of [
      { address: "shop@gmail.com", appPassword: "MyRealPassword!2026" },
      { address: "shop@gmail.com", appPassword: "abcd efgh" },
      { address: "shop", appPassword: "abcdefghijklmnop" },
    ]) {
      expect(gmailInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
