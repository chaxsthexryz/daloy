import { describe, expect, it } from "vitest";
import { isTimeZone, parseInstant, parseZoned } from "./zoned";

const now = Date.UTC(2026, 0, 1);
const ok = (input: string, timezone: string, slotMinutes?: number) => {
  const r = parseZoned(input, { timezone, slotMinutes }, now);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const error = (input: string, timezone: string, slotMinutes?: number) => {
  const r = parseZoned(input, { timezone, slotMinutes }, now);
  return r.ok ? `accepted as ${r.value}` : r.error;
};

describe("parseZoned: wall time in the field's zone", () => {
  it("reads a datetime-local value as local time and stores it with the zone's offset", () => {
    expect(ok("2027-01-20T14:00", "Asia/Manila")).toBe("2027-01-20T14:00:00+08:00");
    expect(ok("2027-01-20T14:00:00", "Asia/Manila")).toBe("2027-01-20T14:00:00+08:00");
    expect(ok("2027-07-01T09:30", "UTC")).toBe("2027-07-01T09:30:00+00:00");
    expect(ok("2027-01-20T14:00", "Asia/Kathmandu")).toBe("2027-01-20T14:00:00+05:45");
  });

  it("uses the offset in force on that day, on both sides of a change", () => {
    expect(ok("2027-03-13T12:00", "America/New_York")).toBe("2027-03-13T12:00:00-05:00");
    expect(ok("2027-03-14T12:00", "America/New_York")).toBe("2027-03-14T12:00:00-04:00");
    expect(ok("2027-03-28T03:00", "Europe/London")).toBe("2027-03-28T03:00:00+01:00");
    expect(ok("2027-03-28T00:30", "Europe/London")).toBe("2027-03-28T00:30:00+00:00");
  });

  it("refuses a time the clocks skip (spring forward), naming the zone", () => {
    expect(error("2027-03-14T02:30", "America/New_York")).toBe("does not exist in America/New_York (the clocks skip it)");
    expect(error("2027-03-28T01:30", "Europe/London")).toBe("does not exist in Europe/London (the clocks skip it)");
    // Lord Howe moves by 30 minutes: 02:00 becomes 02:30.
    expect(error("2027-10-03T02:15", "Australia/Lord_Howe")).toBe("does not exist in Australia/Lord_Howe (the clocks skip it)");
    expect(ok("2027-10-03T02:30", "Australia/Lord_Howe")).toBe("2027-10-03T02:30:00+11:00");
    expect(ok("2027-03-14T03:00", "America/New_York")).toBe("2027-03-14T03:00:00-04:00");
  });

  it("refuses a time that happens twice (fall back) unless an offset says which", () => {
    expect(error("2027-11-07T01:30", "America/New_York")).toBe("happens twice in America/New_York (the clocks go back); send it with its offset, like 2027-11-07T01:30-04:00");
    expect(error("2027-10-31T01:30", "Europe/London")).toBe("happens twice in Europe/London (the clocks go back); send it with its offset, like 2027-10-31T01:30+01:00");
    // Lord Howe: 02:00 becomes 01:30, so 01:30 to 01:59 happen twice.
    expect(error("2027-04-04T01:45", "Australia/Lord_Howe")).toMatch(/^happens twice in Australia\/Lord_Howe/);
    expect(ok("2027-11-07T01:30-04:00", "America/New_York")).toBe("2027-11-07T01:30:00-04:00");
    expect(ok("2027-11-07T01:30-05:00", "America/New_York")).toBe("2027-11-07T01:30:00-05:00");
    expect(ok("2027-11-07T00:59", "America/New_York")).toBe("2027-11-07T00:59:00-04:00");
    expect(ok("2027-11-07T02:00", "America/New_York")).toBe("2027-11-07T02:00:00-05:00");
  });

  it("refuses dates and times that are not real", () => {
    for (const bad of ["2027-01-20T32:00", "2027-02-30T10:00", "2027-13-01T10:00", "2027-01-20T10:60", "2027-01-20T24:00"]) {
      expect(error(bad, "Asia/Manila"), bad).toBe("is not a real date and time");
    }
  });

  it("refuses text that is not a date and time", () => {
    for (const bad of ["tomorrow", "2027-01-20", "2027-01-20 14:00", "20/01/2027 14:00", "2027-01-20T14:00+8", ""]) {
      expect(error(bad, "Asia/Manila"), bad).toBe("must be a date and time like 2027-01-20T14:00");
    }
  });
});

describe("parseZoned: offset-bearing input", () => {
  it("converts the instant to the field's zone before storing it", () => {
    expect(ok("2027-01-20T06:00:00Z", "Asia/Manila")).toBe("2027-01-20T14:00:00+08:00");
    expect(ok("2027-01-20T14:00+08:00", "Asia/Manila")).toBe("2027-01-20T14:00:00+08:00");
    expect(ok("2027-01-20T01:00:00-05:00", "Asia/Manila")).toBe("2027-01-20T14:00:00+08:00");
  });

  it("applies the slot grid in the field's zone, not the sender's", () => {
    // 14:00 in Kathmandu is 16:15 in Manila.
    expect(error("2027-01-20T14:00+05:45", "Asia/Manila", 60)).toBe("must start on a 60-minute slot, counted from midnight in Asia/Manila");
    expect(ok("2027-01-20T06:00Z", "Asia/Manila", 60)).toBe("2027-01-20T14:00:00+08:00");
  });

  it("refuses an offset that is not a real one", () => {
    expect(error("2027-01-20T14:00+25:00", "Asia/Manila")).toBe("is not a real date and time");
  });
});

describe("parseZoned: future and slot rules", () => {
  it("accepts only times after now", () => {
    expect(error("2025-12-31T23:59", "UTC")).toBe("must be in the future");
    expect(error("2026-01-01T00:00", "UTC")).toBe("must be in the future");
    expect(ok("2026-01-01T00:01", "UTC")).toBe("2026-01-01T00:01:00+00:00");
    // Midnight UTC is already 08:00 in Manila, so 07:00 local on 1 January has passed.
    expect(error("2026-01-01T07:00", "Asia/Manila")).toBe("must be in the future");
  });

  it("keeps times on the slot grid counted from local midnight", () => {
    expect(ok("2027-01-20T14:00", "Asia/Manila", 60)).toBe("2027-01-20T14:00:00+08:00");
    expect(error("2027-01-20T14:30", "Asia/Manila", 60)).toBe("must start on a 60-minute slot, counted from midnight in Asia/Manila");
    expect(ok("2027-01-20T14:30", "Asia/Manila", 30)).toBe("2027-01-20T14:30:00+08:00");
    expect(ok("2027-01-20T00:45", "Asia/Manila", 45)).toBe("2027-01-20T00:45:00+08:00");
    expect(error("2027-01-20T00:50", "Asia/Manila", 45)).toMatch(/45-minute slot/);
  });

  it("keeps the grid on wall-clock time on a day the clocks change", () => {
    expect(ok("2027-03-14T03:00", "America/New_York", 60)).toBe("2027-03-14T03:00:00-04:00");
    expect(ok("2027-10-03T03:00", "Australia/Lord_Howe", 60)).toBe("2027-10-03T03:00:00+11:00");
  });

  it("needs a whole minute", () => {
    expect(error("2027-01-20T14:00:30", "Asia/Manila")).toBe("must be on a whole minute");
    expect(error("2027-01-20T06:00:00.500Z", "Asia/Manila")).toBe("must be on a whole minute");
    // What toISOString() sends.
    expect(ok("2027-01-20T06:00:00.000Z", "Asia/Manila")).toBe("2027-01-20T14:00:00+08:00");
  });
});

describe("isTimeZone", () => {
  it("accepts IANA names and UTC", () => {
    for (const tz of ["Asia/Manila", "America/New_York", "Australia/Lord_Howe", "America/Argentina/Buenos_Aires", "UTC"]) expect(isTimeZone(tz), tz).toBe(true);
  });
  it("refuses offsets, abbreviations and unknown names", () => {
    for (const tz of ["+08:00", "PST", "Mars/Olympus", "", "Asia/Manila\n", "local"]) expect(isTimeZone(tz), tz).toBe(false);
  });
});

describe("parseInstant", () => {
  it("reads ISO times with an offset or Z", () => {
    expect(parseInstant("2027-01-20T14:00:00+08:00")?.toISOString()).toBe("2027-01-20T06:00:00.000Z");
    expect(parseInstant("2027-01-20T06:00:00.000Z")?.toISOString()).toBe("2027-01-20T06:00:00.000Z");
    expect(parseInstant("2027-01-20T06:00Z")?.toISOString()).toBe("2027-01-20T06:00:00.000Z");
  });
  it("refuses times without an offset, since the server's zone would decide them", () => {
    for (const bad of ["2027-01-20T14:00", "2027-01-20", "soon", "2027-02-30T10:00:00Z", "2027-01-20T25:00:00Z", ""]) expect(parseInstant(bad), bad).toBeUndefined();
  });
});
