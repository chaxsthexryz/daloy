import { describe, expect, it } from "vitest";
import { connectionProblem, createdSince, newRows, pollDelay, rowCells, rowKey, selfLoopProblem, startingSoon } from "./google-triggers";

// Decision 0127: the parts of the Google trigger poll that need no database or network.
const FILE = "https://www.googleapis.com/auth/drive.file";
const CAL = "https://www.googleapis.com/auth/calendar.app.created";
const oauth = (scopes: string | null, destination: Record<string, string> | null = { spreadsheetId: "s1", tab: "Orders" }) =>
  ({ status: "active" as const, authMethod: "oauth" as const, scopes, destination });

describe("connectionProblem", () => {
  it("is null for a working sign-in with the scope and a destination", () => {
    expect(connectionProblem("sheets_row", oauth(`openid email ${FILE}`))).toBeNull();
    expect(connectionProblem("calendar_event", oauth(`openid email ${CAL}`, { calendarId: "c@group.calendar.google.com", title: "Daloy bookings" }))).toBeNull();
  });
  it("says which app to connect when there is no connection", () => {
    expect(connectionProblem("drive_file", null)).toBe("Google Drive is not connected. Connect it in Apps.");
  });
  it("says which app to reconnect when Google stopped accepting the grant", () => {
    expect(connectionProblem("sheets_row", { ...oauth(FILE), status: "failed" })).toMatch(/^Google Sheets stopped accepting kymavo's access\. Reconnect Google Sheets in Apps\./);
  });
  it("names the missing permission for a narrower grant", () => {
    const p = connectionProblem("calendar_event", oauth("openid email", { calendarId: "c@x.y", title: "t" }));
    expect(p).toMatch(/^Reconnect Google Calendar in Apps/);
    expect(p).toContain("Make secondary Google calendars");
    // A Sheets grant that only holds Calendar's scope is narrower too.
    expect(connectionProblem("sheets_row", oauth(CAL))).toMatch(/^Reconnect Google Sheets in Apps/);
  });
  it("asks for the destination when none is chosen", () => {
    expect(connectionProblem("sheets_row", oauth(FILE, null))).toBe("Pick a sheet for Google Sheets in Apps.");
    expect(connectionProblem("drive_file", oauth(FILE, {}))).toBe("Pick a folder for Google Drive in Apps.");
    expect(connectionProblem("calendar_event", oauth(CAL, null))).toBe("Choose a calendar for Google Calendar in Apps.");
  });
  it("trusts a service account key's read instead of stored scopes", () => {
    expect(connectionProblem("sheets_row", { status: "active", authMethod: "service_account", scopes: null, destination: { spreadsheetId: "s", tab: "t" } })).toBeNull();
  });
});

describe("newRows (the Sheets cursor)", () => {
  const tab = [["Name", "Phone"], ["Ana", "0917"], ["Ben", "0918"]];
  it("first poll records the row count and starts nothing", () => {
    expect(newRows(null, tab)).toEqual({ cursor: { rows: 3 }, rows: [] });
  });
  it("returns only rows below the cursor, numbered as in the sheet", () => {
    const r = newRows({ rows: 2 }, tab);
    expect(r).toEqual({ cursor: { rows: 3 }, rows: [{ rowNumber: 3, values: ["Ben", "0918"] }] });
    expect(newRows(r.cursor, tab).rows).toEqual([]);
  });
  it("skips blank rows but moves past them", () => {
    expect(newRows({ rows: 1 }, [["Name"], [], ["Ana"]])).toEqual({ cursor: { rows: 3 }, rows: [{ rowNumber: 3, values: ["Ana"] }] });
  });
  it("takes at most max rows a poll and leaves the rest for the next", () => {
    const many = Array.from({ length: 10 }, (_, i) => [`r${i}`]);
    const first = newRows({ rows: 0 }, many, 4);
    expect(first.rows.map((r) => r.rowNumber)).toEqual([1, 2, 3, 4]);
    expect(newRows(first.cursor, many, 4).rows.map((r) => r.rowNumber)).toEqual([5, 6, 7, 8]);
  });
  it("a shorter tab (rows deleted) lowers the cursor and starts nothing", () => {
    expect(newRows({ rows: 5 }, tab)).toEqual({ cursor: { rows: 3 }, rows: [] });
  });
});

describe("rowKey and rowCells", () => {
  it("is stable for the same row and differs when a deleted row's place gets new values", () => {
    expect(rowKey("s1", "Orders", { rowNumber: 3, values: ["Ana"] })).toBe(rowKey("s1", "Orders", { rowNumber: 3, values: ["Ana"] }));
    expect(rowKey("s1", "Orders", { rowNumber: 3, values: ["Ana"] })).not.toBe(rowKey("s1", "Orders", { rowNumber: 3, values: ["Ben"] }));
    expect(rowKey("s1", "Orders", { rowNumber: 3, values: ["Ana"] })).toMatch(/^sheets:s1:Orders:3:[0-9a-f]{16}$/);
  });
  it("names cells after the header row, as template-safe keys", () => {
    expect(rowCells(["Customer Name", "Phone #", "", "2nd item", "Phone #"], ["Ana", "0917", "x", "y", "z"])).toEqual({ customer_name: "Ana", phone: "0917", c: "x", col_2nd_item: "y", phone_2: "z" });
  });
});

describe("createdSince (Calendar new events, Drive new files)", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  const items = [{ id: "a", at: "2026-11-24T09:58:00Z" }, { id: "b", at: "2026-11-24T09:40:00Z" }];
  it("first poll records the time and starts nothing", () => {
    expect(createdSince(null, items, now, false)).toEqual({ cursor: { since: "2026-11-24T10:00:00.000Z" }, fresh: [] });
  });
  it("keeps items created at or after the cursor and steps the cursor to two minutes before now", () => {
    const r = createdSince({ since: "2026-11-24T09:50:00.000Z" }, items, now, false);
    expect(r.fresh.map((i) => i.id)).toEqual(["a"]);
    expect(r.cursor).toEqual({ since: "2026-11-24T09:58:00.000Z" });
  });
  it("never moves the cursor back", () => {
    expect(createdSince({ since: "2026-11-24T09:59:30.000Z" }, [], now, false).cursor).toEqual({ since: "2026-11-24T09:59:30.000Z" });
  });
  it("with more pages left, moves only to the last item read so the rest come next poll", () => {
    const r = createdSince({ since: "2026-11-24T09:00:00.000Z" }, [items[1]!, items[0]!], now, true);
    expect(r.cursor).toEqual({ since: "2026-11-24T09:58:00.000Z" });
  });
});

