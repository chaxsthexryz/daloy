import type { WorkflowDefinition } from "@daloy/engine";
import { describe, expect, it } from "vitest";
import { PEOPLE, closestTemplate, plainDraft, warningForLanguage, withLabels, withPeople } from "./ai-build";


const def: WorkflowDefinition = {
  trigger: { type: "manual", config: {} },
  steps: [
    { id: "mail", type: "email", config: { to: "owner@people.invalid, {{trigger.email}}", subject: "Hi", text: "owner@people.invalid" } },
    { id: "ask", type: "approval", config: { approver: "member1@people.invalid", subject: "Ok?", message: "Ok?", timeoutSeconds: 3600 } },
    { id: "http", type: "http", config: { method: "POST", url: "https://x.test/hook", headers: { "X-Who": "owner@people.invalid" }, body: '{"to":"owner@people.invalid"}' } },
  ],
  edges: [{ from: "mail", to: "ask" }, { from: "ask", to: "http", on: "approved" }],
};
const real = { owner: 'o"wner@real.test', member1: "m@real.test" };

describe("withPeople and withLabels", () => {
  it("swaps the placeholders for real addresses everywhere, including inside a list and nested objects, without mutating the input", () => {
    const out = withPeople(def, real);
    const mail = out.steps[0]!.config as { to: string; text: string };
    expect(mail.to).toBe('o"wner@real.test, {{trigger.email}}');
    expect(mail.text).toBe('o"wner@real.test');
    expect((out.steps[1]!.config as { approver: string }).approver).toBe("m@real.test");
    const http = out.steps[2]!.config as { headers: Record<string, string>; body: string };
    expect(http.headers["X-Who"]).toBe('o"wner@real.test');
    expect(JSON.stringify(out)).not.toContain("people.invalid");
    expect(JSON.stringify(def)).toContain("owner@people.invalid");
  });
  it("leaves member1 alone when no member is given, and does not treat $ in an address as a pattern", () => {
    expect((withPeople(def, { owner: "a$&b@x.test" }).steps[0]!.config as { text: string }).text).toBe("a$&b@x.test");
    expect((withPeople(def, { owner: "a@x.test" }).steps[1]!.config as { approver: string }).approver).toBe(PEOPLE.member1);
  });
  it("round trips both ways, matching real addresses without regard to case", () => {
    expect(withLabels(withPeople(def, real), real)).toEqual(def);
    const upper = withPeople(def, { owner: "Owner@Real.TEST", member1: "m@real.test" });
    const back = withLabels(upper, { owner: "owner@real.test", member1: "M@REAL.test" });
    expect(back.steps[0]!.config).toEqual(def.steps[0]!.config);
    expect((back.steps[1]!.config as { approver: string }).approver).toBe(PEOPLE.member1);
  });
});

