import { describe, expect, it } from "vitest";
import { knowledgeEntryInput } from "./knowledge";

const ok = (e: unknown) => knowledgeEntryInput.safeParse(e).success;

describe("knowledge entry", () => {
  it("takes a base price with named rules for a season, a weekday and a per-head fee", () => {
    expect(ok({
      kind: "room",
      title: "Garden room",
      fields: {
        price: 3500, unit: "night", capacity: 4, deposit: { mode: "percent", value: 30 },
        rules: [
          { name: "Peak season", price: 4800, from: "12-15", to: "01-10" },
          { name: "Weekend", price: 4200, days: ["fri", "sat"] },
          { name: "Extra guest", price: 500, unit: "person_night" },
        ],
      },
    })).toBe(true);
  });

  it("takes a fixed deposit and a day-tour fee", () => {
    expect(ok({ kind: "fee", title: "Day tour", fields: { price: 350, unit: "day", deposit: { mode: "fixed", value: 1000 } } })).toBe(true);
  });

  it.each([
    ["a price on an FAQ", { kind: "faq", title: "Pets", body: "No pets.", fields: { price: 100 } }],
    ["a percent over 100", { kind: "room", title: "R", fields: { price: 1, deposit: { mode: "percent", value: 120 } } }],
    ["a season with only a start", { kind: "rate", title: "R", fields: { price: 1, rules: [{ name: "Peak", price: 2, from: "12-01" }] } }],
    ["an impossible date", { kind: "rate", title: "R", fields: { price: 1, rules: [{ name: "Peak", price: 2, from: "02-30", to: "03-01" }] } }],
    ["a fractional price", { kind: "rate", title: "R", fields: { price: 10.5 } }],
    ["a negative price", { kind: "rate", title: "R", fields: { price: -1 } }],
    ["a plain-http link", { kind: "review_link", title: "Google", fields: { url: "http://example.com/review" } }],
    ["a javascript link", { kind: "review_link", title: "Google", fields: { url: "javascript:alert(1)" } }],
    ["an empty entry", { kind: "policy", title: "Cancellation" }],
    ["an unknown kind", { kind: "menu", title: "Lunch", body: "Adobo" }],
    ["an unknown field", { kind: "faq", title: "Pets", body: "No.", fields: { discount: 10 } }],
    ["13 rules", { kind: "rate", title: "R", fields: { price: 1, rules: Array.from({ length: 13 }, (_, i) => ({ name: `r${i}`, price: 1 })) } }],
  ])("refuses %s", (_name, entry) => expect(ok(entry)).toBe(false));

  it("accepts a link entry with no text", () => {
    expect(ok({ kind: "review_link", title: "Google reviews", fields: { url: "https://g.page/r/example/review" } })).toBe(true);
  });
});
