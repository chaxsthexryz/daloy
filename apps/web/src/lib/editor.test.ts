import { describe, expect, it } from "vitest";
import type { Draft } from "./graph";
import { chosenFor, destinationName, insertables, nextPaths, setupLeft, unconnectedNodes } from "./editor";

// The receipt approval from the approved editor frame: a form, three steps, then three approval branches.
const receipt: Draft = {
  trigger: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }, { name: "receipt", label: "Receipt", type: "file", required: true }] } },
  steps: [
    { id: "save_receipt", type: "drive", config: { files: ["receipt"] } },
    { id: "read_receipt", type: "ai", config: { task: "extract", input: "{{trigger.receipt}}", fields: { amount: "Total", store: "Store name" } } },
    { id: "approve", type: "approval", config: { to: "marco@example.com", subject: "Approve?", text: "Approve?" } },
    { id: "log_expense", type: "sheets", config: { columns: ["{{steps.read_receipt.output.amount}}"] } },
    { id: "tell_approved", type: "email", config: { to: "{{trigger.email}}", subject: "Approved", text: "Approved" } },
    { id: "tell_rejected", type: "email", config: { to: "{{trigger.email}}", subject: "Rejected", text: "Rejected" } },
  ],
  edges: [
    { from: "save_receipt", to: "read_receipt" },
    { from: "read_receipt", to: "approve" },
    { from: "approve", to: "log_expense", on: "approved" },
    { from: "log_expense", to: "tell_approved" },
    { from: "approve", to: "tell_rejected", on: "rejected" },
  ],
} as unknown as Draft;

describe("nextPaths", () => {
  it("lists each branch with the chain of steps that follows it", () => {
    expect(nextPaths(receipt, "approve").map((p) => ({ on: p.on, ids: p.steps.map((s) => s.id) }))).toEqual([
      { on: "approved", ids: ["log_expense", "tell_approved"] },
      { on: "rejected", ids: ["tell_rejected"] },
    ]);
  });
  it("gives one unlabelled path for a plain step and none at the end", () => {
    expect(nextPaths(receipt, "save_receipt")).toEqual([{ on: undefined, steps: [receipt.steps[1], receipt.steps[2]] }]);
    expect(nextPaths(receipt, "tell_approved")).toEqual([]);
  });
  it("starts from the entry step for the trigger", () => {
    expect(nextPaths(receipt, "trigger")[0]!.steps.map((s) => s.id)).toEqual(["save_receipt", "read_receipt", "approve"]);
  });
  it("stops at a step it has already listed", () => {
    const loop = { ...receipt, edges: [...receipt.edges, { from: "tell_approved", to: "log_expense" }] } as Draft;
    expect(nextPaths(loop, "approve")[0]!.steps.map((s) => s.id)).toEqual(["log_expense", "tell_approved"]);
  });
});

describe("insertables", () => {
  it("offers trigger fields and only the steps that run before this one", () => {
    expect(insertables(receipt, "approve")).toEqual([
      "{{trigger.email}}",
      "{{trigger.receipt}}",
      "{{steps.save_receipt.output}}",
      "{{steps.read_receipt.output.amount}}",
      "{{steps.read_receipt.output.store}}",
    ]);
  });
  it("does not offer a step on another branch", () => {
    expect(insertables(receipt, "tell_rejected")).not.toContain("{{steps.log_expense.output}}");
    expect(insertables(receipt, "tell_approved")).toContain("{{steps.log_expense.output}}");
  });
  it("uses the email fields for an email trigger and nothing for a manual one", () => {
    expect(insertables({ ...receipt, trigger: { type: "email", config: {} } } as Draft, "save_receipt")).toEqual(["{{trigger.from}}", "{{trigger.subject}}", "{{trigger.text}}"]);
    expect(insertables({ ...receipt, trigger: { type: "manual", config: {} } } as Draft, "save_receipt")).toEqual([]);
  });
});

describe("setupLeft", () => {
  it("lists each app the steps need once, with whether it is connected", () => {
    expect(setupLeft(receipt, new Set(["google_sheets"]))).toEqual([
      { provider: "google_drive", label: "Google Drive", connected: false, steps: ["save_receipt"] },
      { provider: "google_sheets", label: "Google Sheet", connected: true, steps: ["log_expense"] },
    ]);
  });
  it("needs nothing for steps without an app", () => {
    expect(setupLeft({ ...receipt, steps: receipt.steps.filter((s) => s.type === "email") }, new Set())).toEqual([]);
  });
});

describe("destinationName", () => {
  it("reads the name of whatever the owner picked in Apps", () => {
    expect(destinationName({ provider: "slack", status: "active", destination: { channelName: "#orders" } })).toBe("#orders");
    expect(destinationName({ provider: "google_sheets", status: "active", destination: { title: "Orders 2026", tab: "Sheet1" } })).toBe("Orders 2026");
    expect(destinationName({ provider: "telegram", status: "active", destination: { chatTitle: "Shop team" } })).toBe("Shop team");
    expect(destinationName({ provider: "trello", status: "active", destination: { listName: "To do" } })).toBe("To do");
  });
  it("is undefined when nothing was picked", () => {
    expect(destinationName({ provider: "slack", status: "active", destination: null })).toBeUndefined();
    expect(destinationName({ provider: "slack", status: "active" })).toBeUndefined();
  });
});

describe("chosenFor", () => {
  it("gives each step the destination of its app", () => {
    const m = chosenFor(receipt, [{ provider: "google_sheets", status: "active", destination: { title: "Expenses" } }]);
    expect(m.get("log_expense")).toBe("Expenses");
    expect(m.has("save_receipt")).toBe(false);
  });
});

describe("unconnectedNodes", () => {
  it("names the app of every step whose app is not connected, in English", () => {
    const m = unconnectedNodes(receipt, new Set(["google_sheets"]), true);
    expect(m.get("save_receipt")).toBe("Google Drive");
    expect(m.has("log_expense")).toBe(false);
    expect(m.has("approve")).toBe(false);
  });
  it("asks for Gmail on an email step when no sender can send", () => {
    const d = { ...receipt, steps: receipt.steps.filter((s) => s.type === "email") } as Draft;
    expect(d.steps.length).toBeGreaterThan(0);
    expect(unconnectedNodes(d, new Set(), false).get(d.steps[0]!.id)).toBe("Gmail");
    expect(unconnectedNodes(d, new Set(), true).size).toBe(0);
  });
  it("covers a trigger that needs an app, under the id trigger", () => {
    expect(unconnectedNodes({ ...receipt, steps: [], edges: [], trigger: { type: "payment", config: { events: ["paid"] } } } as Draft, new Set(), true).get("trigger")).toBe("PayMongo");
  });
});