describe("startingSoon (Calendar events about to start)", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  const ev = (id: string, start: string, status = "confirmed") => ({ id, status, start: { dateTime: start } });
  it("first poll records the time, so an event already inside the window does not remind", () => {
    expect(startingSoon(null, [ev("a", "2026-11-24T10:30:00Z")], now, 60)).toEqual({ cursor: { since: "2026-11-24T10:00:00.000Z" }, due: [] });
  });
  it("reminds for an event whose reminder time passed since the cursor and that has not started", () => {
    const cursor = { since: "2026-11-24T09:00:00.000Z" };
    const events = [ev("soon", "2026-11-24T10:30:00Z"), ev("later", "2026-11-24T11:30:00Z"), ev("gone", "2026-11-24T10:20:00Z", "cancelled"), ev("old", "2026-11-24T09:59:00Z"), { id: "allday", status: "confirmed", start: { date: "2026-11-24" } }];
    const r = startingSoon(cursor, events, now, 60);
    expect(r.due.map((e) => e.id)).toEqual(["soon"]);
    expect(r.due[0]!.start).toBe("2026-11-24T10:30:00.000Z");
    expect(r.cursor).toEqual(cursor);
  });
  it("does not remind for an event whose reminder time was before the cursor", () => {
    expect(startingSoon({ since: "2026-11-24T09:45:00.000Z" }, [ev("a", "2026-11-24T10:30:00Z")], now, 60).due).toEqual([]);
  });
});

describe("pollDelay", () => {
  it("is 5 minutes, or the plan's minimum schedule interval when longer", () => {
    expect(pollDelay(0, undefined, null)).toBe(5 * 60_000);
    expect(pollDelay(0, undefined, 60)).toBe(60 * 60_000);
  });
  it("doubles per failure up to an hour, and honours a longer Retry-After", () => {
    expect(pollDelay(1, undefined, null)).toBe(10 * 60_000);
    expect(pollDelay(3, undefined, null)).toBe(40 * 60_000);
    expect(pollDelay(9, undefined, null)).toBe(60 * 60_000);
    expect(pollDelay(1, 15 * 60_000, null)).toBe(15 * 60_000);
  });
});

describe("selfLoopProblem", () => {
  const base = { edges: [] };
  it("pauses a Sheets row automation that adds rows to the tab it watches", () => {
    const def = { ...base, trigger: { type: "sheets_row", config: { tab: "Orders" } }, steps: [{ id: "s", type: "sheets", config: { columns: ["x"] } }] };
    expect(selfLoopProblem(def as never, { spreadsheetId: "s1", tab: "Orders" })).toMatch(/same tab/);
    expect(selfLoopProblem(def as never, { spreadsheetId: "s1", tab: "Log" })).toBeNull();
    const off = { ...def, steps: [{ ...def.steps[0], disabled: true }] };
    expect(selfLoopProblem(off as never, { spreadsheetId: "s1", tab: "Orders" })).toBeNull();
  });
  it("pauses a Drive file automation that saves files to Drive", () => {
    const def = { ...base, trigger: { type: "drive_file", config: { requireFile: false } }, steps: [{ id: "d", type: "drive", config: {} }] };
    expect(selfLoopProblem(def as never, { folderId: "f", title: "t" })).toMatch(/saves files/);
  });
});
