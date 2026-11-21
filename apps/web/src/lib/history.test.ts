import { describe, expect, it } from "vitest";
import { record, redo, startHistory, undo } from "./history";

describe("history", () => {
  it("undoes and redoes to the exact earlier values", () => {
    const a = { n: 1 };
    const b = { n: 2 };
    let h = record(record(startHistory(a), b), { n: 3 });
    h = undo(h);
    expect(h.present).toBe(b);
    h = undo(h);
    expect(h.present).toBe(a);
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present).toBe(b);
  });

  it("drops the redo list when a new edit follows an undo", () => {
    const h = record(undo(record(startHistory(1), 2)), 3);
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
  });

  it("merges edits with the same key into one undo step", () => {
    let h = record(startHistory("a"), "ab", "field");
    h = record(h, "abc", "field");
    expect(undo(h).present).toBe("a");
    h = record(record(h, "x", "other"), "y", "field");
    expect(undo(undo(h)).present).toBe("abc");
  });

  it("ignores an edit that changes nothing and caps the past", () => {
    const h = startHistory(0);
    expect(record(h, 0)).toBe(h);
    let long = h;
    for (let i = 1; i <= 150; i++) long = record(long, i);
    expect(long.past).toHaveLength(100);
  });
});
