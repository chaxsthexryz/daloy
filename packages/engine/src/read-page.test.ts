import { describe, expect, it } from "vitest";
import { definitionSpec } from "./ai-draft";
import { definitionSchema, readPageConfigSchema } from "./definition";
import { lintDefinition } from "./lint";

describe("read_page config", () => {
  it("needs only a web address, and defaults maxChars to 4000", () => {
    expect(readPageConfigSchema.parse({ url: "https://example.com/rice" })).toEqual({ url: "https://example.com/rice", maxChars: 4000 });
  });
  it("keeps a selector and a template in the address", () => {
    expect(readPageConfigSchema.parse({ url: "{{trigger.page}}", selector: ".price", maxChars: 500 })).toMatchObject({ selector: ".price", maxChars: 500 });
  });
  it("refuses an empty address, an empty selector and an out of range maxChars", () => {
    expect(readPageConfigSchema.safeParse({ url: "" }).success).toBe(false);
    expect(readPageConfigSchema.safeParse({ url: "https://a.test", selector: "" }).success).toBe(false);
    for (const maxChars of [0, 99, 20_001, 1.5]) expect(readPageConfigSchema.safeParse({ url: "https://a.test", maxChars }).success, String(maxChars)).toBe(false);
  });
});

const watch = {
  trigger: { type: "schedule", config: { cron: "0 8 * * *", timezone: "Asia/Manila" } },
  steps: [
    { id: "read", type: "read_page", config: { url: "https://example.com/rice", selector: ".price", maxChars: 4000 } },
    { id: "moved", type: "condition", config: { condition: { left: "{{steps.read.output.changed}}", op: "eq", right: true } } },
    { id: "text", type: "sms", config: { to: "+639170000000", message: "Rice price is now {{steps.read.output.value}}" } },
  ],
  edges: [{ from: "read", to: "moved" }, { from: "moved", to: "text", on: "true" }],
};

describe("a price watch workflow", () => {
  it("is a valid definition", () => {
    expect(definitionSchema.safeParse(watch).success).toBe(true);
  });
  it("has no lint problems", () => {
    const parsed = definitionSchema.parse(watch);
    expect(lintDefinition(parsed)).toEqual([]);
  });
});

describe("AI draft prompt", () => {
  it("shows read_page to a hosted model only, so the short prompt for small models stays small", () => {
    expect(definitionSpec(true)).toContain("read_page");
    expect(definitionSpec(false)).not.toContain("read_page");
  });
});
