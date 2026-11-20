import { describe, expect, it } from "vitest";
import { translate } from "./locale";
import { advancedTranslations } from "./locale-advanced";

describe("Advanced pages wording in Tagalog", () => {
  it("keeps every braced value of the English text, so a name or count is never dropped", () => {
    const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [en, tl] of Object.entries(advancedTranslations)) expect(names(tl), en).toEqual(names(en));
  });
  it("uses the translations through translate", () => {
    expect(translate("tl", "Versions of {name}", { name: "Orders" })).toBe("Mga bersyon ng Orders");
    expect(translate("en", "Versions of {name}", { name: "Orders" })).toBe("Versions of Orders");
  });
});
