import { describe, expect, it } from "vitest";
import { isToday, shortDate } from "./advanced";

describe("dates on the token list", () => {
  it("reads a day as 12 Nov 2026 in the UK style the frames use", () => {
    expect(shortDate("2026-11-12T12:00:00Z", { locale: "en-GB", timeZone: "UTC" })).toBe("12 Nov 2026");
  });
  it("tells today from another day using the local calendar", () => {
    const now = new Date(2026, 10, 21, 15, 0);
    expect(isToday(new Date(2026, 10, 21, 8, 41).toISOString(), now)).toBe(true);
    expect(isToday(new Date(2026, 10, 20, 23, 59).toISOString(), now)).toBe(false);
  });
});
