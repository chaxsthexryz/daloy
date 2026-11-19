import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GuidedStep, GuidedSteps } from "./GuidedSteps";
import { LanguageContext } from "./Language";
import { pasteTranslations } from "./lib/locale-paste";
import { translate, type Language } from "./lib/locale";
import { PaymongoSetup, TeamsSetup, TelegramSetup, paymongoKeyCheck } from "./PasteSetups";

const render = (node: React.ReactNode, language: Language = "en") =>
  renderToStaticMarkup(<LanguageContext.Provider value={{ language, setLanguage: () => undefined }}>{node}</LanguageContext.Provider>);
const none = { conn: null, onChange: async () => undefined, onClose: () => undefined };
const steps = (html: string) => (html.match(/<li class="guided-step">/g) ?? []).length;

describe("guided steps", () => {
  it("numbers the steps in an ordered list and shows a live check only when there is one", () => {
    const html = render(
      <GuidedSteps>
        <GuidedStep title="One" check={{ state: "ok", text: "Fine" }} />
        <GuidedStep title="Two" check={{ state: "error", text: "Broken" }} />
        <GuidedStep title="Three" check={{ state: "busy" }} />
        <GuidedStep title="Four" check={{ state: "idle" }} />
      </GuidedSteps>,
    );
    expect(html).toContain('<ol class="guided-steps">');
    expect(steps(html)).toBe(4);
    expect(html).toContain('role="status" class="step-check ok">Fine');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Broken");
    expect(html).toContain("Checking…");
    expect(html.match(/step-check/g)).toHaveLength(3);
  });
});

describe("the three setups render their steps", () => {
  it("Telegram: BotFather link, token step, chat picker step, typed chat id fallback", () => {
    const html = render(<TelegramSetup {...none} />);
    expect(steps(html)).toBe(4);
    expect(html).toContain('href="https://t.me/BotFather"');
    expect(html).toContain("/newbot");
    expect(html).toContain("Find my chats");
    expect(html).toContain('id="tg-chat"');
    expect(html).not.toContain('<ul class="chat-list">');
  });
  it("Teams: numbered steps, the Microsoft help link, no claim of exact menu names", () => {
    const html = render(<TeamsSetup {...none} />);
    expect(steps(html)).toBe(3);
    expect(html).toContain("support.microsoft.com/en-us/workflows/send-messages-in-teams-using-incoming-webhooks");
    expect(html).toContain("Menu names may differ");
    expect(html).toContain("send a test message");
  });
  it("PayMongo: test mode first, key, webhook address after the key, secret", () => {
    const html = render(<PaymongoSetup {...none} webhookBase="https://daloy.test/hooks/paymongo" />);
    expect(steps(html)).toBe(4);
    expect(html).toContain("switch to test mode");
    expect(html).toContain("Save the secret key first");
    const saved = render(<PaymongoSetup {...none} conn={{ provider: "paymongo", status: "active", account: "Test mode key", destination: { webhookPath: "abc", mode: "test" }, lastError: null, lastTestedAt: null }} webhookBase="https://daloy.test/hooks/paymongo" />);
    expect(saved).toContain("https://daloy.test/hooks/paymongo/abc");
  });
});

describe("PayMongo key check", () => {
  it("tells a test key, a live key and a wrong key apart, and says nothing for an empty box", () => {
    expect(paymongoKeyCheck("").state).toBe("idle");
    expect(paymongoKeyCheck("sk_test_abc").state).toBe("ok");
    expect(paymongoKeyCheck("sk_live_abc").state).toBe("warn");
    expect(paymongoKeyCheck("pk_test_abc").state).toBe("error");
  });
});

describe("Tagalog", () => {
  it("has a translation for every new string, none of them the English text", () => {
    for (const [en, tl] of Object.entries(pasteTranslations)) {
      expect(tl, en).not.toBe("");
      expect(translate("tl", en.replace("{bot}", "{bot}"), { bot: "@x", count: 2 }), en).not.toBe(en.replace("{bot}", "@x").replace("{count}", "2"));
    }
  });
  it("renders the wizards in Tagalog", () => {
    expect(render(<TelegramSetup {...none} />, "tl")).toContain("Gumawa ng bot");
    expect(render(<TeamsSetup {...none} />, "tl")).toContain("Magsimula ng workflow sa Teams");
    expect(render(<PaymongoSetup {...none} webhookBase="x" />, "tl")).toContain("Gamitin muna ang test mode");
  });
});
