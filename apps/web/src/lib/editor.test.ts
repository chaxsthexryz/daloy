import { describe, expect, it } from "vitest";
import type { Draft } from "./graph";
import { insertables, nextPaths, setupLeft } from "./editor";

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
