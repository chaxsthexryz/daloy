import type { WorkflowDefinition } from "@daloy/engine";
import { describe, expect, it } from "vitest";
import { OTHER, PEOPLE, buildRequest, closestTemplate, plainDraft, questions, warningForLanguage, withLabels, withPeople } from "./ai-build";

const none = new Set<string>();
const ids = (q: { choices: { value: string }[] }) => q.choices.map((c) => c.value);
const byId = (qs: ReturnType<typeof questions>, id: string) => qs.find((q) => q.id === id)!;

describe("questions", () => {
  it("asks the four fixed questions in order", () => {
    expect(questions(none, []).map((q) => q.id)).toEqual(["start", "who", "where", "approve"]);
  });
  it("offers the four ways to start and a yes/no for approval", () => {
    const qs = questions(none, []);
    expect(ids(byId(qs, "start"))).toEqual(["form", "booking", "webhook", "schedule"]);
    expect(ids(byId(qs, "approve"))).toEqual(["no", "yes"]);
  });
  it("lists team members by name, or by the start of their email, and leaves them out when there are none", () => {
    const withTeam = byId(questions(none, [{ email: "ana.cruz@acme.test", name: "Ana Cruz" }, { email: "ben@acme.test" }]), "who");
    expect(ids(withTeam)).toEqual(["me", "member:0", "member:1", "filler", "none"]);
    expect(withTeam.choices.map((c) => c.label)).toEqual(["Me", "Ana Cruz", "ben", "The person who filled the form", "No one"]);
    expect(ids(byId(questions(none, []), "who"))).toEqual(["me", "filler", "none"]);
  });
  it("shows only the places that are connected", () => {
    expect(ids(byId(questions(none, []), "where"))).toEqual(["email", "daloy"]);
    expect(ids(byId(questions(new Set(["google_sheets", "slack"]), []), "where"))).toEqual(["email", "daloy", "sheets", "slack"]);
    expect(ids(byId(questions(new Set(["teams"]), []), "where"))).toEqual(["email", "daloy", "outlook_teams"]);
    expect(ids(byId(questions(new Set(["outlook"]), []), "where"))).toEqual(["email", "daloy", "outlook_teams"]);
  });
});

describe("buildRequest", () => {
  const answers = { start: "form", who: "me", where: "email", approve: "no" };
  it("starts with the description and adds one plain line per answer", () => {
    const r = buildRequest("Handle new orders", answers, none, []);
    expect(r.split("\n")[0]).toBe("Handle new orders");
    expect(r).toContain("It starts when someone fills a form.");
    expect(r).toContain("Tell the owner (owner@people.invalid).");
    expect(r).toContain("Send it to Email.");
    expect(r).toContain("No approval is needed.");
    expect(r).toContain("Apps connected: none.");
  });
  it("words the other choices", () => {
    const r = buildRequest("x", { start: "schedule", who: "filler", where: "daloy", approve: "yes" }, new Set(["slack", "google_sheets"]), []);
    expect(r).toContain("It runs on a schedule.");
    expect(r).toContain("Send the answer to the person who filled the form ({{trigger.email}}).");
    expect(r).toContain("Ask the owner to approve it first.");
    expect(r).toContain("Apps connected: google_sheets, slack.");
    expect(buildRequest("x", { who: "none" }, none, [])).toContain("No one is told.");
  });
  it("names a chosen member only by a placeholder label and never prints their address", () => {
    const members = [{ email: "real.person@acme.test", name: "Real Person" }];
    const r = buildRequest("x", { who: "member:0", approve: "yes" }, none, members);
    expect(r).toContain("Tell approver member1@people.invalid.");
    expect(r).toContain("Ask member1@people.invalid to approve it first.");
    expect(r).not.toContain("real.person");
    expect(r).not.toContain("acme.test");
    expect(r).not.toContain("Real Person");
  });
  it("puts free Other text in as typed, capped at 200 characters", () => {
    const r = buildRequest("x", { start: `${OTHER}when the moon is full`, where: `${OTHER}${"a".repeat(300)}` }, none, []);
    expect(r).toContain("when the moon is full");
    expect(r).toContain("a".repeat(200));
    expect(r).not.toContain("a".repeat(201));
  });
  it("keeps the whole request within 2000 characters", () => {
    const long = "w".repeat(5000);
    const r = buildRequest(long, { start: `${OTHER}${"s".repeat(500)}`, who: `${OTHER}${"h".repeat(500)}`, where: `${OTHER}${"e".repeat(500)}`, approve: `${OTHER}${"p".repeat(500)}` }, new Set(["slack"]), []);
    expect(r.length).toBeLessThanOrEqual(2000);
    expect(r).toContain("w".repeat(1200));
    expect(r).not.toContain("w".repeat(1201));
  });
});

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
  it("translates fixed questions without translating member names or answer values", () => {
    const qs = questions(none, [{ email: "ana@example.com", name: "Me" }], "tl");
    expect(qs[0]?.text).toBe("Ano ang magsisimula nito?");
    expect(byId(qs, "who").choices[0]).toEqual({ value: "me", label: "Ako" });
    expect(byId(qs, "who").choices[1]).toEqual({ value: "member:0", label: "Me" });
  });
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
