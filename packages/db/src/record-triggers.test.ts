import { describe, expect, it } from "vitest";
import {
  freshOldestFirst,
  notionPropertyText,
  recordConnectionProblem,
  recordSelfLoopProblem,
  safeFields,
  statusChanges,
  statusRunKey,
  statusValue,
} from "./record-triggers";

describe("recordConnectionProblem (G5)", () => {
  const pat = (destination: Record<string, string> | null) => ({ status: "active" as const, authMethod: "token" as const, scopes: null, destination });
  const oauth = (scopes: string | null, destination: Record<string, string> | null) => ({ status: "active" as const, authMethod: "oauth" as const, scopes, destination });

  it("asks to connect or reconnect when missing or failed", () => {
    expect(recordConnectionProblem("airtable_record", null)).toBe("Airtable is not connected. Connect it in Apps.");
    expect(recordConnectionProblem("notion_page", { ...pat({ databaseId: "db1" }), status: "failed" })).toBe("Notion stopped accepting kymavo's access. Reconnect Notion in Apps.");
    expect(recordConnectionProblem("trello_card", null)).toBe("Trello is not connected. Connect it in Apps.");
  });

  it("refuses Airtable OAuth without data.records:read and table names instead of tbl ids", () => {
    expect(recordConnectionProblem("airtable_record", oauth("data.records:write schema.bases:read", { baseId: "app1", tableId: "tbl12345678901234" }))).toMatch(
      /personal access token/,
    );
    expect(recordConnectionProblem("airtable_record", oauth("data.records:read data.records:write", { baseId: "app1", tableId: "tbl12345678901234" }))).toBeNull();
    expect(recordConnectionProblem("airtable_record", pat({ baseId: "app1", tableId: "Orders" }))).toMatch(/starts with tbl/);
    expect(recordConnectionProblem("airtable_record", pat({ baseId: "app1", tableId: "tbl12345678901234" }))).toBeNull();
  });

  it("checks Trello read:board:trello scope and destination", () => {
    expect(recordConnectionProblem("trello_card", oauth("offline_access read:member:trello", { listId: "5f00" }))).toMatch(/board read access/);
    expect(recordConnectionProblem("trello_card", oauth("read:board:trello", { listId: "5f00" }))).toBeNull();
    expect(recordConnectionProblem("trello_card", pat({}))).toBe("Pick a list for Trello in Apps.");
    expect(recordConnectionProblem("notion_page", pat(null))).toBe("Pick a database for Notion in Apps.");
  });
});

describe("recordSelfLoopProblem (G5)", () => {
  const base = { edges: [] };
  it("pauses automations that write to the same record destination they watch", () => {
    expect(
      recordSelfLoopProblem({ ...base, trigger: { type: "airtable_record", config: { on: "created" } }, steps: [{ id: "a", type: "airtable", config: { fields: { Name: "x" } } }] } as never),
    ).toMatch(/Airtable table it watches/);
    expect(
      recordSelfLoopProblem({ ...base, trigger: { type: "notion_page", config: { on: "status_changed", statusProperty: "Status" } }, steps: [{ id: "n", type: "notion", config: { title: "x", fields: {} } }] } as never),
    ).toMatch(/Notion database it watches/);
    expect(
      recordSelfLoopProblem({ ...base, trigger: { type: "trello_card", config: { on: "created" } }, steps: [{ id: "t", type: "trello", config: { name: "x" } }] } as never),
    ).toMatch(/Trello list it watches/);
  });

  it("allows disabled write steps and Trello moved_to_list with a Trello create step", () => {
    expect(
      recordSelfLoopProblem({
        ...base,
        trigger: { type: "airtable_record", config: { on: "created" } },
        steps: [{ id: "a", disabled: true, type: "airtable", config: { fields: { Name: "x" } } }],
      } as never),
    ).toBeNull();
    expect(
      recordSelfLoopProblem({
        ...base,
        trigger: { type: "trello_card", config: { on: "moved_to_list" } },
        steps: [{ id: "t", type: "trello", config: { name: "x" } }],
      } as never),
    ).toBeNull();
  });
});

