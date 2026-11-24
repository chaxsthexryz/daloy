import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "./knowledge";
import { DEFAULT_CHECK_IN_TIME, DEFAULT_CHECK_OUT_TIME, rescheduleStayRange, stayDraftFromFields, stayRange, stayTimesFromKnowledge } from "./stays";

const now = Date.UTC(2030, 0, 1);

describe("stayTimesFromKnowledge", () => {
  const entry = (id: string, kind: KnowledgeEntry["kind"], fields: KnowledgeEntry["fields"]): KnowledgeEntry => ({
    id,
    kind,
    title: id,
    body: "Info",
    fields,
  });

  it("defaults to 14:00 check-in and 12:00 check-out when no entry sets times", () => {
    expect(stayTimesFromKnowledge([])).toEqual({ checkInTime: DEFAULT_CHECK_IN_TIME, checkOutTime: DEFAULT_CHECK_OUT_TIME });
    expect(stayTimesFromKnowledge([entry("r1", "room", { price: 3500, unit: "night" })])).toEqual({ checkInTime: "14:00", checkOutTime: "12:00" });
  });

  it("prefers arrival entries over policy and room entries, filling missing sides with defaults", () => {
    const entries = [
      entry("room1", "room", { price: 3500, unit: "night", checkInTime: "16:00", checkOutTime: "10:00" }),
      entry("pol1", "policy", { checkInTime: "15:00", checkOutTime: "11:00" }),
      entry("arr1", "arrival", { checkInTime: "13:30" }),
    ];
    expect(stayTimesFromKnowledge(entries)).toEqual({ checkInTime: "13:30", checkOutTime: "11:00" });
    expect(stayTimesFromKnowledge([entries[0]!, entries[1]!])).toEqual({ checkInTime: "15:00", checkOutTime: "11:00" });
    expect(stayTimesFromKnowledge([entries[0]!])).toEqual({ checkInTime: "16:00", checkOutTime: "10:00" });
    expect(stayTimesFromKnowledge([entries[2]!])).toEqual({ checkInTime: "13:30", checkOutTime: "12:00" });
  });
});

describe("stayRange", () => {
  it("builds a multi-night stay in Asia/Manila with check-in and check-out times", () => {
    const r = stayRange({ checkIn: "2031-05-01", nights: 3, timezone: "Asia/Manila", checkInTime: "14:00", checkOutTime: "12:00" }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.startZoned).toBe("2031-05-01T14:00:00+08:00");
    expect(r.endZoned).toBe("2031-05-04T12:00:00+08:00");
    expect(r.checkIn).toBe("2031-05-01");
    expect(r.checkOut).toBe("2031-05-04");
    expect(r.nights).toBe(3);
    expect(r.start.toISOString()).toBe("2031-05-01T06:00:00.000Z");
    expect(r.end.toISOString()).toBe("2031-05-04T04:00:00.000Z");
  });

  it("allows same-day turnaround when check-out is before check-in", () => {
    const first = stayRange({ checkIn: "2031-05-01", nights: 3, timezone: "Asia/Manila" }, now);
    const next = stayRange({ checkIn: "2031-05-04", nights: 2, timezone: "Asia/Manila" }, now);
    expect(first.ok && next.ok).toBe(true);
    if (!first.ok || !next.ok) return;
    expect(first.end.getTime()).toBeLessThan(next.start.getTime());
  });

  it("keeps local wall clock times across a DST boundary", () => {
    // America/New_York springs forward on 2031-03-09.
    const r = stayRange({ checkIn: "2031-03-08", nights: 2, timezone: "America/New_York", checkInTime: "15:00", checkOutTime: "11:00" }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.startZoned).toBe("2031-03-08T15:00:00-05:00");
    expect(r.endZoned).toBe("2031-03-10T11:00:00-04:00");
  });

  it("refuses bad dates, out-of-range nights, past check-in, bad times and invalid zones", () => {
    expect(stayRange({ checkIn: "2031-02-30", nights: 2, timezone: "Asia/Manila" }, now).ok).toBe(false);
    expect(stayRange({ checkIn: "2031-05-01", nights: 0, timezone: "Asia/Manila" }, now).ok).toBe(false);
    expect(stayRange({ checkIn: "2031-05-01", nights: 31, timezone: "Asia/Manila" }, now).ok).toBe(false);
    expect(stayRange({ checkIn: "2029-12-31", nights: 2, timezone: "Asia/Manila" }, now).ok).toBe(false);
    expect(stayRange({ checkIn: "2031-05-01", nights: 2, timezone: "Asia/Manila", checkInTime: "25:00" }, now).ok).toBe(false);
    expect(stayRange({ checkIn: "2031-05-01", nights: 2, timezone: "Asia/Manila", checkOutTime: "noon" }, now).ok).toBe(false);
    expect(stayRange({ checkIn: "2031-05-01", nights: 2, timezone: "+08:00" }, now).ok).toBe(false);
  });
});

describe("rescheduleStayRange", () => {
  it("moves a stay by bare YYYY-MM-DD date while keeping nights and local check-in/check-out times", () => {
    const initial = stayRange({ checkIn: "2031-05-01", nights: 3, timezone: "Asia/Manila", checkInTime: "15:00", checkOutTime: "11:00" }, now);
    if (!initial.ok) throw new Error(initial.error);
    const moved = rescheduleStayRange({ start: initial.start, end: initial.end, nights: 3, timezone: "Asia/Manila" }, "2031-05-10", now);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.startZoned).toBe("2031-05-10T15:00:00+08:00");
    expect(moved.endZoned).toBe("2031-05-13T11:00:00+08:00");
    expect(moved.checkIn).toBe("2031-05-10");
    expect(moved.checkOut).toBe("2031-05-13");
    expect(moved.nights).toBe(3);
  });

  it("moves a stay by full datetime and still keeps nights and checkout wall time across DST", () => {
    const initial = stayRange({ checkIn: "2031-03-01", nights: 3, timezone: "America/New_York", checkInTime: "14:00", checkOutTime: "12:00" }, now);
    if (!initial.ok) throw new Error(initial.error);
    // Moving across the spring-forward night (2031-03-09) keeps 3 nights and 12:00 local checkout.
    const moved = rescheduleStayRange({ start: initial.start, end: initial.end, nights: 3, timezone: "America/New_York" }, "2031-03-08T14:00", now);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.startZoned).toBe("2031-03-08T14:00:00-05:00");
    expect(moved.endZoned).toBe("2031-03-11T12:00:00-04:00");
    expect(moved.nights).toBe(3);
  });
});

describe("stayDraftFromFields", () => {
  it("prefills checkIn and nights when conversation fields have valid check_in and check_out dates", () => {
    expect(stayDraftFromFields({ check_in: "2031-05-01", check_out: "2031-05-04", guests: "2" })).toEqual({ checkIn: "2031-05-01", nights: 3 });
    expect(stayDraftFromFields({ check_in: "2031-05-01" })).toEqual({ checkIn: "2031-05-01" });
    expect(stayDraftFromFields({ check_in: "2031-05-04", check_out: "2031-05-01" })).toEqual({ checkIn: "2031-05-04" });
    expect(stayDraftFromFields({ check_in: "next Friday", check_out: "2031-05-04" })).toEqual({});
  });
});
