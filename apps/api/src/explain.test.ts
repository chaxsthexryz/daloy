import { describe, expect, it } from "vitest";
import { answerAll, askFacts, explainFailure, failureFacts, type AskFacts, type Facts, type Reason } from "./explain";

const def = {
  trigger: { type: "manual", config: {} },
  steps: [
    { id: "send_to_maria", type: "http", config: {} },
    { id: "ask", type: "approval", config: {} },
  ],
  edges: [{ from: "send_to_maria", to: "ask" }],
};
const run = (over = {}) => ({ run: { state: "failed", test: false, error: null as string | null, ...over }, steps: [], deliveries: [], definition: def });
const failed = (error: string | null, over = {}) => ({ stepId: "send_to_maria", attempt: 1, state: "failed", error, deadLetter: false, outcome: null, ...over });
const facts = (over: Partial<Facts> = {}): Facts => ({ runState: "failed", preview: false, step: null, deliveries: [], lint: [], ...over });
const stepFacts = (over = {}): Facts => facts({ step: { type: "http", outcome: null, attempts: 1, deadLetter: false, statusCode: null, reason: null, ...over } });
const delivery = (provider: string, errorKind: string | null, over = {}) => facts({ deliveries: [{ provider, state: "failed", errorKind, attempts: 2, ...over }] });

describe("failureFacts", () => {
  it("picks the latest failed step, its type and its highest attempt", () => {
    const f = failureFacts({ ...run(), steps: [failed("HTTP 500 from a.test", { attempt: 1 }), failed("HTTP 404 from a.test", { attempt: 2, deadLetter: true })] });
    expect(f.step).toEqual({ type: "http", outcome: null, attempts: 2, deadLetter: true, statusCode: 404, reason: null });
  });
  it("leaves out a failure the run handled by taking its failed path (T3)", () => {
    const handled = failed("Slack refused", { attempt: 1, branch: "failed", createdAt: "2026-11-25T00:00:01Z" });
    expect(failureFacts({ ...run({ state: "succeeded" }), steps: [handled] }).step).toBeNull();
    const later = failed("HTTP 500 from a.test", { stepId: "ask", createdAt: "2026-11-25T00:00:02Z" });
    expect(failureFacts({ ...run(), steps: [handled, later] }).step?.type).toBe("approval");
  });
  it("says unknown for a step the definition does not have", () => {
    expect(failureFacts({ ...run(), steps: [failed("x", { stepId: "gone" })] }).step?.type).toBe("unknown");
  });
  it("reads the status code with or without a step prefix, and only from that shape", () => {
    const code = (e: string) => failureFacts({ ...run(), steps: [failed(e)] }).step?.statusCode;
    expect(code("HTTP 429 from api.test")).toBe(429);
    expect(code("step send_to_maria: HTTP 503 from api.test")).toBe(503);
    expect(code("Got HTTP 404 from api.test")).toBeNull();
    expect(code("timeout")).toBeNull();
  });
  it.each<[Reason, string]>([
    ["mail_sender", "Gmail refused the sign-in"],
    ["mail_sender", "Could not reach the mail server"],
    ["ai_model", "The AI model could not answer"],
    ["ai_model", "Invalid API key"],
    ["quota", "This office used its 100 AI actions for this month. They come back on 1 March 2026, Manila time. To get more now, ask kymavo to move you to a larger plan."],
    ["quota", "This office reached today's limit of 200 email recipients. Sending starts again tomorrow, Manila time. Press Retry on this run then."],
    ["quota", "This office reached today's limit of 200 web requests. They start again tomorrow, Manila time. Press Retry on this run then."],
    ["booking_changed", "The booking was rescheduled or cancelled, so this run stopped before step send."],
    ["booking_changed", "The booking was rescheduled or cancelled, so this was not sent."],
    ["worker_stopped", "The worker stopped while sending, so this may have gone through. Check with the receiver, then choose."],
    ["preview_choice", "Test run: this step was set to fail (retryable)."],
    ["knowledge_unpublished", "No published answers yet. Add and publish Q&As on the Knowledge page first."],
    ["missing_resource", "Add at least one room or resource on the Resources page before booking."],
    ["sms_not_set_up", "UniSMS is not configured yet for SMS messages."],
  ])("names the reason %s from real text", (reason, error) => {
    expect(failureFacts({ ...run(), steps: [failed(error)] }).step?.reason).toBe(reason);
  });
  it("falls back to the run error for the reason", () => {
    expect(failureFacts({ ...run({ error: "step x: the worker stopped while sending" }), steps: [failed(null)] }).step?.reason).toBe("worker_stopped");
  });
  it("keeps only failed, review or queued-with-kind deliveries", () => {
    const d = (state: string, errorKind: string | null) => ({ provider: "slack", state, errorKind, attempts: 1 });
    const f = failureFacts({ ...run(), deliveries: [d("delivered", null), d("failed", "auth"), d("queued", null), d("queued", "quota"), d("needs_review", "ambiguous")] });
    expect(f.deliveries.map((x) => x.state)).toEqual(["failed", "queued", "needs_review"]);
  });
  it("groups lint findings by rule without messages", () => {
    expect(failureFacts({ ...run(), steps: [] }).lint).toEqual([{ rule: "approval_no_edge", count: 2 }]);
  });
  it("never lets text, ids or payloads out", () => {
    const secretsIn = ["maria@example.com", "https://x.test/?token=abc", "token=abc", "send_to_maria", "Maria Santos", "x.test", "api.example.com", "needs a 3pm cleaning"];
    const f = failureFacts({
      run: { state: "failed", test: false, error: "step send_to_maria: email maria@example.com https://x.test/?token=abc" },
      steps: [{ ...failed("HTTP 404 from api.example.com"), outcome: "rejected" }],
      deliveries: [{ provider: "slack", state: "failed", errorKind: "permission", attempts: 1, lastError: "#maria-team", payload: { text: "Maria Santos needs a 3pm cleaning" } } as never],
      definition: def,
    });
    const text = JSON.stringify(f);
    for (const s of secretsIn) expect(text).not.toContain(s);
    expect(Object.keys(f).sort()).toEqual(["deliveries", "lint", "preview", "runState", "step"]);
    expect(f.step?.statusCode).toBe(404);
  });
});

