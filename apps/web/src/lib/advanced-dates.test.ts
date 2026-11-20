import { describe, expect, it } from "vitest";
import { isToday, shortDate, shortDateTime, shortTime } from "./advanced";

// Built from local parts, so the expected text holds in any time zone.
const at = (h: number, m: number, d = 3, month = 8) => new Date(2026, month, d, h, m).toISOString();

describe("dates on the token and secret lists", () => {
  it("reads a day as 12 Nov 2026", () => {
    expect(shortDate(at(12, 0, 12, 10))).toBe("12 Nov 2026");
  });
  it("reads a time on a 12-hour clock, with midnight and noon as 12", () => {
    expect(shortTime(at(10, 14))).toBe("10:14 AM");
    expect(shortTime(at(0, 5))).toBe("12:05 AM");
    expect(shortTime(at(12, 0))).toBe("12:00 PM");
    expect(shortTime(at(21, 40))).toBe("9:40 PM");
  });
  it("joins them as 3 Sep 2026, 10:14 AM", () => {
    expect(shortDateTime(at(10, 14))).toBe("3 Sep 2026, 10:14 AM");
  });
  it("tells today from another day using the local calendar", () => {
    const now = new Date(2026, 10, 21, 15, 0);
    expect(isToday(new Date(2026, 10, 21, 8, 41).toISOString(), now)).toBe(true);
    expect(isToday(new Date(2026, 10, 20, 23, 59).toISOString(), now)).toBe(false);
  });
});
