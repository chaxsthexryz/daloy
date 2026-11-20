import { describe, expect, it } from "vitest";
import { ampm, byDay } from "./agenda";

describe("byDay", () => {
  it("groups bookings by their own local date and sorts days and times", () => {
    const list = [
      { id: "c", start: "2027-01-21T09:00:00+08:00" },
      { id: "b", start: "2027-01-20T14:00:00+08:00" },
      { id: "a", start: "2027-01-20T09:30:00+08:00" },
    ];
    expect(byDay(list)).toEqual([
      { day: "2027-01-20", items: [list[2], list[1]] },
      { day: "2027-01-21", items: [list[0]] },
    ]);
  });
  it("uses the booking's zoned date, not the viewer's, so 23:30 in Manila stays on that day", () => {
    expect(byDay([{ id: "x", start: "2027-01-20T23:30:00+08:00" }])[0]!.day).toBe("2027-01-20");
  });
  it("returns nothing for no bookings", () => {
    expect(byDay([])).toEqual([]);
  });
});

describe("ampm", () => {
  it("reads a 24-hour clock as the frame's 12-hour time", () => {
    expect(ampm("09:00")).toBe("9:00 AM");
    expect(ampm("12:30")).toBe("12:30 PM");
    expect(ampm("00:15")).toBe("12:15 AM");
    expect(ampm("14:00")).toBe("2:00 PM");
  });
});
