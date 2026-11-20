import { describe, expect, it } from "vitest";
import { translate } from "./locale";
import { opsTranslations } from "./locale-ops";

describe("Automations table wording in Tagalog", () => {
  it("keeps every braced value of the English text, so a count or date is never dropped", () => {
    const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [en, tl] of Object.entries(opsTranslations)) expect(names(tl), en).toEqual(names(en));
  });
  it("fills in the values", () => {
    expect(translate("tl", "Paused on {date}", { date: "Nob 17" })).toBe("Naka-pause noong Nob 17");
    expect(translate("tl", "{count} requests need you", { count: 3 })).toBe("Kailangan ka ng 3 request");
    expect(translate("en", "{count} requests need you", { count: 3 })).toBe("3 requests need you");
  });
});
