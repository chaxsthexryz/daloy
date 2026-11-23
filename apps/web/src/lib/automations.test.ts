import { describe, expect, it } from "vitest";
import { arrange, counts, displayStatus, triggerLabel, withTrigger } from "./automations";

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
  it("puts Needs you, then Problem, first and keeps the rest in order, drafts included as rows", () => {
    expect(ids(arrange(LIST, "", "all").shown)).toEqual(["review", "problem", "done", "off", "draft", "wait"]);
  });
  it("filters by plain state, and Off means not on and not a draft", () => {
    expect(ids(arrange(LIST, "", "needs_you").shown)).toEqual(["review"]);
    expect(ids(arrange(LIST, "", "problem").shown)).toEqual(["problem"]);
    expect(ids(arrange(LIST, "", "waiting").shown)).toEqual(["wait"]);
    expect(ids(arrange(LIST, "", "off").shown)).toEqual(["off"]);
  });
  it("filters by on, paused, off and draft with one status per automation", () => {
    const list = [...LIST, { id: "paused", name: "Weekly summary", createdAt: "10", live: true, pausedAt: "2026-11-18T01:00:00Z", last: null }];
    expect(ids(arrange(list, "", "on").shown)).toEqual(["review", "problem", "done", "wait"]);
    expect(ids(arrange(list, "", "paused").shown)).toEqual(["paused"]);
    expect(ids(arrange(list, "", "off").shown)).toEqual(["off"]);
    expect(ids(arrange(list, "", "draft").shown)).toEqual(["draft"]);
  });
  it("lists a paused automation under Paused, not under the state of its last run (N11b)", () => {
    const list = [...LIST, { id: "paused", name: "Weekly summary", createdAt: "10", live: true, pausedAt: "2026-11-18T01:00:00Z", last: last("failed") }];
    expect(ids(arrange(list, "", "paused").shown)).toEqual(["paused"]);
    expect(ids(arrange(list, "", "problem").shown)).toEqual(["problem"]);
    expect(ids(arrange(list, "", "all").shown)).toContain("paused");
    // A run in review is still waiting for a person, paused or not.
    const held = [{ id: "held", name: "Orders", createdAt: "11", live: true, pausedAt: "2026-11-18T01:00:00Z", last: last("running", true) }];
    expect(ids(arrange(held, "", "needs_you").shown)).toEqual(["held"]);
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
    expect(ids(arrange(LIST, "office", "all").shown)).toEqual(["draft"]);
    expect(arrange(LIST, "nothing like this", "all").shown).toEqual([]);
  });
});

describe("counts", () => {
  const list = [
    ...LIST,
    { id: "paused", name: "Weekly summary", createdAt: "10", live: true, pausedAt: "2026-11-18T01:00:00Z", last: last("failed") },
    { id: "held", name: "Held orders", createdAt: "11", live: true, pausedAt: "2026-11-18T01:00:00Z", last: last("running", true) },
    { id: "missed", name: "Morning report", createdAt: "12", live: true, scheduleMissedAt: MISSED, last: last("succeeded") },
  ];
  it("matches what each filter shows, so a tile never disagrees with its list", () => {
    const c = counts(list);
    for (const f of ["needs_you", "problem", "waiting", "on", "paused", "off", "draft"] as const) expect(c[f]).toBe(arrange(list, "", f).shown.length);
    expect(c.total).toBe(list.length);
  });
  it("counts each automation under one status and a paused run in review under Needs you", () => {
    const c = counts(list);
    expect(c.on + c.paused + c.off + c.draft).toBe(c.total);
    expect(c).toMatchObject({ needs_you: 2, problem: 2, paused: 2, draft: 1, off: 1, on: 5 });
  });
  it("is all zeros for an empty list", () => {
    expect(counts([])).toMatchObject({ total: 0, on: 0, paused: 0, off: 0, draft: 0, needs_you: 0, problem: 0, waiting: 0 });
  });
});

describe("trigger label and filter", () => {
  it("names the trigger in a word or two and falls back to the raw type", () => {
    expect(triggerLabel("form")).toBe("Form");
    expect(triggerLabel("email")).toBe("Email in");
    expect(triggerLabel("schedule")).toBe("Schedule");
    expect(triggerLabel("webhook")).toBe("Webhook");
    expect(triggerLabel("manual")).toBe("Manual");
    expect(triggerLabel("something_new")).toBe("something_new");
    expect(triggerLabel(undefined)).toBe("");
  });
  it("narrows by the loaded trigger type", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const of = { a: "form", b: "schedule" };
    expect(ids(withTrigger(rows, "any", of))).toEqual(["a", "b", "c"]);
    expect(ids(withTrigger(rows, "form", of))).toEqual(["a"]);
    expect(ids(withTrigger(rows, "email", of))).toEqual([]);
  });
});

describe("displayStatus", () => {
  it("reports Problem for a live workflow whose last run failed or missed its schedule", () => {
    expect(displayStatus({ id: "p", name: "Broken", createdAt: "1", live: true, last: last("failed") }, 0)).toEqual({
      tone: "problem",
      label: "Problem",
    });
    expect(displayStatus({ id: "m", name: "Late", createdAt: "1", live: true, scheduleMissedAt: MISSED, last: last("succeeded") }, 0)).toEqual({
      tone: "problem",
      label: "Problem",
    });
  });

  it("prioritizes Needs you when a review is open or the last run needs attention", () => {
    expect(displayStatus({ id: "r", name: "Orders", createdAt: "1", live: true, last: last("succeeded") }, 2)).toEqual({
      tone: "needs",
      label: "Needs you",
    });
    expect(displayStatus({ id: "r2", name: "Orders", createdAt: "1", live: true, last: last("running", true) }, 0)).toEqual({
      tone: "needs",
      label: "Needs you",
    });
    expect(displayStatus({ id: "hp", name: "Held", createdAt: "1", live: true, pausedAt: "2026-11-18T01:00:00Z", last: last("running", true) }, 1)).toEqual({
      tone: "needs",
      label: "Needs you",
    });
  });

  it("maps paused, draft, off, and healthy live workflows consistently", () => {
    expect(displayStatus({ id: "pa", name: "Paused", createdAt: "1", live: true, pausedAt: "2026-11-18T01:00:00Z", last: last("failed") }, 0)).toEqual({
      tone: "paused",
      label: "Paused",
    });
    expect(displayStatus({ id: "dr", name: "Draft", createdAt: "1", live: false, setup: { step: "name" }, last: null }, 0)).toEqual({
      tone: "draft",
      label: "Draft",
    });
    expect(displayStatus({ id: "of", name: "Off", createdAt: "1", live: false, last: null }, 0)).toEqual({
      tone: "off",
      label: "Off",
    });
    expect(displayStatus({ id: "ok", name: "Healthy", createdAt: "1", live: true, last: last("succeeded") }, 0)).toEqual({
      tone: "on",
      label: "On",
    });
  });
});