describe("statusValue, notionPropertyText, and safeFields", () => {
  it("extracts Notion property types and normalizes field names", () => {
    expect(notionPropertyText({ type: "title", title: [{ plain_text: "Order " }, { plain_text: "101" }] })).toBe("Order 101");
    expect(notionPropertyText({ type: "status", status: { name: "In Progress" } })).toBe("In Progress");
    expect(notionPropertyText({ type: "select", select: { name: "Paid" } })).toBe("Paid");
    expect(notionPropertyText({ type: "multi_select", multi_select: [{ name: "VIP" }, { name: "Urgent" }] })).toBe("VIP, Urgent");
    expect(notionPropertyText({ type: "number", number: 42 })).toBe("42");
    expect(notionPropertyText({ type: "checkbox", checkbox: true })).toBe("true");
    expect(notionPropertyText({ type: "date", date: { start: "2026-11-24" } })).toBe("2026-11-24");
    expect(notionPropertyText({ type: "unique_id", unique_id: { prefix: "ORD", number: 7 } })).toBe("ORD-7");
    expect(statusValue({ name: " Approved " })).toBe("Approved");
    expect(safeFields({ "Customer Name": "Ana", "2nd Status": { name: "Open" }, "Customer Name!": "Dup" })).toEqual({
      customer_name: "Ana",
      col_2nd_status: "Open",
      customer_name_2: "Dup",
    });
  });
});

describe("freshOldestFirst", () => {
  const now = new Date("2026-11-24T10:05:00.000Z");
  const items = [
    { id: "c", at: "2026-11-24T10:04:00.000Z" },
    { id: "a", at: "2026-11-24T10:01:00.000Z" },
    { id: "b", at: "2026-11-24T10:02:00.000Z" },
    { id: "old", at: "2026-11-24T09:50:00.000Z" },
  ];

  it("baselines on first poll with zero items", () => {
    expect(freshOldestFirst(null, items, now)).toEqual({ cursor: { since: "2026-11-24T10:05:00.000Z" }, fresh: [] });
  });

  it("returns fresh items oldest-first and caps at max", () => {
    const r = freshOldestFirst({ since: "2026-11-24T10:00:00.000Z" }, items, now, 2);
    expect(r.fresh.map((i) => i.id)).toEqual(["a", "b"]);
    expect(r.cursor).toEqual({ since: "2026-11-24T10:02:00.000Z" });
    const rest = freshOldestFirst(r.cursor, items, now, 10);
    expect(rest.fresh.map((i) => i.id)).toEqual(["b", "c"]);
    expect(rest.cursor).toEqual({ since: "2026-11-24T10:03:00.000Z" });
  });
});

describe("statusChanges", () => {
  const rec = (id: string, status: string) => ({ id, status });

  it("snapshots on first poll without emitting changes", () => {
    const r = statusChanges(null, [rec("1", "Open"), rec("2", "")], (x) => x.status);
    expect(r).toEqual({ cursor: { statuses: { "1": "Open", "2": "" }, seq: {} }, changes: [] });
  });

  it("detects transitions, repeats across A -> B -> A, and caps per poll", () => {
    const first = statusChanges(null, [rec("1", "Open"), rec("2", "Open")], (x) => x.status);
    const step1 = statusChanges(first.cursor, [rec("1", "Done"), rec("2", "Review")], (x) => x.status, 1);
    expect(step1.changes).toEqual([{ item: rec("1", "Done"), status: "Done", previousStatus: "Open", seq: 1 }]);
    // Item 2 was capped out, so it kept its old status and fires on the next poll.
    const step2 = statusChanges(step1.cursor, [rec("1", "Done"), rec("2", "Review")], (x) => x.status, 5);
    expect(step2.changes).toEqual([{ item: rec("2", "Review"), status: "Review", previousStatus: "Open", seq: 1 }]);
    // Item 1 moves back to Open: seq increments so run_keys allows the new transition.
    const step3 = statusChanges(step2.cursor, [rec("1", "Open"), rec("2", "Review")], (x) => x.status, 5);
    expect(step3.changes).toEqual([{ item: rec("1", "Open"), status: "Open", previousStatus: "Done", seq: 2 }]);
    expect(statusRunKey("airtable:app1:tbl1", "1", 1, "Open")).not.toBe(statusRunKey("airtable:app1:tbl1", "1", 2, "Open"));
  });
});
