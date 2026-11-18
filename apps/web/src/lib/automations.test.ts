import { describe, expect, it } from "vitest";
import { arrange } from "./automations";

const last = (state: string, needsReview = false) => ({ runId: "r", state, createdAt: "2026-11-17T00:00:00Z", needsReview, deliveryFailed: false, superseded: false, reference: null });
const LIST = [
  { id: "done", name: "Contact form", createdAt: "1", live: true, last: last("succeeded") },
  { id: "off", name: "Invoice follow-up", createdAt: "2", live: false, last: null },
  { id: "problem", name: "Lead triage", createdAt: "3", live: true, last: last("failed") },
  { id: "draft", name: "Office requests", createdAt: "4", live: false, setup: { step: "name" }, last: null },
  { id: "review", name: "Orders", createdAt: "5", live: true, last: last("running", true) },
  { id: "wait", name: "Booking reminder", createdAt: "6", live: true, last: last("waiting") },
];
const MISSED = "2026-11-17T09:20:00Z";
const ids = (l: { id: string }[]) => l.map((w) => w.id);

describe("arrange", () => {
  it("puts Needs you, then Problem, first and keeps the rest in order, with drafts apart", () => {
    const { shown, drafts } = arrange(LIST, "", "all");
    expect(ids(shown)).toEqual(["review", "problem", "done", "off", "wait"]);
    expect(ids(drafts)).toEqual(["draft"]);
  });
  it("filters by plain state, and Off means not on and not a draft", () => {
    expect(ids(arrange(LIST, "", "needs_you").shown)).toEqual(["review"]);
    expect(ids(arrange(LIST, "", "problem").shown)).toEqual(["problem"]);
    expect(ids(arrange(LIST, "", "waiting").shown)).toEqual(["wait"]);
    expect(ids(arrange(LIST, "", "off").shown)).toEqual(["off"]);
  });
  it("treats a missed schedule as a problem, unless the last run needs a person", () => {
    const list = [
      { id: "missed", name: "Morning report", createdAt: "7", live: true, scheduleMissedAt: MISSED, last: last("succeeded") },
      { id: "missed_review", name: "Orders by hand", createdAt: "8", live: true, scheduleMissedAt: MISSED, last: last("running", true) },
      { id: "fine", name: "Weekly summary", createdAt: "9", live: true, scheduleMissedAt: null, last: last("succeeded") },
    ];
    expect(ids(arrange(list, "", "all").shown)).toEqual(["missed_review", "missed", "fine"]);
    expect(ids(arrange(list, "", "problem").shown)).toEqual(["missed"]);
  });
  it("searches names, ignoring case and spaces around, in the list and the drafts", () => {
    expect(ids(arrange(LIST, "  ORDER ", "all").shown)).toEqual(["review"]);
    expect(ids(arrange(LIST, "office", "all").drafts)).toEqual(["draft"]);
    expect(arrange(LIST, "nothing like this", "all")).toEqual({ shown: [], drafts: [] });
  });
});
