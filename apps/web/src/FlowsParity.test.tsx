import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskAi } from "./AiDraft";
import { SettingsPage } from "./AppSettings";
import { FeedbackPage } from "./Feedback";
import { LanguageContext } from "./Language";
import type { Draft } from "./lib/graph";
import type { User } from "./Team";

const owner: User = { id: "u1", workspaceId: "w1", email: "maria@resort.ph", role: "owner", displayName: "Maria" };

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: "en", setLanguage: () => undefined }}>
      {node}
    </LanguageContext.Provider>,
  );

describe("Console Blocks flow parity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders AskAi header, form, and controls", () => {
    const draft: Draft = { trigger: { type: "manual", config: {} }, steps: [], edges: [] };
    const html = render(<AskAi workflowId="wf-test" draft={draft} onApply={() => undefined} />);
    expect(html).toContain('id="ask-ai-heading"');
    expect(html).toContain("Ask the AI");
    expect(html).toContain("What should this workflow do?");
    expect(html).toContain(">Send<");
  });

  it("renders Support hub with FAQ, Send feedback form, and Patch notes & updates", () => {
    const html = render(<FeedbackPage />);
    expect(html).toContain("<h1>Support</h1>");
    expect(html).toContain("All systems operational");
    expect(html).toContain("Frequently asked questions");
    expect(html).toContain("How do GCash receipt checks work?");
    expect(html).toContain("Send feedback");
    expect(html).toContain("Patch notes &amp; updates");
    expect(html).toContain(">v2.4<");
  });

  it("renders Settings account quick links alongside required regions", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const html = render(<SettingsPage user={owner} />);
    expect(html).toContain('href="#/account"');
    expect(html).toContain("Edit name &amp; password");
    expect(html).toContain('href="#/feedback"');
    expect(html).toContain("Support &amp; feedback");
  });
});
