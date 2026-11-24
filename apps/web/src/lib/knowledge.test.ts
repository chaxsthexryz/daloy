import { knowledgeEntryInput, type KnowledgeEntry } from "@daloy/engine";
import { describe, expect, it } from "vitest";
import { emptyForm, emptyRule, summaryOf, toForm, toInput } from "./knowledge";

const words = { per: (u: string) => `per ${u}`, rules: (n: number) => `${n} rules` };

describe("knowledge form", () => {
  it("leaves empty boxes out and builds an entry the API accepts", () => {
    const form = { ...emptyForm("room"), title: " Garden room ", price: "3500", capacity: "4", deposit: "percent" as const, depositValue: "30", rules: [{ ...emptyRule(), name: "Peak", price: "4800", from: "12-15", to: "01-10" }] };
    const input = toInput(form);
    expect(input).toEqual({ kind: "room", title: "Garden room", body: "", fields: { price: 3500, unit: "night", capacity: 4, deposit: { mode: "percent", value: 30 }, rules: [{ name: "Peak", price: 4800, from: "12-15", to: "01-10" }] } });
    expect(knowledgeEntryInput.safeParse(input).success).toBe(true);
  });

  it("drops price boxes when the kind is not priced", () => {
    const input = toInput({ ...emptyForm("faq"), title: "Pets", body: "No pets.", price: "100", deposit: "fixed", depositValue: "5" });
    expect(input.fields).toEqual({});
  });

  it("round-trips a stored entry", () => {
    const entry: KnowledgeEntry = { id: "x", kind: "fee", title: "Day tour", body: "", fields: { price: 350, unit: "day", url: "https://example.com/tour", rules: [{ name: "Weekend", price: 400, days: ["sat", "sun"] }] } };
    expect(toInput(toForm(entry))).toEqual({ kind: "fee", title: "Day tour", body: "", fields: entry.fields });
  });

  it("summarises price, rules or text", () => {
    expect(summaryOf({ id: "x", kind: "room", title: "R", body: "", fields: { price: 3500, unit: "night", rules: [{ name: "a", price: 1 }] } }, words)).toBe("PHP 3,500 per night, 1 rules");
    expect(summaryOf({ id: "x", kind: "arrival", title: "Hours", body: "", fields: { checkInTime: "15:00", checkOutTime: "11:00" } }, words)).toBe("15:00 / 11:00");
    expect(summaryOf({ id: "x", kind: "faq", title: "Pets", body: "No pets.", fields: {} }, words)).toBe("No pets.");
    expect(summaryOf({ id: "x", kind: "faq", title: "Long", body: "a".repeat(200), fields: {} }, words)).toHaveLength(110);
  });

  it("round-trips check-in and check-out times on arrival entries and drops them on FAQs", () => {
    const entry: KnowledgeEntry = { id: "a", kind: "arrival", title: "Check-in hours", body: "", fields: { checkInTime: "15:00", checkOutTime: "11:00" } };
    expect(toInput(toForm(entry))).toEqual({ kind: "arrival", title: "Check-in hours", body: "", fields: { checkInTime: "15:00", checkOutTime: "11:00" } });
    expect(toInput({ ...emptyForm("faq"), title: "Hours", body: "2 PM", checkInTime: "14:00" }).fields).toEqual({});
  });
});
