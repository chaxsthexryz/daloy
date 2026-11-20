import { describe, expect, it } from "vitest";
import { requestStatus, sentOn } from "./my-requests";

describe("requestStatus", () => {
  it("names each run state in words and picks the pill colour", () => {
    expect(requestStatus("succeeded")).toEqual({ label: "Succeeded", kind: "done" });
    expect(requestStatus("failed")).toEqual({ label: "Failed", kind: "problem" });
    expect(requestStatus("waiting")).toEqual({ label: "Waiting", kind: "working" });
    expect(requestStatus("needs_review")).toEqual({ label: "Needs review", kind: "working" });
    expect(requestStatus("pending")).toEqual({ label: "Received", kind: "idle" });
    expect(requestStatus("running")).toEqual({ label: "In progress", kind: "working" });
    expect(requestStatus("cancelled")).toEqual({ label: "Cancelled", kind: "idle" });
  });
  it("shows an unknown state as it came, so a new engine state is never blank", () => {
    expect(requestStatus("paused_for_audit")).toEqual({ label: "paused_for_audit", kind: "idle" });
  });
});

describe("sentOn", () => {
  it("shows the month, day and time without the year, in the person's language", () => {
    const at = new Date(2026, 10, 19, 14, 41).toISOString();
    expect(sentOn(at, "en")).toMatch(/^Nov 19, 2:41\sPM$/);
    expect(sentOn(at, "tl")).toContain("19");
  });
});
