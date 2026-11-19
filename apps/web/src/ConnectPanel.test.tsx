import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectPanel, SharedGrants } from "./ConnectPanel";
import { LanguageContext } from "./Language";

// Plan R14: a card whose provider account is also connected elsewhere in Daloy says so.
const conn = { account: "Acme Dental", lastError: null, status: "active" };
const render = (shared: string[], connected = true) =>
  renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: "en", setLanguage: () => undefined }}>
      <SharedGrants.Provider value={shared}>
        <ConnectPanel slug="google-sheets" name="Google Sheets" configured conn={connected ? conn : null} label="Account" onChange={async () => undefined} />
      </SharedGrants.Provider>
    </LanguageContext.Provider>,
  );
const WARNING = "also connected somewhere else in Daloy";

describe("shared grant warning", () => {
  it("shows on a connected card whose account is shared, matching the slug to the app key", () => {
    expect(render(["google_sheets"])).toContain(WARNING);
  });
  it("does not show for another app's shared account, or before connecting", () => {
    expect(render(["slack"])).not.toContain(WARNING);
    expect(render(["google_sheets"], false)).not.toContain(WARNING);
  });
});
