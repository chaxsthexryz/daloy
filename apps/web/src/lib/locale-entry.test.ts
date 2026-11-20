import { describe, expect, it } from "vitest";
import { translate } from "./locale";
import { requestStatus } from "./my-requests";
import { entryTranslations } from "./locale-entry";

describe("My requests wording in Tagalog", () => {
  it("has a translation for every status label the page can show", () => {
    for (const state of ["pending", "running", "waiting", "needs_review", "succeeded", "failed", "cancelled"]) {
      const { label } = requestStatus(state);
      expect(entryTranslations[label], label).toBeTruthy();
      expect(translate("tl", label)).toBe(entryTranslations[label]);
    }
  });
});
