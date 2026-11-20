import { describe, expect, it } from "vitest";
import { translate } from "./locale";
import { setupTranslations } from "./locale-setup";

describe("Guided pages wording in Tagalog", () => {
  it("keeps every braced value of the English text, so a name or count is never dropped", () => {
    const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [en, tl] of Object.entries(setupTranslations)) expect(names(tl), en).toEqual(names(en));
  });
  it("is reachable through translate and leaves English alone", () => {
    expect(translate("tl", "Try the preview")).toBe("Subukan ang preview");
    expect(translate("en", "Try the preview")).toBe("Try the preview");
  });
});
