import { describe, expect, it } from "vitest";
import { definitionSchema, httpConfigSchema, isIdempotent } from "./definition";

const VALID_CONFIG: Record<string, Record<string, unknown>> = {
  http: { method: "GET", url: "https://example.com/{{trigger.id}}" },
  email: { to: "ops@example.com", subject: "New inquiry", text: "{{trigger.message}}" },
  delay: { seconds: 60 },
  ai: { task: "classify", input: "{{trigger.message}}", labels: { billing: "Invoices", support: "Everything else" } },
  approval: { to: "boss@example.com", subject: "Approve?", message: "{{trigger.amount}}", timeoutSeconds: 3600 },
};
const step = (id: string, type = "http", config: Record<string, unknown> = VALID_CONFIG[type] ?? {}) => ({ id, type, config });
const triage = () => ({
  trigger: { type: "form", config: { fields: [{ name: "message", label: "Message", type: "textarea", required: true }] } },
  steps: [
    step("classify", "ai"),
    step("is_billing", "condition", { condition: { left: "{{steps.classify.output.label}}", op: "eq", right: "billing" } }),
    step("notify_billing", "email"),
    step("notify_support", "email"),
  ],
  edges: [
    { from: "classify", to: "is_billing" },
    { from: "is_billing", to: "notify_billing", on: "true" },
    { from: "is_billing", to: "notify_support", on: "false" },
  ],
});

