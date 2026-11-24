import { describe, expect, it } from "vitest";
import { runTransform, TransformError, type TransformInput } from "./transform";

const ctx = { trigger: { phone: "0917 123 4567", name: "  Ana Reyes ", amount: "1234.5", tags: "a, b ,c", at: "2027-01-20T06:00:00Z", nested: { n: 1 } }, steps: {} };
const run = (c: TransformInput) => runTransform(c, ctx);

describe("runTransform", () => {
  it("trims, lowercases and uppercases", () => {
    expect(run({ op: "trim", value: "{{trigger.name}}" })).toEqual({ result: "Ana Reyes" });
    expect(run({ op: "lowercase", value: "{{trigger.name}}" })).toEqual({ result: "  ana reyes " });
    expect(run({ op: "uppercase", value: "abc" })).toEqual({ result: "ABC" });
  });

  it("normalizes a Philippine mobile number and refuses others", () => {
    expect(run({ op: "normalize_phone", value: "{{trigger.phone}}" })).toEqual({ result: "+639171234567", local: "09171234567" });
    expect(() => run({ op: "normalize_phone", value: "12345" })).toThrow(TransformError);
  });

  it("formats pesos with grouping and two decimals", () => {
    expect(run({ op: "format_peso", value: "{{trigger.amount}}" })).toMatchObject({ result: "PHP 1,234.50", plain: "1234.50", code: "PHP 1,234.50", amount: 1234.5 });
    expect(run({ op: "format_peso", value: "₱3,500" })).toMatchObject({ result: "PHP 3,500.00" });
    expect(run({ op: "format_peso", value: "-20" })).toMatchObject({ result: "-PHP 20.00" });
    expect(() => run({ op: "format_peso", value: "lots" })).toThrow(TransformError);
    expect(() => run({ op: "format_peso", value: "" })).toThrow(TransformError);
  });

  it("formats a date in the chosen timezone", () => {
    expect(run({ op: "format_date", value: "{{trigger.at}}", timezone: "Asia/Manila", format: "iso" })).toMatchObject({ result: "2027-01-20T14:00:00+08:00", timezone: "Asia/Manila" });
    expect(run({ op: "format_date", value: "{{trigger.at}}", format: "datetime" })).toMatchObject({ result: "2027-01-20 14:00" });
    expect(run({ op: "format_date", value: "{{trigger.at}}", timezone: "America/New_York", format: "time" })).toMatchObject({ result: "01:00" });
    expect(run({ op: "format_date", value: "2027-01-20", format: "date", timezone: "UTC" })).toMatchObject({ result: "2027-01-20" });
    expect(String(run({ op: "format_date", value: "{{trigger.at}}" }).result)).toMatch(/2027/);
  });

  it("refuses an unreadable date, an empty date and an unknown timezone", () => {
    expect(() => run({ op: "format_date", value: "soon" })).toThrow(TransformError);
    expect(() => run({ op: "format_date", value: "" })).toThrow(TransformError);
    expect(() => run({ op: "format_date", value: "2027-02-31" })).toThrow(TransformError);
    expect(() => run({ op: "format_date", value: "2027-01-20", timezone: "Mars/Base" })).toThrow(/timezone/);
  });

  it("splits text, trimming each part", () => {
    expect(run({ op: "split", value: "{{trigger.tags}}" })).toMatchObject({ items: ["a", "b", "c"], first: "a", last: "c", count: 3 });
    expect(run({ op: "split", value: "", separator: ";" })).toMatchObject({ items: [], count: 0, first: "" });
    expect(run({ op: "split", value: "x|y", separator: "|" })).toMatchObject({ items: ["x", "y"] });
    expect(() => run({ op: "split", value: Array(300).fill("a").join(",") })).toThrow(/limit/);
  });

  it("picks a template object and keeps types", () => {
    expect(run({ op: "pick", fields: { who: "{{trigger.name}}", n: "{{trigger.nested.n}}", gone: "{{trigger.missing}}", mix: "Hi {{trigger.name}}" } })).toEqual({ who: "  Ana Reyes ", n: 1, gone: null, mix: "Hi   Ana Reyes " });
  });

  it("never runs code in a value", () => {
    expect(() => run({ op: "trim", value: "{{trigger.constructor.constructor('return 1')()}}" })).toThrow();
    expect(run({ op: "trim", value: "${1+1} process.exit()" })).toEqual({ result: "${1+1} process.exit()" });
  });
});
