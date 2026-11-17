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
