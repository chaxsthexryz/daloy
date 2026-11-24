import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WhatsAppConnection, type Connection } from "./Connections";
import { LanguageContext } from "./Language";

const conn: Connection = {
  provider: "whatsapp",
  status: "active",
  account: "+63 917 000 0999",
  destination: { phoneNumberId: "9988776655", displayPhone: "+63 917 000 0999", wabaId: "1122334455", webhookPath: "wa-test-path" },
  lastError: null,
  lastTestedAt: null,
};

const render = (language: "en" | "tl", current: Connection | null = conn) =>
  renderToStaticMarkup(
    <LanguageContext.Provider value={{ language, setLanguage: () => undefined }}>
      <WhatsAppConnection conn={current} webhookBase="https://kymavo.test/hooks/whatsapp" onChange={async () => undefined} />
    </LanguageContext.Provider>,
  );

describe("WhatsAppConnection billing & verification cost note", () => {
  it("explains Meta per-message billing, verified Meta Business requirement, and template approval in English and Tagalog", () => {
    const en = render("en");
    expect(en).toContain("Meta bills WhatsApp Cloud API per delivered message directly to your Meta Business payment method");
    expect(en).toContain("Your Meta Business account must be verified with a payment method attached");
    expect(en).toContain("https://kymavo.test/hooks/whatsapp/wa-test-path");

    const tl = render("tl");
    expect(tl).toContain("Direktang sinisingil ng Meta ang WhatsApp Cloud API sa bawat naipadalang mensahe");
    expect(tl).toContain("aprubadong Meta utility template");

    const unconfigured = render("en", null);
    expect(unconfigured).toContain("Connect WhatsApp Cloud API");
  });
});