function issues(input: unknown): string[] {
  const result = definitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe("definitionSchema", () => {
  it("accepts a linear flow with a branch", () => {
    expect(issues(triage())).toEqual([]);
  });

  describe("trigger config", () => {
    const withTrigger = (trigger: unknown) => ({ ...triage(), trigger });

    it("accepts email intake without embedding mailbox credentials in versions", () => {
      expect(issues(withTrigger({ type: "email", config: {} }))).toEqual([]);
      expect(issues(withTrigger({ type: "email", config: { password: "secret" } }))).not.toEqual([]);
    });

    it("needs at least one form field", () => {
      expect(issues(withTrigger({ type: "form", config: { fields: [] } }))).not.toEqual([]);
      expect(issues(withTrigger({ type: "form", config: {} }))).not.toEqual([]);
    });

    it("rejects form field names that are not safe identifiers", () => {
      const field = { name: "First Name", label: "First name", type: "text" };
      expect(issues(withTrigger({ type: "form", config: { fields: [field] } }))).not.toEqual([]);
    });

    it("rejects duplicate form field names", () => {
      const field = { name: "email", label: "Email", type: "email" };
      expect(issues(withTrigger({ type: "form", config: { fields: [field, field] } }))).toContain('duplicate form field "email"');
    });

    it("needs a cron expression for a schedule", () => {
      expect(issues(withTrigger({ type: "schedule", config: {} }))).not.toEqual([]);
      expect(issues(withTrigger({ type: "schedule", config: { cron: "0 9 * * 1" } }))).toEqual([]);
    });

    it("accepts a webhook with or without an HMAC secret name", () => {
      expect(issues(withTrigger({ type: "webhook" }))).toEqual([]);
      expect(issues(withTrigger({ type: "webhook", config: { hmacSecret: "stripe_signing" } }))).toEqual([]);
    });
  });

  it("accepts a single step with no edges", () => {
    expect(issues({ trigger: { type: "manual" }, steps: [step("only")] })).toEqual([]);
  });

  it("accepts approval branches and joins", () => {
    const def = {
      trigger: { type: "webhook" },
      steps: [step("ask", "approval"), step("pay"), step("remind", "email"), step("log")],
      edges: [
        { from: "ask", to: "pay", on: "approved" },
        { from: "ask", to: "remind", on: "timeout" },
        { from: "pay", to: "log" },
        { from: "remind", to: "log" },
      ],
    };
    expect(issues(def)).toEqual([]);
  });

  it("rejects a cycle", () => {
    const def = triage();
    def.edges.push({ from: "notify_billing", to: "classify" });
    expect(issues(def).join()).toMatch(/cycle/);
  });

  it("rejects a self loop", () => {
    const def = { trigger: { type: "manual" }, steps: [step("a")], edges: [{ from: "a", to: "a" }] };
    expect(issues(def).join()).toMatch(/cycle/);
  });

  it("rejects edges to unknown step ids", () => {
    const def = triage();
    def.edges.push({ from: "notify_billing", to: "ghost" });
    expect(issues(def).join()).toMatch(/unknown step "ghost"/);
  });

  it("rejects duplicate step ids", () => {
    const def = triage();
    def.steps.push(step("classify"));
    expect(issues(def).join()).toMatch(/duplicate step id "classify"/);
  });

  it("rejects more than one entry step", () => {
    const def = triage();
    def.steps.push(step("orphan"));
    expect(issues(def).join()).toMatch(/exactly one entry step/);
  });

  it("rejects parallel branches from a non-branching step", () => {
    const def = triage();
    def.edges.push({ from: "classify", to: "notify_support" });
    expect(issues(def).join()).toMatch(/more than one "next" edge/);
  });

  it("rejects branch labels that do not fit the step type", () => {
    const wrongLabel = triage();
    wrongLabel.edges[1]!.on = "maybe";
    expect(issues(wrongLabel).join()).toMatch(/"maybe" is not a branch of condition step/);

    const labelOnPlainStep = triage();
    labelOnPlainStep.edges[0] = { from: "classify", to: "is_billing", on: "true" };
    expect(issues(labelOnPlainStep).join()).toMatch(/does not branch/);

    const missingLabel = triage();
    delete missingLabel.edges[1]!.on;
    expect(issues(missingLabel).join()).toMatch(/needs a branch label/);
  });

  it("rejects two edges with the same branch label", () => {
    const def = triage();
    def.edges.push({ from: "is_billing", to: "notify_support", on: "true" });
    expect(issues(def).join()).toMatch(/more than one "true" edge/);
  });

  it("rejects a condition step without a valid condition", () => {
    const def = triage();
    def.steps[1] = step("is_billing", "condition", { condition: { left: "x", op: "matches" } });
    expect(issues(def).length).toBeGreaterThan(0);
  });

  it("rejects unknown step and trigger types", () => {
    expect(issues({ trigger: { type: "manual" }, steps: [step("a", "shell")] }).length).toBeGreaterThan(0);
    expect(issues({ trigger: { type: "unknown" }, steps: [step("a")] }).length).toBeGreaterThan(0);
  });

  it("rejects step ids that are unsafe in expressions", () => {
    for (const id of ["Has Space", "__proto__", "1st", "a.b", ""]) {
      expect(issues({ trigger: { type: "manual" }, steps: [step(id)] }).length, id).toBeGreaterThan(0);
    }
  });

  it("rejects definitions with no steps or more than 100 steps", () => {
    expect(issues({ trigger: { type: "manual" }, steps: [] }).length).toBeGreaterThan(0);
    const steps = Array.from({ length: 101 }, (_, i) => step(`s${i}`));
    const edges = steps.slice(1).map((s, i) => ({ from: `s${i}`, to: s.id }));
    expect(issues({ trigger: { type: "manual" }, steps, edges }).length).toBeGreaterThan(0);
  });

  describe("step config", () => {
    const one = (type: string, config: Record<string, unknown>) => issues({ trigger: { type: "manual" }, steps: [step("a", type, config)] });

    it("accepts a valid config for every step type", () => {
      for (const type of ["http", "email", "delay"]) expect(one(type, VALID_CONFIG[type]!), type).toEqual([]);
      expect(one("http", { method: "POST", url: "https://x.test", headers: { Authorization: "Bearer {{secrets.api_key}}" }, body: "{}" })).toEqual([]);
    });

    it("treats GET, PUT and DELETE as safe to repeat and POST and PATCH as not, unless the step says otherwise (P5)", () => {
      const cfg = (method: string, idempotent?: boolean) => httpConfigSchema.parse({ method, url: "https://x.test", idempotent });
      expect(["GET", "PUT", "DELETE", "POST", "PATCH"].map((m) => isIdempotent(cfg(m)))).toEqual([true, true, true, false, false]);
      expect(isIdempotent(cfg("POST", true))).toBe(true);
      expect(isIdempotent(cfg("PUT", false))).toBe(false);
      expect(one("http", { method: "POST", url: "https://x.test", idempotent: "yes" })).not.toEqual([]);
    });

    it("rejects http configs with a bad method, a long url or too many headers", () => {
      expect(one("http", { method: "TRACE", url: "https://x.test" })).not.toEqual([]);
      expect(one("http", { method: "GET", url: "https://x.test/" + "a".repeat(2000) })).not.toEqual([]);
      expect(one("http", { method: "GET" })).not.toEqual([]);
      const headers = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x-h${i}`, "v"]));
      expect(one("http", { method: "GET", url: "https://x.test", headers })).not.toEqual([]);
    });

    it("rejects email configs without a recipient, subject or text", () => {
      expect(one("email", { subject: "s", text: "t" })).not.toEqual([]);
      expect(one("email", { to: "a@b.test", text: "t" })).not.toEqual([]);
      expect(one("email", { to: "a@b.test", subject: "s" })).not.toEqual([]);
    });

    it("keeps delays between 1 second and 30 days, in whole seconds", () => {
      expect(one("delay", { seconds: 2_592_000 })).toEqual([]);
      for (const seconds of [0, 2_592_001, 1.5, "60"]) expect(one("delay", { seconds }), String(seconds)).not.toEqual([]);
    });
  });
});

describe("delay until and the late edge", () => {
  const wait = (config: Record<string, unknown>) => ({ id: "wait", type: "delay", config });
  const def = (config: Record<string, unknown>, edges: { from: string; to: string; on?: string }[] = [{ from: "wait", to: "remind" }]) => ({
    trigger: { type: "manual", config: {} },
    steps: [wait(config), step("remind", "email"), step("too_late", "email")],
    edges: [...edges, ...(edges.some((e) => e.to === "too_late") ? [] : [{ from: "remind", to: "too_late" }])],
  });
  const errs = (input: unknown) => {
    const r = definitionSchema.safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it("saves a delay until a time with an offset before or after it", () => {
    expect(errs(def({ until: "{{trigger.appointment_at}}", offsetSeconds: -3600 }))).toEqual([]);
    expect(errs(def({ until: "{{trigger.appointment_at}}" }))).toEqual([]);
  });

  it("needs exactly one of seconds and until, and an offset only with until", () => {
    expect(errs(def({}))).toEqual(["steps.0.config.seconds: set either seconds or until"]);
    expect(errs(def({ seconds: 60, until: "{{trigger.at}}" }))).toEqual(["steps.0.config.seconds: set either seconds or until"]);
    expect(errs(def({ seconds: 60, offsetSeconds: -60 }))).toEqual(["steps.0.config.offsetSeconds: offsetSeconds needs until"]);
    expect(errs(def({ until: "{{trigger.at}}", offsetSeconds: 2_592_001 }))).not.toEqual([]);
    expect(errs(def({ until: "" }))).not.toEqual([]);
  });

  it("allows a late edge next to the usual one, only on a delay with until", () => {
    const both = [{ from: "wait", to: "remind" }, { from: "wait", to: "too_late", on: "late" }];
    expect(errs(def({ until: "{{trigger.at}}" }, both))).toEqual([]);
    expect(errs(def({ seconds: 60 }, both))).toEqual([': only a delay with "until" can have a "late" edge, and "wait" waits a fixed time']);
    expect(errs(def({ until: "{{trigger.at}}" }, [{ from: "wait", to: "remind" }, { from: "wait", to: "too_late", on: "early" }]))).toEqual([': step "wait" does not branch, so its edge cannot have a label']);
  });
});

describe("booking step", () => {
  const at = { name: "at", label: "At", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 };
  const who = { name: "who", label: "Who", type: "resource", required: true };
  const ref = { name: "ref", label: "Reference", type: "text", required: true };
  const book = (config: Record<string, unknown>) => ({ id: "book", type: "booking", config });
  const create = { action: "create", resource: "{{trigger.who}}", start: "{{trigger.at}}", minutes: 60 };
  const def = (trigger: object, config: Record<string, unknown>, edges: { from: string; to: string; on?: string }[] = [{ from: "book", to: "ok", on: "done" }]) => ({
    trigger,
    steps: [book(config), step("ok", "email"), step("busy", "email")],
    edges: [...edges, { from: "ok", to: "busy" }].filter((e, i, all) => all.findIndex((x) => x.to === e.to) === i),
  });
  const form = { type: "form", config: { fields: [at, who] } };
  const signed = (fields: object[]) => ({ type: "webhook", config: { hmacSecret: "booking_hook", fields } });
  const errs = (input: unknown) => {
    const r = definitionSchema.safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it("saves a create step on a form with a datetime field, with done, taken and not_found branches", () => {
    expect(errs(def(form, create, [{ from: "book", to: "ok", on: "done" }, { from: "book", to: "busy", on: "taken" }]))).toEqual([]);
    expect(errs(def(form, create, [{ from: "book", to: "ok", on: "booked" }]))).toEqual([': "booked" is not a branch of booking step "book"']);
  });

  it("needs the fields each action uses, and no others", () => {
    expect(errs(def(form, { action: "create", start: "{{trigger.at}}", minutes: 60 }))).toEqual(["steps.0.config.resource: a create needs resource, start and minutes"]);
    expect(errs(def(form, { ...create, minutes: 0 }))).not.toEqual([]);
    expect(errs(def(form, { ...create, minutes: 1441 }))).not.toEqual([]);
    expect(errs(def(form, { ...create, booking: "{{trigger.ref}}" }))).toEqual(["steps.0.config.booking: a create makes a new booking, so it takes no booking reference"]);
    expect(errs(def(signed([ref, at]), { action: "cancel", booking: "{{trigger.ref}}", start: "{{trigger.at}}" }))).toEqual(["steps.0.config.start: a cancel takes only the booking reference"]);
    expect(errs(def(signed([ref, at]), { action: "reschedule", start: "{{trigger.at}}" }))).toEqual(["steps.0.config.booking: a reschedule needs booking and start"]);
  });

  it("takes the start only from a datetime field of the trigger, so the field's zone and slot rules apply", () => {
    const start = ': booking step "book" needs start to be {{trigger.<field>}} for a datetime field of the trigger';
    expect(errs(def(form, { ...create, start: "{{trigger.who}}" }))).toEqual([start]);
    expect(errs(def(form, { ...create, start: "2030-01-01T10:00:00+08:00" }))).toEqual([start]);
    expect(errs(def(form, { ...create, start: "{{steps.x.output.at}}" }))).toEqual([start]);
    expect(errs(def({ type: "manual", config: {} }, create))).toEqual([start]);
    expect(errs(def(form, { ...create, start: "{{ trigger.at }}" }))).toEqual([]);
  });

  it("lets only staff and signed webhooks reschedule or cancel", () => {
    const cancel = { action: "cancel", booking: "{{trigger.ref}}" };
    const reschedule = { action: "reschedule", booking: "{{trigger.ref}}", start: "{{trigger.at}}" };
    const who = ': booking step "book" can reschedule or cancel only from a manual trigger or a webhook with a signing secret';
    expect(errs(def(signed([ref, at]), reschedule))).toEqual([]);
    expect(errs(def(signed([ref]), cancel))).toEqual([]);
    expect(errs(def({ type: "manual", config: {} }, cancel))).toEqual([]);
    expect(errs(def({ type: "form", config: { fields: [ref, at] } }, reschedule))).toEqual([who]);
    expect(errs(def({ type: "webhook", config: { fields: [ref] } }, cancel))).toEqual([who]);
    expect(errs(def({ type: "schedule", config: { cron: "0 9 * * 1" } }, cancel))).toEqual([who]);
  });
});
