import { describe, expect, it } from "vitest";
import { cellKeys, csvTable, parseCsv, READ_SPREADSHEET_MAX_ROWS } from "./csv";
import { StepError } from "./retry";

// M1 (decision 0139): marketplace order exports, read as RFC 4180 CSV.
describe("parseCsv", () => {
  it("splits plain cells and records", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("reads quoted cells with commas and newlines inside", () => {
    expect(parseCsv('name,address\n"Cruz, Ana","12 Rizal St\nBrgy 4"\n')).toEqual([
      ["name", "address"],
      ["Cruz, Ana", "12 Rizal St\nBrgy 4"],
    ]);
  });

  it("turns a doubled quote inside quotes into one quote", () => {
    expect(parseCsv('note\n"She said ""rush"""\n')).toEqual([["note"], ['She said "rush"']]);
    expect(parseCsv('a,b\n"",x\n')).toEqual([["a", "b"], ["", "x"]]);
  });

  it("drops a UTF-8 byte order mark", () => {
    const rows = parseCsv("﻿Order ID,Total\r\n1001,250\r\n");
    expect(rows[0]![0]).toBe("Order ID");
  });

  it("accepts CRLF, LF and a last record with no line break", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseCsv('a\r\n"x\r\ny"\r\n')).toEqual([["a"], ["x\r\ny"]]);
  });

  it("skips blank rows, including trailing ones and rows of empty cells", () => {
    expect(parseCsv("a,b\n1,2\n\n,\n\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("")).toEqual([]);
  });

  it("keeps an empty last cell", () => {
    expect(parseCsv("a,b\n1,\n")).toEqual([
      ["a", "b"],
      ["1", ""],
    ]);
  });

  it("refuses a quoted cell that is never closed", () => {
    expect(() => parseCsv('a\n"open\n')).toThrow(/never closed/);
  });
});

describe("cellKeys", () => {
  it("makes template-safe keys from headers", () => {
    expect(cellKeys(["Order ID", "Buyer Username", "Total (PHP)"])).toEqual(["order_id", "buyer_username", "total_php"]);
  });

  it("numbers duplicate headers and names empty ones by column", () => {
    expect(cellKeys(["Qty", "qty", "", "QTY"])).toEqual(["qty", "qty_2", "c", "qty_3"]);
  });

  it("prefixes a header that starts with a digit and names extra cells by column", () => {
    expect(cellKeys(["1st item"], 3)).toEqual(["col_1st_item", "b", "c"]);
  });
});

describe("csvTable", () => {
  it("returns rows keyed by header, the count and the columns", () => {
    const out = csvTable("﻿Order ID,Product Name,Qty\r\n2411250001,\"Tote, canvas\",2\r\n2411250002,Mug\r\n\r\n");
    expect(out).toEqual({
      columns: ["order_id", "product_name", "qty"],
      count: 2,
      rows: [
        { order_id: "2411250001", product_name: "Tote, canvas", qty: "2" },
        { order_id: "2411250002", product_name: "Mug", qty: "" },
      ],
    });
  });

  it("returns no rows for a file with only a header, or an empty file", () => {
    expect(csvTable("a,b\n")).toEqual({ rows: [], count: 0, columns: ["a", "b"] });
    expect(csvTable("")).toEqual({ rows: [], count: 0, columns: [] });
  });

  it("stops with a plain, non-retryable message over the row cap", () => {
    const body = "id\n" + Array.from({ length: READ_SPREADSHEET_MAX_ROWS + 1 }, (_, i) => String(i)).join("\n");
    const err = (() => {
      try {
        csvTable(body);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).retryable).toBe(false);
    expect((err as StepError).message).toMatch(/2,001 rows.*at most 2,000/);
    expect(csvTable(body.split("\n").slice(0, -1).join("\n")).count).toBe(READ_SPREADSHEET_MAX_ROWS);
  });

  it("turns an unclosed quote into a plain step error", () => {
    expect(() => csvTable('a\n"x')).toThrow(StepError);
  });
});
