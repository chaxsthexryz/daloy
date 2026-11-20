import { describe, expect, it } from "vitest";
import { clock, longDate, startedAt } from "./activity";
import { activityTranslations } from "./locale-activity";

// Local-time constructors keep these independent of the machine's time zone.
const now = new Date(2026, 10, 20, 15, 0).getTime();

describe("startedAt", () => {
  it("says Today or Yesterday with the time, as the Activity frames do", () => {
    expect(startedAt(new Date(2026, 10, 20, 10, 42).toISOString(), now)).toBe("Today, 10:42 AM");
    expect(startedAt(new Date(2026, 10, 19, 16, 34).toISOString(), now)).toBe("Yesterday, 4:34 PM");
    expect(startedAt(new Date(2026, 10, 20, 0, 5).toISOString(), now)).toBe("Today, 12:05 AM");
  });
  it("gives the short date for anything older, and the year only when it differs", () => {
    expect(startedAt(new Date(2026, 10, 16, 9, 12).toISOString(), now)).toBe("Nov 16, 9:12 AM");
    expect(startedAt(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe("Dec 31, 2025, 11:59 PM");
  });
  it("speaks Tagalog for the day words", () => {
    expect(startedAt(new Date(2026, 10, 20, 10, 42).toISOString(), now, "tl")).toBe("Ngayon, 10:42 AM");
    expect(startedAt(new Date(2026, 10, 19, 16, 34).toISOString(), now, "tl")).toBe("Kahapon, 4:34 PM");
  });
  it("treats a time later today (clock skew) as today", () => {
    expect(startedAt(new Date(2026, 10, 20, 15, 1).toISOString(), now)).toBe("Today, 3:01 PM");
  });
});

describe("Activity wording in Tagalog", () => {
  it("keeps every braced value of the English text", () => {
    const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [en, tl] of Object.entries(activityTranslations)) expect(names(tl), en).toEqual(names(en));
  });
});

describe("clock and longDate", () => {
  it("formats with plain spaces, so text matches what people type and tests read", () => {
    expect(clock(new Date(2026, 10, 20, 10, 42, 3).toISOString())).toBe("10:42 AM");
    expect(clock(new Date(2026, 10, 20, 10, 42, 3).toISOString(), true)).toBe("10:42:03 AM");
    expect(longDate(now)).toBe("Friday, 20 November 2026");
    expect(longDate(new Date(2026, 10, 17).getTime())).toBe("Tuesday, 17 November 2026");
  });
});
