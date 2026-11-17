import { describe, expect, it } from "vitest";
import { approvalEmailBody, builtInEmailCopy } from "./email-copy";
import { officeRequestDefinition, defaultAnswers, previewOfficeRequest } from "./office-request";
import { purchaseRequestDefinition, defaultPurchaseAnswers } from "./purchase-request";
import { websiteInquiryDefinition } from "./website-inquiry";
import { templatesForLanguage } from "./template-language";
import { TEMPLATES } from "./templates";
import { definitionSchema } from "./definition";

describe("generated email language", () => {
  it("keeps English defaults and leaves the shared templates unchanged", () => {
    expect(templatesForLanguage()).toEqual(TEMPLATES);
    expect(builtInEmailCopy().testSubject).toBe("Daloy test email");
    expect(approvalEmailBody("Original", "https://example.test/a", "2030-01-01", "ana@example.test")).toBe("Original\n\nApprove or reject here:\nhttps://example.test/a\n\nTo answer, sign in as ana@example.test. The link works once and expires at 2030-01-01.");
  });
  it("localizes new guided templates while preserving addresses, names, placeholders and graph structure", () => {
    const office = defaultAnswers("office@example.test");
    const purchase = defaultPurchaseAnswers("boss@example.test");
    for (const [english, tagalog] of [
      [officeRequestDefinition(office), officeRequestDefinition(office, "tl")],
      [purchaseRequestDefinition(purchase), purchaseRequestDefinition(purchase, "tl")],
      [websiteInquiryDefinition({ businessName: "Thanks for contacting Maria", inquiryEmail: "maria@example.test" }), websiteInquiryDefinition({ businessName: "Thanks for contacting Maria", inquiryEmail: "maria@example.test" }, "tl")],
    ] as const) {
      expect(definitionSchema.safeParse(tagalog).success).toBe(true);
      expect(tagalog.edges).toEqual(english.edges);
      expect(tagalog.steps.map((s) => [s.id, s.type])).toEqual(english.steps.map((s) => [s.id, s.type]));
      expect(JSON.stringify(tagalog)).not.toEqual(JSON.stringify(english));
    }
    expect(JSON.stringify(websiteInquiryDefinition({ businessName: "Thanks for contacting Maria", inquiryEmail: "maria@example.test" }, "tl"))).toContain("Thanks for contacting Maria");
    expect(previewOfficeRequest(office, { name: "Mia", email: "mia@example.test", summary: "User's English request" }, "tl").receipt.text).toContain("User's English request");
  });
  it("localizes every starter email and preserves the English source", () => {
    const snapshot = JSON.stringify(TEMPLATES);
    const localized = templatesForLanguage("tl");
    expect(localized).toHaveLength(TEMPLATES.length);
    for (const template of localized) expect(definitionSchema.safeParse(template.definition).success).toBe(true);
    expect(JSON.stringify(localized)).toContain("salamat");
    expect(JSON.stringify(TEMPLATES)).toBe(snapshot);
  });
  it("adds Taglish approval instructions without translating an authored message", () => {
    const body = approvalEmailBody("Keep my authored text", "https://example.test/a", "2030-01-01", "ana@example.test", "tl");
    expect(body).toContain("Keep my authored text\n\n");
    expect(body).toContain("Mag-sign in bilang ana@example.test");
    expect(body).toContain("https://example.test/a");
    expect(builtInEmailCopy("tl").testSubject).toBe("Test email ng Daloy");
  });
});
