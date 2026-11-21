import { describe, expect, it } from "vitest";
import { clock, dayLabel, daySlots, dayWindow, isTaken, nextDay } from "./slots";

const at = (iso: string) => new Date(iso);
const MANILA = "Asia/Manila";
// 2027-01-20 is a Wednesday. 09:00 in Manila is 01:00 UTC.
const NOW_BEFORE = at("2027-01-01T00:00:00Z").getTime();

describe("clock", () => {
  it("writes a 12 hour time", () => {
    expect(clock(0)).toBe("12:00 am");
    expect(clock(9 * 60)).toBe("9:00 am");
    expect(clock(12 * 60 + 30)).toBe("12:30 pm");
    expect(clock(16 * 60)).toBe("4:00 pm");
  });
});

describe("daySlots", () => {
  it("lists the hourly starts from 9 am to 4 pm in the field's zone", () => {
    const slots = daySlots({ date: "2027-01-20", timezone: MANILA, slotMinutes: 60, busy: [], now: NOW_BEFORE });
    expect(slots.map((s) => s.label)).toEqual(["9:00 am", "10:00 am", "11:00 am", "12:00 pm", "1:00 pm", "2:00 pm", "3:00 pm", "4:00 pm"]);
    expect(slots[0]).toEqual({ value: "2027-01-20T09:00", label: "9:00 am", taken: false });
    expect(slots.every((s) => !s.taken)).toBe(true);
  });

  it("marks a slot taken when any booking overlaps it, and not when one only touches it", () => {
    const busy = [{ start: at("2027-01-20T02:30:00Z"), end: at("2027-01-20T03:30:00Z") }]; // 10:30 to 11:30 in Manila
    const slots = daySlots({ date: "2027-01-20", timezone: MANILA, slotMinutes: 60, busy, now: NOW_BEFORE });
    expect(slots.filter((s) => s.taken).map((s) => s.label)).toEqual(["10:00 am", "11:00 am"]);
    const touching = [{ start: at("2027-01-20T02:00:00Z"), end: at("2027-01-20T03:00:00Z") }]; // exactly 10:00 to 11:00
    expect(daySlots({ date: "2027-01-20", timezone: MANILA, slotMinutes: 60, busy: touching, now: NOW_BEFORE }).filter((s) => s.taken).map((s) => s.label)).toEqual(["10:00 am"]);
  });

  it("marks slots that have already started as taken", () => {
    const now = at("2027-01-20T04:10:00Z").getTime(); // 12:10 pm in Manila
    const slots = daySlots({ date: "2027-01-20", timezone: MANILA, slotMinutes: 60, busy: [], now });
    expect(slots.filter((s) => !s.taken).map((s) => s.label)).toEqual(["1:00 pm", "2:00 pm", "3:00 pm", "4:00 pm"]);
  });

  it("follows a 45 minute grid counted from midnight and stops before the closing time", () => {
    const labels = daySlots({ date: "2027-01-20", timezone: MANILA, slotMinutes: 45, busy: [], now: NOW_BEFORE }).map((s) => s.label);
    expect(labels[0]).toBe("9:00 am");
    expect(labels[1]).toBe("9:45 am");
    expect(labels.at(-1)).toBe("3:45 pm");
  });
});

describe("isTaken", () => {
  const busy = [{ start: at("2027-01-20T02:00:00Z"), end: at("2027-01-20T03:00:00Z") }];
  it("is true for a start inside a booking or a slot that runs into one", () => {
    expect(isTaken(at("2027-01-20T02:00:00Z"), 60, busy)).toBe(true);
    expect(isTaken(at("2027-01-20T01:30:00Z"), 60, busy)).toBe(true);
  });
  it("is false for a neighbouring slot", () => {
    expect(isTaken(at("2027-01-20T03:00:00Z"), 60, busy)).toBe(false);
    expect(isTaken(at("2027-01-20T01:00:00Z"), 60, busy)).toBe(false);
  });
});

describe("dates", () => {
  it("gives the next day across a month end and the window of a day in the zone", () => {
    expect(nextDay("2027-01-31")).toBe("2027-02-01");
    const w = dayWindow("2027-01-20", MANILA);
    expect(w.from.toISOString()).toBe("2027-01-19T16:00:00.000Z");
    expect(w.to.toISOString()).toBe("2027-01-20T16:00:00.000Z");
  });
  it("labels a day in English and Tagalog", () => {
    expect(dayLabel("2027-01-20", MANILA, "en")).toBe("Wed, 20 Jan");
    expect(dayLabel("2027-01-20", MANILA, "tl")).toMatch(/20/);
  });
});
