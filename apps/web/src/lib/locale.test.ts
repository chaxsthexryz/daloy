import { describe, expect, it } from "vitest";
import { translate } from "./locale";

describe("console language", () => {
  it("keeps English text and falls back for untranslated text", () => {
    expect(translate("en", "Settings")).toBe("Settings");
    expect(translate("tl", "Unknown text")).toBe("Unknown text");
  });
  it("translates catalog text without changing interpolated user values", () => {
    expect(translate("tl", "Signed in as {email}, {role}.", { email: "Settings@example.com", role: "Owner" })).toBe("Naka-sign in bilang Settings@example.com, Owner.");
  });
});

it("localizes generated template copy without changing saved English templates", async () => {
  const { templatesForLanguage, TEMPLATES } = await import("@daloy/engine");
  const english = templatesForLanguage("en");
  const tagalog = templatesForLanguage("tl");
  expect(english).toEqual(TEMPLATES);
  expect(tagalog[0]?.definition).not.toEqual(english[0]?.definition);
  expect(templatesForLanguage("en")).toEqual(TEMPLATES);
});

it("translates the pause, cancel and webhook timestamp text (N11b)", () => {
  expect(translate("tl", "Cancel run")).toBe("Kanselahin ang run");
  expect(translate("tl", "Paused")).toBe("Naka-pause");
  expect(translate("tl", "A call signed without a timestamp was accepted on {date}. Update the caller, then turn this on.", { date: "18/11/2026" })).toContain("18/11/2026");
  expect(translate("en", "Nothing was sent. Choose what to do.")).toBe("Nothing was sent. Choose what to do.");
});

it("translates remaining sidebar and app-back labels in Taglish (F5)", () => {
  expect(translate("tl", "Library")).toBe("Aklatan");
  expect(translate("tl", "Team")).toBe("Koponan");
  expect(translate("tl", "Settings")).toBe("Mga setting");
  expect(translate("tl", "Account")).toBe("Account ko");
  expect(translate("tl", "Back to Apps")).toBe("Bumalik sa Mga app");
});
