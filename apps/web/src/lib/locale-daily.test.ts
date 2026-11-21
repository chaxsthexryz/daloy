import { describe, expect, it } from "vitest";
import { dailyTranslations } from "./locale-daily";
import { translate } from "./locale";

describe("R5 strings", () => {
  it("has Tagalog for the export, the morning summary and the Taglish choice, with no dashes", () => {
    for (const [en, tl] of Object.entries(dailyTranslations)) {
      expect(translate("tl", en), en).toBe(tl);
      expect(`${en}${tl}`).not.toMatch(/[–—]/);
    }
    expect(translate("tl", "Download payments CSV")).not.toBe("Download payments CSV");
  });
});