describe("plainDraft", () => {
  const one = (step: WorkflowDefinition["steps"][number], trigger: WorkflowDefinition["trigger"] = { type: "manual", config: {} }) => plainDraft({ trigger, steps: [step], edges: [] }).steps;
  it("says when it starts", () => {
    const t = (trigger: WorkflowDefinition["trigger"]) => plainDraft({ trigger, steps: [], edges: [] }).when;
    expect(t({ type: "form", config: { fields: [{ name: "a", label: "A", type: "text", required: false }] } })).toBe("When someone fills the form");
    expect(t({ type: "webhook", config: {} })).toBe("When another system sends a web request");
    expect(t({ type: "schedule", config: { cron: "0 9 * * 1" } })).toBe("On a schedule (0 9 * * 1)");
    expect(t({ type: "manual", config: {} })).toBe("When you run it by hand");
  });
  it("holds the booked time for a booking step", () => {
    expect(one({ id: "b", type: "booking", config: { action: "create", resource: "r", start: "{{trigger.at}}", minutes: 30 } })).toEqual(["Hold the booked time"]);
  });
  it("email", () => {
    expect(one({ id: "a", type: "email", config: { to: "a@x.test", subject: "Hello", text: "t" } })).toEqual(["Email a@x.test (subject: Hello)"]);
  });
  it("outlook", () => {
    expect(one({ id: "a", type: "outlook", config: { to: "a@x.test", subject: "Hello", text: "t" } })).toEqual(["Email a@x.test from Outlook"]);
  });
  it("approval prefers the named approver", () => {
    expect(one({ id: "a", type: "approval", config: { approver: "boss@x.test", to: "z@x.test", subject: "Buy", message: "m", timeoutSeconds: 60 } })).toEqual(["Ask boss@x.test to approve: Buy"]);
    expect(one({ id: "a", type: "approval", config: { to: "z@x.test", subject: "Buy", message: "m", timeoutSeconds: 60 } })).toEqual(["Ask z@x.test to approve: Buy"]);
  });
  it("sheets, slack and teams", () => {
    expect(one({ id: "a", type: "sheets", config: { columns: ["x"] } })).toEqual(["Add a row to your Google Sheet"]);
    expect(one({ id: "a", type: "slack", config: { text: "x" } })).toEqual(["Post to your Slack channel"]);
    expect(one({ id: "a", type: "teams", config: { text: "x" } })).toEqual(["Post to your Teams channel"]);
  });
  it("delay, fixed or until a time", () => {
    expect(one({ id: "a", type: "delay", config: { seconds: 86_400 } })).toEqual(["Wait 1 day"]);
    expect(one({ id: "a", type: "delay", config: { seconds: 7200 } })).toEqual(["Wait 2 hours"]);
    expect(one({ id: "a", type: "delay", config: { seconds: 90 } })).toEqual(["Wait 90 seconds"]);
    expect(one({ id: "a", type: "delay", config: { until: "{{trigger.at}}", offsetSeconds: -86_400 } })).toEqual(["Wait until 1 day before {{trigger.at}}"]);
    expect(one({ id: "a", type: "delay", config: { until: "{{trigger.at}}" } })).toEqual(["Wait until {{trigger.at}}"]);
  });
  it("condition", () => {
    expect(one({ id: "a", type: "condition", config: { condition: { left: "{{trigger.total}}", op: "gt", right: 500 } } })).toEqual(["Check {{trigger.total}} is more than 500"]);
    expect(one({ id: "a", type: "condition", config: { condition: { left: "{{trigger.note}}", op: "exists" } } })).toEqual(["Check {{trigger.note}} is filled in"]);
  });
  it("ai", () => {
    expect(one({ id: "a", type: "ai", config: { task: "summarize", input: "{{trigger.message}}" } })).toEqual(["Ask the AI to summarize it"]);
  });
  it("http names only the host", () => {
    expect(one({ id: "a", type: "http", config: { method: "POST", url: "https://api.shop.test/v1/orders?key=1", headers: {} } })).toEqual(["Send a web request to api.shop.test"]);
  });
  it("copes with missing fields", () => {
    const sloppy = { id: "a", type: "email", config: {} } as unknown as WorkflowDefinition["steps"][number];
    expect(one(sloppy)).toEqual(["Email someone"]);
  });
  it("names the form sender in words", () => {
    expect(one({ id: "a", type: "email", config: { to: "{{trigger.email}}", subject: "Thanks", text: "Hi" } })).toEqual(["Email the person who filled the form (subject: Thanks)"]);
  });
  it("follows the edges in order, then the other branches with a plain prefix", () => {
    const d: WorkflowDefinition = {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "ask", type: "approval", config: { approver: "boss@x.test", subject: "Buy", message: "m", timeoutSeconds: 60 } },
        { id: "no", type: "email", config: { to: "a@x.test", subject: "Declined", text: "t" } },
        { id: "yes", type: "slack", config: { text: "ok" } },
        { id: "then", type: "sheets", config: { columns: ["x"] } },
        { id: "first", type: "delay", config: { seconds: 60 } },
      ],
      edges: [
        { from: "first", to: "ask" },
        { from: "ask", to: "no", on: "rejected" },
        { from: "ask", to: "yes", on: "approved" },
        { from: "yes", to: "then" },
      ],
    };
    expect(plainDraft(d).steps).toEqual([
      "Wait 1 minute",
      "Ask boss@x.test to approve: Buy",
      "If rejected: Email a@x.test (subject: Declined)",
      "If approved: Post to your Slack channel",
      "If approved: Add a row to your Google Sheet",
    ]);
  });
});

describe("closestTemplate", () => {
  it("picks the purchase request when approval is wanted", () => {
    expect(closestTemplate({ approve: "yes" }, "website inquiry")).toMatchObject({ action: "purchase", label: "Purchase request with a named approver" });
  });
  it("picks the website inquiry reply from the description", () => {
    expect(closestTemplate({}, "Reply to my WEBSITE visitors")).toMatchObject({ label: "Reply to a website inquiry", href: "#/settings/business" });
    expect(closestTemplate({ approve: "no" }, "Answer every Inquiry")).toMatchObject({ href: "#/settings/business" });
  });
  it("falls back to tracking an office request", () => {
    expect(closestTemplate({ approve: "no" }, "keep track of things")).toMatchObject({ action: "office", label: "Track an office request" });
  });
});


describe("localized builder copy", () => {
  it("translates plan sentences while preserving addresses, subjects, and branch identifiers", () => {
    const def: WorkflowDefinition = {
      trigger: { type: "manual", config: {} },
      steps: [{ id: "mail", type: "email", config: { to: "owner@example.com", subject: "Save", text: "Hi" } }], edges: [],
    };
    expect(plainDraft(def, "tl")).toEqual({ when: "Kapag mano-mano mong pinatakbo", steps: ["Mag-email sa owner@example.com (paksa: Save)"] });
    expect(plainDraft(def).steps).toEqual(["Email owner@example.com (subject: Save)"]);
  });
});


it("translates only known lint warnings and keeps identifiers and arbitrary AI warnings unchanged", () => {
  expect(warningForLanguage('Condition "Save" compares numbers but has no "invalid" edge, so a missing or non-number value fails the run.', "tl")).toContain('"Save"');
  expect(warningForLanguage('Condition "Save" compares numbers but has no "invalid" edge, so a missing or non-number value fails the run.', "tl")).toContain('walang');
  expect(warningForLanguage("Save", "tl")).toBe("Save");
});
