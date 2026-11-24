import { describe, expect, it } from "vitest";
import type { Draft } from "./graph";
import { chosenFor, destinationName, insertables, nextPaths, openExits, setupLeft, unconnectedNodes } from "./editor";

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
    expect(insertables({ ...receipt, trigger: { type: "gmail_message", config: {} } } as Draft, "save_receipt")).toContain("{{trigger.gmailMessageId}}");
    expect(insertables({ ...receipt, trigger: { type: "outlook_message", config: {} } } as Draft, "save_receipt")).toContain("{{trigger.outlookMessageId}}");
    expect(insertables({ ...receipt, trigger: { type: "manual", config: {} } } as Draft, "save_receipt")).toEqual([]);
  });
  it("lists stay_quote output fields for steps after it", () => {
    const quoted: Draft = {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "quote", type: "stay_quote", config: { room: "Garden room", checkIn: "2026-12-14", nights: "2", guests: "2" } },
        { id: "due", type: "payment_due", config: { reference: "R-1", amount: "{{steps.quote.output.deposit}}", kind: "deposit", checkout: false } },
      ],
      edges: [{ from: "quote", to: "due" }],
    } as unknown as Draft;
    const items = insertables(quoted, "due");
    expect(items).toContain("{{steps.quote.output.deposit}}");
    expect(items).toContain("{{steps.quote.output.total}}");
  });
});

