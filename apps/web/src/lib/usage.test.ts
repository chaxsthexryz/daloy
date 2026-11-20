import { describe, expect, it } from "vitest";
import type { Usage } from "../api";
import { day, usageLines } from "./usage";

const usage = (ai: number, live = 1, sms = { used: 0, limit: 50, resetsOn: "2026-12-17" }): Usage => ({
  plan: "pilot",
  label: "Pilot",
  limits: {},
  ai: { used: ai, limit: 500, resetsOn: "2026-12-17" },
  sms,
  email: { used: 0, limit: 100, resetsOn: "2026-11-18" },
  http: { used: 0, limit: null, resetsOn: "2026-11-18" },
  automations: { live, limit: 5 },
  minScheduleMinutes: 15,
});

describe("usageLines", () => {
  it("formats the day", () => expect(day("2026-12-07")).toBe("7 December"));
  it("is quiet below 80%", () => expect(usageLines(usage(399))).toEqual([]));
  it("stays quiet for preview sms limit 0", () => expect(usageLines(usage(0, 1, { used: 0, limit: 0, resetsOn: "2026-12-17" }))).toEqual([]));
  it("warns at 80% for sms", () => expect(usageLines(usage(0, 1, { used: 40, limit: 50, resetsOn: "2026-12-17" }))).toEqual(["You have used 40 of 50 SMS messages. They come back on 17 December."]));
  it("warns at 80%", () => expect(usageLines(usage(410))).toEqual(["You have used 410 of 500 AI actions. They come back on 17 December."]));
  it("says what stopped at 100%", () =>
    expect(usageLines(usage(500))).toEqual(["AI actions are used up until 17 December. Steps that need AI stop, and you can press Retry on those runs then."]));
  it("reports the automation limit", () => expect(usageLines(usage(0, 5))).toEqual(["You have 5 of 5 live automations. Publishing another needs a larger plan."]));
});
