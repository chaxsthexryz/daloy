import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CustomerBrandPreview } from "./CustomerBrandPreview";
import { LanguageContext } from "./Language";
import type { Language } from "./lib/locale";

function renderPreview(props: Parameters<typeof CustomerBrandPreview>[0], language: Language = "en") {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language, setLanguage: () => undefined }}>
      <CustomerBrandPreview {...props} />
    </LanguageContext.Provider>,
  );
}

describe("CustomerBrandPreview", () => {
  it("renders Public form tab with initials fallback and readable button ink", () => {
    const html = renderPreview({ businessName: "Casa del Mar Resort", accent: "#0b3d91" });
    expect(html).toContain("brand-preview");
    expect(html).toContain("How your customers see you");
    expect(html).toContain("Casa del Mar Resort");
    expect(html).toContain(">CR</span>");
    expect(html).toContain("Send request");
    expect(html).toContain('role="tab"');
    expect(html).toContain("Public form");
    expect(html).toContain("Payment page");
  });

  it("renders uploaded logo image and Payment page tab in GCash / QR Ph preview", () => {
    const html = renderPreview({
      businessName: "Laguna Cove",
      logoUrl: "data:image/png;base64,AAA=",
      accent: "#facc15",
      defaultTab: "pay",
      compact: true,
    });
    expect(html).toContain("brand-preview-compact");
    expect(html).toContain('<img src="data:image/png;base64,AAA="');
    expect(html).toContain("PHP 1,500.00");
    expect(html).toContain("Deposit due");
    expect(html).toContain("GCash / QR Ph");
    expect(html).toContain("Upload receipt");
    expect(html).toContain("#111111");
  });

  it("translates preview labels in Taglish", () => {
    const html = renderPreview({ businessName: "" }, "tl");
    expect(html).toContain("Paano ka nakikita ng mga customer");
    expect(html).toContain("Pampublikong form");
    expect(html).toContain("Page ng bayad");
    expect(html).toContain("Pangalan ng negosyo mo");
  });
});