describe("setupLeft", () => {
  it("lists each app the steps need once, with whether it is connected", () => {
    expect(setupLeft(receipt, new Set(["google_sheets"]))).toEqual([
      { provider: "google_drive", label: "Google Drive", connected: false, steps: ["save_receipt"] },
      { provider: "google_sheets", label: "Google Sheet", connected: true, steps: ["log_expense"] },
    ]);
  });
  it("lists only the apps chosen for checkout and customer replies", () => {
    const due = { id: "ask", type: "payment_due", config: { reference: "D-1042", amount: "350", kind: "deposit", checkout: false } } as const;
    const draft = { ...receipt, steps: [due] };
    expect(setupLeft(draft, new Set())).toEqual([]);
    const checkout = { ...draft, steps: [{ ...due, config: { ...due.config, checkout: true, channel: "sms" as const, to: "{{trigger.phone}}" } }] };
    // SMS is the server's own (decision 0100): a workspace never has to connect it.
    expect(setupLeft(checkout, new Set()).map(app => app.provider)).toEqual(["paymongo"]);
    expect(unconnectedNodes(checkout, new Set(["paymongo"]), true).has("ask")).toBe(false);
  });

  it("never asks to connect UniSMS for an SMS step", () => {
    const sms = { ...receipt, steps: [{ id: "tell", type: "sms", config: { to: "{{trigger.phone}}", message: "Hi" } }] } as Draft;
    expect(setupLeft(sms, new Set())).toEqual([]);
    expect(unconnectedNodes(sms, new Set(), true).size).toBe(0);
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

describe("openExits", () => {
  const trigger = { type: "manual", config: {} } as const;

  it("offers one start exit on an empty trigger and none once a step exists", () => {
    expect(openExits({ trigger, steps: [], edges: [] }, "trigger")).toEqual([{}]);
    expect(openExits(receipt, "trigger")).toEqual([]);
  });

  it("offers one exit on a leaf plain step and none when connected", () => {
    const draft: Draft = {
      trigger,
      steps: [
        { id: "first", type: "delay", config: { seconds: 10 } },
        { id: "second", type: "delay", config: { seconds: 20 } },
      ],
      edges: [{ from: "first", to: "second" }],
    };
    expect(openExits(draft, "first")).toEqual([]);
    expect(openExits(draft, "second")).toEqual([{}]);
  });

  it("excludes optional invalid on condition and lists remaining primary branches", () => {
    const cond: Draft = {
      trigger,
      steps: [
        { id: "check", type: "condition", config: { condition: { left: "{{trigger.amount}}", op: "gt", right: 100 } } },
        { id: "next", type: "delay", config: { seconds: 5 } },
      ],
      edges: [],
    };
    expect(openExits(cond, "check")).toEqual([{ on: "true" }, { on: "false" }]);
    expect(openExits({ ...cond, edges: [{ from: "check", to: "next", on: "true" }] }, "check")).toEqual([{ on: "false" }]);
    expect(openExits({ ...cond, edges: [{ from: "check", to: "next", on: "true" }, { from: "check", to: "next", on: "false" }] }, "check")).toEqual([]);
  });

  it("lists remaining branches for approval, booking actions, and payment_expire", () => {
    const approval: Draft = {
      trigger,
      steps: [
        { id: "ask", type: "approval", config: { to: "a@b.c", subject: "Hi", message: "Ok?", timeoutSeconds: 60 } },
        { id: "done", type: "delay", config: { seconds: 5 } },
      ],
      edges: [{ from: "ask", to: "done", on: "approved" }],
    };
    expect(openExits(approval, "ask")).toEqual([{ on: "rejected" }, { on: "timeout" }]);

    const bookCreate: Draft = {
      trigger,
      steps: [{ id: "b1", type: "booking", config: { action: "create", resource: "r1", start: "{{trigger.at}}", minutes: 30 } }],
      edges: [],
    };
    expect(openExits(bookCreate, "b1")).toEqual([{ on: "done" }, { on: "taken" }]);

    const bookMove: Draft = {
      trigger,
      steps: [{ id: "b2", type: "booking", config: { action: "reschedule", booking: "B-1", start: "{{trigger.at}}" } }],
      edges: [],
    };
    expect(openExits(bookMove, "b2")).toEqual([{ on: "done" }, { on: "not_found" }]);

    const bookCancel: Draft = {
      trigger,
      steps: [{ id: "b3", type: "booking", config: { action: "cancel", booking: "B-1" } }],
      edges: [],
    };
    expect(openExits(bookCancel, "b3")).toEqual([{ on: "done" }, { on: "not_found" }]);

    const expire: Draft = {
      trigger,
      steps: [{ id: "p1", type: "payment_expire", config: { due: "pay_1" } }],
      edges: [],
    };
    expect(openExits(expire, "p1")).toEqual([{ on: "expired" }, { on: "kept" }]);
  });

  it("lists insertable references for internal triggers, sub_workflow fields, and call_workflow outputs", () => {
    const baseStep: Draft["steps"][number] = { id: "notify", type: "delay", config: { seconds: 1 } };
    const bookEvt: Draft = { trigger: { type: "booking_event", config: { events: ["created"] } }, steps: [baseStep], edges: [] };
    expect(insertables(bookEvt, "notify")).toContain("{{trigger.bookingId}}");
    expect(insertables(bookEvt, "notify")).toContain("{{trigger.reference}}");

    const payEvt: Draft = { trigger: { type: "payment_event", config: { events: ["confirmed"] } }, steps: [baseStep], edges: [] };
    expect(insertables(payEvt, "notify")).toContain("{{trigger.dueId}}");
    expect(insertables(payEvt, "notify")).toContain("{{trigger.amountPesos}}");

    const subDraft: Draft = {
      trigger: { type: "sub_workflow", config: { fields: [{ name: "guest", label: "Guest", type: "text", required: true }] } },
      steps: [
        { id: "sub", type: "call_workflow", config: { workflowSlug: "notify-staff", payload: { guest: "{{trigger.guest}}" } } },
        baseStep,
      ],
      edges: [{ from: "sub", to: "notify" }],
    };
    expect(insertables(subDraft, "notify")).toEqual([
      "{{trigger.guest}}",
      "{{steps.sub.output.runId}}",
      "{{steps.sub.output.workflowId}}",
      "{{steps.sub.output.workflowSlug}}",
      "{{steps.sub.output.duplicate}}",
    ]);

    const assistantDraft: Draft = {
      trigger: { type: "telegram_message", config: { from: "anyone", requireFile: false } },
      steps: [
        { id: "read_data", type: "assistant_read", config: { what: "all", timezone: "Asia/Manila" } },
        { id: "reply", type: "telegram", config: { chatId: "{{trigger.chatId}}", text: "{{steps.read_data.output.summaryText}}" } },
      ],
      edges: [{ from: "read_data", to: "reply" }],
    };
    const vars = insertables(assistantDraft, "reply");
    expect(vars).toContain("{{trigger.conversation.history}}");
    expect(vars).toContain("{{steps.read_data.output.summaryText}}");
    expect(vars).toContain("{{steps.read_data.output.calendar.events}}");
  });
});
