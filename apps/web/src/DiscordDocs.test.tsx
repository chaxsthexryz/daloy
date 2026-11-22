import { definitionSchema, stepLabel } from "@daloy/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocTemplatePicker } from "./DocTemplatePicker";
import { LanguageContext } from "./Language";
import { addStep, blankDraft } from "./lib/graph";
import { insertables, setupLeft } from "./lib/editor";
import { integrationTranslations } from "./lib/locale-integrations";
import { translate, type Language } from "./lib/locale";
import { DiscordSetup } from "./PasteSetups";

// Phase I1: editor and setup support for the Discord and Make a document steps.
const render = (node: React.ReactNode, language: Language = "en") =>
  renderToStaticMarkup(<LanguageContext.Provider value={{ language, setLanguage: () => undefined }}>{node}</LanguageContext.Provider>);
const none = { conn: null, onChange: async () => undefined, onClose: () => undefined };
const manual = () => blankDraft();

describe("Discord setup", () => {
  it("has three steps, the Discord help link, a password-type link field and no claim of exact menu names", () => {
    const html = render(<DiscordSetup {...none} />);
    expect((html.match(/<li class="guided-step">/g) ?? []).length).toBe(3);
    expect(html).toContain("support.discord.com");
    expect(html).toContain('id="dc-url" type="password"');
    expect(html).toContain("Menu names may differ");
    expect(html).toContain("never shows it again");
  });
  it("renders in Taglish", () => {
    expect(render(<DiscordSetup {...none} />, "tl")).toContain("Gumawa ng webhook sa Discord");
  });
});

describe("Make a document template picker", () => {
  const noop = () => undefined;
  it("asks for a template until one is picked, then shows its name", () => {
    expect(render(<DocTemplatePicker templateId="" onPick={noop} />)).toContain("No template picked yet.");
    expect(render(<DocTemplatePicker templateId="" onPick={noop} />)).toContain("Pick a template");
    const picked = render(<DocTemplatePicker templateId="1TemplateIdAbCdEf" templateName="Invoice template" onPick={noop} />);
    expect(picked).toContain("Template: Invoice template");
    expect(picked).toContain("Pick another template");
  });
  it("renders in Taglish", () => {
    expect(render(<DocTemplatePicker templateId="" onPick={noop} />, "tl")).toContain("Wala pang napiling template.");
  });
});

describe("integration translations", () => {
  it("has a Taglish text for every entry", () => {
    for (const [en, tl] of Object.entries(integrationTranslations)) {
      expect(tl, en).not.toBe("");
      if (!/^(Template|Webhook link|Template: \{name\})$/.test(en)) expect(translate("tl", en, { name: "x", example: "{{name}}" }), en).not.toBe(en.replace("{name}", "x").replace("{example}", "{{name}}"));
    }
  });
});

describe("adding the steps in the editor", () => {
  it("adds a Discord step with a message that already saves", () => {
    const { draft } = addStep(manual(), "discord");
    expect(draft.steps[0]).toMatchObject({ type: "discord", config: { text: expect.any(String) } });
    expect(definitionSchema.safeParse(draft).success).toBe(true);
    expect(stepLabel("discord")).toBe("Discord, Post a message");
  });
  it("adds a Make a document step that cannot be saved until a template is picked", () => {
    const { draft } = addStep(manual(), "google_docs");
    expect(definitionSchema.safeParse(draft).success).toBe(false);
    const step = draft.steps[0]!;
    const picked = { ...draft, steps: [{ ...step, config: { ...step.config, templateId: "1TemplateIdAbCdEf", templateName: "Invoice" } }] } as typeof draft;
    expect(definitionSchema.safeParse(picked).success).toBe(true);
    expect(stepLabel("google_docs")).toBe("Google Docs, Make a document");
  });
  it("offers the document link to later steps", () => {
    const first = addStep(manual(), "google_docs");
    const second = addStep(first.draft, "discord", { id: first.id });
    expect(insertables(second.draft, second.id)).toEqual(expect.arrayContaining(["{{steps.google_docs_1.output.url}}", "{{steps.google_docs_1.output.documentId}}"]));
  });
  it("tells which apps the steps need", () => {
    const first = addStep(manual(), "google_docs");
    const second = addStep(first.draft, "discord", { id: first.id });
    const needs = setupLeft(second.draft, new Set<string>());
    expect(needs.map((n) => n.provider).sort()).toEqual(["discord", "google_drive"]);
  });
});
