import { describe, expect, it } from "vitest";
import { addNotice, ageText, MAX_NOTICES, noticeHref, noticeText, noticeToast, parseEvent, unreadCount, type LiveEvent } from "./live-events";
import { translate } from "./locale";

const id = "11111111-1111-4111-8111-111111111111";
const ev = (kind: LiveEvent["kind"], title = "Booking confirmation"): LiveEvent => ({ kind, id, title, at: "2026-11-28T10:00:00.000Z" });
const en = (s: string, v?: Record<string, string | number>) => translate("en", s, v);
const tl = (s: string, v?: Record<string, string | number>) => translate("tl", s, v);

describe("parseEvent", () => {
  it("reads a good event and refuses anything else", () => {
    expect(parseEvent(JSON.stringify(ev("run_failed")))).toEqual(ev("run_failed"));
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent(JSON.stringify({ ...ev("run_failed"), kind: "other" }))).toBeNull();
    expect(parseEvent(JSON.stringify({ kind: "run_failed" }))).toBeNull();
  });
});

describe("the list", () => {
  it("puts the newest first, keeps 20, and counts unread", () => {
    let list = addNotice([], ev("run_failed"), "k0");
    for (let i = 1; i < 25; i++) list = addNotice(list, ev("conversation_new"), `k${i}`);
    expect(list).toHaveLength(MAX_NOTICES);
    expect(list[0]!.key).toBe("k24");
    expect(unreadCount(list)).toBe(20);
    expect(unreadCount(list.map((n) => ({ ...n, unread: false })))).toBe(0);
  });
});

describe("links", () => {
  it("a run links to its log and a conversation to the conversations page", () => {
    expect(noticeHref(ev("run_succeeded"))).toBe(`#/runs/${id}`);
    expect(noticeHref(ev("run_failed"))).toBe(`#/runs/${id}`);
    expect(noticeHref(ev("conversation_new"))).toBe(`#/conversations?c=${id}`);
    expect(noticeHref(ev("handoff_requested"))).toBe(`#/conversations?c=${id}`);
  });
});

describe("text", () => {
  it("names the automation for runs and the channel for chats, in English and Taglish", () => {
    expect(noticeText(ev("run_failed"), en).title).toBe("Booking confirmation failed");
    expect(noticeText(ev("run_succeeded"), en).title).toBe("Booking confirmation ran and succeeded");
    expect(noticeText(ev("conversation_new", "Messenger"), en).title).toBe("New chat on Messenger");
    expect(noticeText(ev("handoff_requested", "Messenger"), en).title).toBe("A guest asked for a person on Messenger");
    expect(noticeText(ev("handoff_requested", "Messenger"), tl).title).not.toBe("A guest asked for a person on Messenger");
    expect(noticeText(ev("run_failed"), tl).title).toBe("Nabigo ang Booking confirmation");
  });
});

describe("toasts", () => {
  it("shows a toast for a handoff and a failure only", () => {
    expect(noticeToast(ev("handoff_requested", "Telegram"), en)).toMatchObject({ tone: "warn", actionHref: `#/conversations?c=${id}` });
    expect(noticeToast(ev("run_failed"), en)).toMatchObject({ tone: "error", actionHref: `#/runs/${id}`, id: `live-run-${id}` });
    expect(noticeToast(ev("run_succeeded"), en)).toBeNull();
    expect(noticeToast(ev("conversation_new"), en)).toBeNull();
  });
});

describe("age", () => {
  it("reads just now, minutes, hours and days", () => {
    const now = Date.parse("2026-11-28T10:00:00.000Z");
    expect(ageText("2026-11-28T09:59:50.000Z", now, en)).toBe("Just now");
    expect(ageText("2026-11-28T09:55:00.000Z", now, en)).toBe("5 min ago");
    expect(ageText("2026-11-28T07:00:00.000Z", now, en)).toBe("3 hr ago");
    expect(ageText("2026-11-26T10:00:00.000Z", now, en)).toBe("2 days ago");
  });
});
