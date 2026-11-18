import { describe, expect, it } from "vitest";
import { cell, toCsv } from "./csv";

describe("csv", () => {
  it("prefixes a quote to cells a spreadsheet would run as a formula", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(cell(v).replace(/^"|"$/g, "")).toMatch(/^'/);
  });
  it("quotes commas, quotes and newlines, and leaves plain text alone", () => {
    expect(cell("Ana")).toBe("Ana");
    expect(cell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(cell(null)).toBe("");
    expect(cell(5)).toBe("5");
    expect(cell({ a: 1 })).toBe('"{""a"":1}"');
  });
  it("joins rows with CRLF", () => {
    expect(toCsv(["a", "b"], [["1", "2"]])).toBe("a,b\r\n1,2\r\n");
  });
});