describe("explainFailure", () => {
  it.each([
    ["google_sheets", "Google Sheets"],
    ["slack", "Slack"],
    ["outlook", "Outlook"],
    ["teams", "Microsoft Teams"],
  ])("names the app for %s", (provider, name) => {
    expect(explainFailure(delivery(provider, "auth")).headline).toContain(name);
  });
  it("auth and reconnect point to Apps", () => {
    for (const k of ["auth", "reconnect"]) expect(explainFailure(delivery("slack", k)).fix).toEqual({ href: "#/apps", label: "Check the connection" });
  });
  it("not_connected offers to connect the app", () => {
    expect(explainFailure(delivery("teams", "not_connected")).fix).toEqual({ href: "#/apps", label: "Connect Microsoft Teams" });
  });
  it("permission wording follows the provider", () => {
    expect(explainFailure(delivery("google_sheets", "permission")).lines[0]).toMatch(/Share the sheet/);
    expect(explainFailure(delivery("slack", "permission")).lines[0]).toMatch(/Invite the kymavo app/);
    expect(explainFailure(delivery("outlook", "permission")).lines[0]).toMatch(/may send email/);
    expect(explainFailure(delivery("teams", "permission")).lines[0]).toMatch(/team and channel/);
  });
  it("no_destination asks for a sheet or a channel", () => {
    expect(explainFailure(delivery("google_sheets", "no_destination")).fix?.label).toBe("Pick a sheet");
    expect(explainFailure(delivery("slack", "no_destination")).fix?.label).toBe("Pick a channel");
  });
  it("quota and unavailable say kymavo will try again", () => {
    for (const k of ["quota", "unavailable"]) {
      const e = explainFailure(delivery("slack", k, { state: "queued" }));
      expect(e.lines[0]).toMatch(/try again on its own/);
      expect(e.fix).toBeNull();
    }
  });
  it.each(["ambiguous", "review", "destination_changed", "queued_before_pin"])("%s needs the owner, with Mark as posted and Post again", (k) => {
    const e = explainFailure(delivery("slack", k, { state: "needs_review" }));
    expect(e.lines.join(" ")).toMatch(/Mark as posted.*Post again/);
    const o = explainFailure(delivery("outlook", k, { state: "needs_review" }));
    expect(o.lines.join(" ")).toMatch(/Mark as sent.*Send again/);
  });
  it("invalid sends the owner to the step settings", () => {
    expect(explainFailure(delivery("slack", "invalid")).lines[0]).toMatch(/Check this step's settings/);
  });
  it("booking_changed says nothing more is sent", () => {
    expect(explainFailure(delivery("slack", "booking_changed")).lines[0]).toMatch(/nothing more is sent/);
  });
  it("deliveries come before the step", () => {
    const f = { ...delivery("slack", "auth"), step: stepFacts({ reason: "mail_sender" }).step };
    expect(explainFailure(f).headline).toContain("Slack");
  });

  it.each<[Reason, string, string]>([
    ["mail_sender", "Connect Gmail", "#/apps"],
    ["ai_model", "Check the AI model", "#/settings/ai"],
    ["quota", "See usage", "#/settings"],
    ["knowledge_unpublished", "Open Knowledge", "#/knowledge"],
    ["missing_resource", "Add a resource", "#/resources"],
    ["sms_not_set_up", "See plan and usage", "#/settings"],
  ])("step reason %s", (reason, label, href) => {
    expect(explainFailure(stepFacts({ reason })).fix).toEqual({ href, label });
  });
  it("omits paid AI rewording for local prerequisite failures but keeps it for other failures", () => {
    for (const reason of ["knowledge_unpublished", "missing_resource", "sms_not_set_up"] as const) {
      expect(explainFailure(stepFacts({ reason })).aiExplain).toBe(false);
    }
    expect(explainFailure(stepFacts({ reason: "preview_choice" })).aiExplain).not.toBe(false);
    expect(explainFailure(stepFacts({ statusCode: 500 })).aiExplain).not.toBe(false);
  });
  it("step reason booking_changed, preview_choice and worker_stopped", () => {
    expect(explainFailure(stepFacts({ reason: "booking_changed" })).lines[0]).toMatch(/nothing more is sent/);
    expect(explainFailure(stepFacts({ reason: "preview_choice" })).headline).toMatch(/on purpose/);
    expect(explainFailure(stepFacts({ reason: "worker_stopped" })).lines[0]).toMatch(/It went through, Send again or Stop/);
  });
  it.each([
    [401, "refused kymavo's access"],
    [403, "refused kymavo's access"],
    [404, "address was not found"],
    [429, "asked kymavo to slow down"],
    [500, "had a problem"],
    [503, "had a problem"],
  ])("status %i", (statusCode, words) => {
    expect(explainFailure(stepFacts({ statusCode })).headline).toContain(words);
  });
  it("a dead letter says how many tries", () => {
    expect(explainFailure(stepFacts({ deadLetter: true, attempts: 5 })).lines[0]).toMatch(/5 times/);
  });
  it("outcomes without a better reason", () => {
    expect(explainFailure(stepFacts({ outcome: "unknown" })).headline).toMatch(/not clear/);
    expect(explainFailure(stepFacts({ outcome: "not_sent" })).headline).toMatch(/Nothing was sent/);
    expect(explainFailure(stepFacts({ outcome: "rejected" })).headline).toMatch(/rejected/);
    expect(explainFailure(stepFacts({ outcome: "throttled" })).headline).toMatch(/slow down/);
  });
  it("adds a line for each lint rule", () => {
    const rules = ["approval_no_edge", "classify_dead_end", "test_switch", "number_no_invalid", "unreachable_step", "failed_path_no_edge"] as const;
    const e = explainFailure(facts({ lint: rules.map((rule) => ({ rule, count: 1 })) }));
    expect(e.lines.slice(1)).toHaveLength(6);
    expect(e.lines[1]).toBe("An approval in this automation has no path for one of its answers, so the automation ends there.");
  });
  it("falls back when nothing matches", () => {
    const e = explainFailure(stepFacts());
    expect(e.headline).toBe("kymavo could not tell why this stopped.");
    expect(e.lines[0]).toBe("The details for a technician below have the full record.");
  });
  it("uses plain words everywhere", () => {
    const all: Facts[] = [stepFacts(), facts({ lint: ["approval_no_edge", "classify_dead_end", "test_switch", "number_no_invalid", "unreachable_step", "failed_path_no_edge"].map((rule) => ({ rule: rule as never, count: 1 })) })];
    for (const p of ["google_sheets", "slack", "outlook", "teams"])
      for (const k of ["auth", "reconnect", "not_connected", "permission", "no_destination", "quota", "unavailable", "ambiguous", "review", "destination_changed", "queued_before_pin", "invalid", "booking_changed"]) all.push(delivery(p, k));
    for (const reason of ["mail_sender", "ai_model", "quota", "booking_changed", "worker_stopped", "preview_choice", "knowledge_unpublished", "missing_resource", "sms_not_set_up"] as const) all.push(stepFacts({ reason }));
    for (const statusCode of [401, 404, 429, 500]) all.push(stepFacts({ statusCode, deadLetter: true }));
    for (const outcome of ["unknown", "not_sent", "rejected", "throttled"]) all.push(stepFacts({ outcome }));
    for (const f of all) {
      const text = JSON.stringify(explainFailure(f));
      expect(text).not.toMatch(/—|–|workflow|\{\{/i);
    }
  });
});

describe("askFacts", () => {
  const at = (n: number) => new Date(2026, 0, 1, 0, 0, n);
  it("lists one step per id with its latest attempt, its type and no ids", () => {
    const f = askFacts({
      ...run(),
      steps: [
        failed("HTTP 500 from a.test", { attempt: 1, createdAt: at(1) }),
        failed("HTTP 500 from a.test", { attempt: 2, createdAt: at(2) }),
        { stepId: "ask", attempt: 1, state: "succeeded", deadLetter: false, outcome: null, createdAt: at(3) },
      ],
    });
    expect(f.steps).toEqual([
      { type: "http", state: "failed", outcome: null, attempts: 2 },
      { type: "approval", state: "succeeded", outcome: null, attempts: 1 },
    ]);
    expect(JSON.stringify(f)).not.toContain("send_to_maria");
  });
  it("maps raw states to the four plain ones", () => {
    const state = (r: string, deliveryState?: string) => askFacts({ ...run({ state: r }), deliveries: deliveryState ? [{ provider: "slack", state: deliveryState, errorKind: null, attempts: 1 }] : [] }).plainState;
    expect(state("succeeded")).toBe("done");
    expect(state("cancelled")).toBe("done");
    expect(state("failed")).toBe("problem");
    expect(state("succeeded", "failed")).toBe("problem");
    expect(state("waiting")).toBe("waiting");
    expect(state("needs_review")).toBe("needs you");
    expect(state("succeeded", "needs_review")).toBe("needs you");
    expect(state("running")).toBe("in progress");
  });
});

describe("answerAll", () => {
  const asked = (over: Partial<AskFacts> = {}): AskFacts => ({ ...facts({ runState: "succeeded" }), plainState: "done", steps: [{ type: "http", state: "succeeded", outcome: null, attempts: 1 }], ...over });
  it("a done run has no why and nothing to do", () => {
    const a = answerAll(asked());
    expect(a.happened.headline).toBe("This request is done.");
    expect(a.happened.lines[0]).toBe("1 step ran.");
    expect(a.why).toBeNull();
    expect(a.next.lines[0]).toBe("Nothing needs to be done.");
    expect(a.next.fix).toBeNull();
    expect(a.next.lines.at(-1)).toBe("Open the request in Activity to see every step.");
  });
  it("a failed delivery explains why and passes its fix on", () => {
    const f = asked({ ...delivery("slack", "auth"), plainState: "problem" });
    const a = answerAll(f);
    expect(a.why).toEqual(explainFailure(f));
    expect(a.next.fix).toEqual(a.why!.fix);
    expect(a.next.lines).toEqual([...a.why!.lines, "Open the request in Activity to see every step."]);
  });
  it("names the plain kind of the step it stopped at", () => {
    const f = asked({ ...stepFacts({ statusCode: 404 }), plainState: "problem", steps: [{ type: "http", state: "failed", outcome: null, attempts: 2 }] });
    expect(answerAll(f).happened.lines).toEqual(["1 step ran.", "It stopped at: HTTP request."]);
  });
  it("puts a lint finding in next even when nothing stopped", () => {
    const a = answerAll(asked({ lint: [{ rule: "unreachable_step", count: 1 }] }));
    expect(a.why).toBeNull();
    expect(a.next.lines).toContain("Part of this automation can never be reached, so it will not run.");
  });
});
