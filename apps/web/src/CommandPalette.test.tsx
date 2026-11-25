import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CommandPalette,
  filterQuickJump,
  isQuickJumpShortcut,
  quickJumpItems,
  stepQuickJumpIndex,
} from "./CommandPalette";

const id = (text: string) => text;

describe("quickJumpItems", () => {
  it("lists 13 console pages for regular owners and adds Advanced for admins", () => {
    const items = quickJumpItems("owner", id);
    expect(items.map((item) => item.href)).toEqual([
      "#/",
      "#/activity",
      "#/bookings",
      "#/conversations",
      "#/receipts",
      "#/knowledge",
      "#/new",
      "#/ai",
      "#/team",
      "#/apps",
      "#/settings/business",
      "#/settings",
      "#/account",
    ]);
    const adminItems = quickJumpItems("owner", id, true);
    expect(adminItems.map((item) => item.href)).toContain("#/advanced");
  });

  it("limits operators to their allowed 8 pages including conversations, receipts and knowledge", () => {
    const items = quickJumpItems("operator", id);
    expect(items.map((item) => item.href)).toEqual([
      "#/",
      "#/activity",
      "#/bookings",
      "#/conversations",
      "#/receipts",
      "#/knowledge",
      "#/settings",
      "#/account",
    ]);
  });

  it("limits approvers and requesters to 5 pages without receipts or knowledge", () => {
    for (const role of ["approver", "requester"] as const) {
      const items = quickJumpItems(role, id);
      expect(items.map((item) => item.href)).toEqual([
        "#/",
        "#/activity",
        "#/bookings",
        "#/settings",
        "#/account",
      ]);
    }
  });
});

describe("filterQuickJump", () => {
  const items = quickJumpItems("owner", id);

  it("returns all items when query is empty or whitespace", () => {
    expect(filterQuickJump(items, "")).toEqual(items);
    expect(filterQuickJump(items, "   ")).toEqual(items);
  });

  it("matches case-insensitively by label or group", () => {
    expect(filterQuickJump(items, "book").map((i) => i.href)).toEqual(["#/bookings"]);
    expect(filterQuickJump(items, "BUILD").map((i) => i.href)).toEqual(["#/new", "#/ai"]);
    expect(filterQuickJump(items, "nope")).toEqual([]);
  });
});

describe("stepQuickJumpIndex", () => {
  it("wraps forward and backward and handles empty lists", () => {
    expect(stepQuickJumpIndex(0, 1, 4)).toBe(1);
    expect(stepQuickJumpIndex(3, 1, 4)).toBe(0);
    expect(stepQuickJumpIndex(0, -1, 4)).toBe(3);
    expect(stepQuickJumpIndex(2, -1, 4)).toBe(1);
    expect(stepQuickJumpIndex(2, 1, 0)).toBe(0);
  });
});

describe("isQuickJumpShortcut", () => {
  it("matches Ctrl+K and Cmd+K only without Alt or Shift", () => {
    expect(isQuickJumpShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(isQuickJumpShortcut({ key: "K", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe(true);
    expect(isQuickJumpShortcut({ key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
    expect(isQuickJumpShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false })).toBe(false);
    expect(isQuickJumpShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(false);
    expect(isQuickJumpShortcut({ key: "b", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
  });
});

describe("CommandPalette markup", () => {
  it("renders nothing when closed and a modal dialog with role-scoped items when open", () => {
    expect(renderToStaticMarkup(
      <CommandPalette open={false} role="owner" currentHash="#/" onClose={() => undefined} />,
    )).toBe("");

    const ownerHtml = renderToStaticMarkup(
      <CommandPalette open={true} role="owner" currentHash="#/" onClose={() => undefined} />,
    );
    expect(ownerHtml).toContain('role="dialog"');
    expect(ownerHtml).toContain('aria-modal="true"');
    expect(ownerHtml).toContain('href="#/team"');
    expect(ownerHtml).toContain('href="#/ai"');

    const operatorHtml = renderToStaticMarkup(
      <CommandPalette open={true} role="operator" currentHash="#/bookings" onClose={() => undefined} />,
    );
    expect(operatorHtml).toContain('href="#/bookings"');
    expect(operatorHtml).not.toContain('href="#/team"');
    expect(operatorHtml).not.toContain('href="#/ai"');
  });
});
