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

    it("refuses a blank or malformed HMAC secret name", () => {
      for (const hmacSecret of ["", "Has Caps", "1abc", "a".repeat(101)]) expect(issues(withTrigger({ type: "webhook", config: { hmacSecret } }))).not.toEqual([]);
    });

    it("takes a payment trigger, paid by default, and refuses unknown events", () => {
      expect(issues(withTrigger({ type: "payment" }))).toEqual([]);
      expect(issues(withTrigger({ type: "payment", config: { events: ["paid", "refunded"] } }))).toEqual([]);
      expect(issues(withTrigger({ type: "payment", config: { events: [] } }))).not.toEqual([]);
      expect(issues(withTrigger({ type: "payment", config: { events: ["failed"] } }))).not.toEqual([]);
      expect(definitionSchema.parse(withTrigger({ type: "payment" })).trigger).toEqual({ type: "payment", config: { events: ["paid"] } });
    });

    it("takes a paymongo_link step with amount, description and reference", () => {
      const config = { amount: "{{trigger.total}}", description: "Order", reference: "ORD-1" };
      expect(issues({ trigger: { type: "manual" }, steps: [step("pay", "paymongo_link", config)] })).toEqual([]);
      expect(issues({ trigger: { type: "manual" }, steps: [step("pay", "paymongo_link", { amount: "5" })] })).not.toEqual([]);
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

describe("conversation steps (decision 0115)", () => {
  const errs = (input: unknown) => {
    const r = definitionSchema.safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  const reply = { id: "reply", type: "meta_reply", config: { text: "Hi" } };
  const save = { id: "save", type: "conversation_update", config: { fields: { guests: "{{steps.ai.output.guests}}" } } };

  it("lets a Meta reply add outside_window and paused edges, and no other label", () => {
    const def = (on: string) => ({ trigger: { type: "meta_dm", config: {} }, steps: [reply, step("next", "email"), step("other", "email")], edges: [{ from: "reply", to: "next" }, { from: "reply", to: "other", on }] });
    expect(errs(def("outside_window"))).toEqual([]);
    expect(errs(def("paused"))).toEqual([]);
    expect(errs(def("late"))).toEqual([': step "reply" does not branch, so its edge cannot have a label']);
  });

  it("saves conversation fields only from a message trigger, with a fixed field list", () => {
    expect(errs({ trigger: { type: "meta_dm", config: {} }, steps: [save] })).toEqual([]);
    expect(errs({ trigger: { type: "email", config: {} }, steps: [save] })).toEqual([]);
    expect(errs({ trigger: { type: "manual", config: {} }, steps: [save] })).toEqual([': conversation_update step "save" needs a meta_dm, whatsapp_message or email trigger, which starts a conversation']);
    expect(errs({ trigger: { type: "meta_dm", config: {} }, steps: [{ ...save, config: { fields: { budget: "1" } } }] })).not.toEqual([]);
    expect(errs({ trigger: { type: "meta_dm", config: {} }, steps: [{ ...save, config: { fields: {} } }] })).not.toEqual([]);
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

  describe("stay mode (C5)", () => {
    const stayCreate = { action: "create", mode: "stay", resource: "{{trigger.room_id}}", checkIn: "{{trigger.check_in}}", nights: "{{trigger.nights}}", timezone: "Asia/Manila" };
    const stayMove = { action: "reschedule", mode: "stay", booking: "{{trigger.ref}}", checkIn: "{{trigger.check_in}}" };
    const manual = { type: "manual", config: {} };
    const payment = { type: "payment", config: { events: ["paid"] } };

    it("accepts stay create from manual, confirmed payment or signed webhook triggers", () => {
      expect(errs(def(manual, stayCreate))).toEqual([]);
      expect(errs(def(payment, stayCreate))).toEqual([]);
      expect(errs(def(signed([ref]), { ...stayCreate, nights: 3 }))).toEqual([]);
    });

    it("refuses stay create from guest-facing or unsigned triggers, and from AI step output", () => {
      for (const t of [
        { type: "meta_dm", config: {} },
        { type: "email", config: {} },
        form,
        { type: "webhook", config: { fields: [ref] } },
        { type: "telegram_message", config: {} },
      ]) {
        expect(errs(def(t, stayCreate)).join(), t.type).toMatch(/stay mode can only run from a manual trigger/);
      }
      const fromAi = {
        trigger: manual,
        steps: [
          { id: "extract", type: "ai", config: { task: "extract", input: "{{trigger.note}}", fields: { check_in: "date" } } },
          book({ ...stayCreate, checkIn: "{{steps.extract.output.check_in}}" }),
          step("ok", "email"),
        ],
        edges: [{ from: "extract", to: "book" }, { from: "book", to: "ok", on: "done" }],
      };
      expect(errs(fromAi).join()).toMatch(/AI step "extract"/);
    });

    it("validates stay mode fields and refuses mixing slot and stay fields", () => {
      expect(errs(def(manual, { action: "create", mode: "stay", resource: "r", checkIn: "2031-05-01" })).join()).toMatch(/checkIn and nights/);
      expect(errs(def(manual, { ...stayCreate, start: "{{trigger.at}}" })).join()).toMatch(/stay mode uses checkIn/);
      expect(errs(def(manual, { ...stayCreate, minutes: 60 })).join()).toMatch(/stay mode uses checkIn/);
      expect(errs(def(manual, { ...stayCreate, nights: 31 }))).not.toEqual([]);
      expect(errs(def(manual, { ...stayCreate, nights: "0" }))).not.toEqual([]);
      expect(errs(def(manual, { ...stayCreate, timezone: "+08:00" })).join()).toMatch(/IANA timezone/);
      expect(errs(def(manual, stayMove))).toEqual([]);
      expect(errs(def(manual, { ...stayMove, nights: 2 })).join()).toMatch(/keeps its nights/);
      expect(errs(def(form, { ...create, checkIn: "2031-05-01" })).join()).toMatch(/stay mode/);
    });
  });
});

describe("ai step files", () => {
  const form = (fields: unknown[], files: string[]) => ({
    trigger: { type: "form", config: { fields } },
    steps: [step("read", "ai", { task: "summarize", input: "x", files })],
    edges: [],
  });
  const file = { name: "receipt", label: "Receipt", type: "file", required: true };
  const bad = (n: string) => `ai step "read" reads "${n}", which is not a file field of the form`;
  it("accepts a file field of the form and rejects anything else", () => {
    expect(issues(form([file], ["receipt"]))).toEqual([]);
    expect(issues(form([file], ["nope"]))).toContain(bad("nope"));
    expect(issues(form([{ name: "note", label: "Note", type: "text", required: false }], ["note"]))).toContain(bad("note"));
    expect(issues({ ...form([file], ["receipt"]), trigger: { type: "manual", config: {} } })).toContain(bad("receipt"));
  });

  it("allows meta_dm triggers with image files, drive steps and meta_reply steps", () => {
    const ok = definitionSchema.parse({
      trigger: { type: "meta_dm", config: {} },
      steps: [
        { id: "read", type: "ai", config: { task: "summarize", input: "{{trigger.text}}", files: ["image"] } },
        { id: "save", type: "drive", config: {} },
        { id: "reply", type: "meta_reply", config: { text: "Thanks!" } },
      ],
      edges: [
        { from: "read", to: "save" },
        { from: "save", to: "reply" },
      ],
    });
    expect(ok.trigger).toEqual({ type: "meta_dm", config: { channel: "both", requireImage: false } });
    expect(ok.steps[2]).toEqual({ id: "reply", type: "meta_reply", config: { recipientId: "{{trigger.senderId}}", channel: "{{trigger.channel}}", text: "Thanks!" } });
    expect(issues({ trigger: { type: "meta_dm", config: { channel: "viber" } }, steps: [step("a")] })).not.toEqual([]);
    expect(issues({ trigger: { type: "meta_dm", config: {} }, steps: [step("read", "ai", { task: "summarize", input: "x", files: ["receipt"] })] })).toContain(bad("receipt"));
    expect(issues({ trigger: { type: "meta_dm", config: {} }, steps: [{ id: "r", type: "meta_reply", config: { text: "x".repeat(2001) } }] })).not.toEqual([]);
    expect(issues({ trigger: { type: "meta_dm", config: {} }, steps: [{ id: "r", type: "meta_reply", config: { text: "" } }] })).not.toEqual([]);
  });
});

describe("disabled steps (decision 0097)", () => {
  const off = <T extends object>(s: T) => ({ ...s, disabled: true });

  it("keeps disabled: true on a step that does not branch", () => {
    const def = triage();
    def.steps[0] = off(def.steps[0]!);
    const parsed = definitionSchema.parse(def);
    expect(parsed.steps[0]!.disabled).toBe(true);
    expect(parsed.steps[2]!.disabled).toBeUndefined();
  });

  it("refuses a disabled branching step, since a skipped step has no branch to follow", () => {
    const def = triage();
    def.steps[1] = off(def.steps[1]!);
    expect(issues(def)).toContain('condition step "is_billing" branches, so it cannot be turned off');
  });

  it("accepts only true, so an enabled step carries no disabled key", () => {
    const def = triage();
    def.steps[0] = { ...def.steps[0]!, disabled: false } as never;
    expect(issues(def).length).toBeGreaterThan(0);
  });
});

describe("step notes (T4)", () => {
  const noted = (note: unknown) => {
    const def = triage();
    def.steps[0] = { ...def.steps[0]!, note } as never;
    return def;
  };

  it("keeps a note of up to 300 characters as typed, braces and all", () => {
    expect(definitionSchema.parse(noted("x".repeat(300))).steps[0]!.note).toHaveLength(300);
    expect(definitionSchema.parse(noted("Ask {{trigger.name}} first")).steps[0]!.note).toBe("Ask {{trigger.name}} first");
    expect(definitionSchema.parse(triage()).steps[0]!.note).toBeUndefined();
  });

  it("refuses a note over 300 characters or one that is not text", () => {
    expect(issues(noted("x".repeat(301))).length).toBeGreaterThan(0);
    expect(issues(noted(42)).length).toBeGreaterThan(0);
    expect(issues(noted(["a"])).length).toBeGreaterThan(0);
  });
});

// Review of 22 November, M4: the price of a due must not come from a public visitor, or their own number is what counts as paid.
describe("payment_due amount", () => {
  const due = (amount: string, total?: string) => ({ id: "ask", type: "payment_due", config: { reference: "{{trigger.order_id}}", kind: "deposit", amount, ...(total !== undefined && { total }), checkout: true } });
  const fields = [{ name: "order_id", label: "Order", type: "text", required: true }, { name: "amount", label: "Amount", type: "number", required: true }];
  const def = (trigger: object, amount: string, total?: string) => ({ trigger, steps: [due(amount, total)], edges: [] });
  const form = { type: "form", config: { fields } };
  const signed = { type: "webhook", config: { hmacSecret: "order_webhook_secret", requireTimestamp: true, fields } };
  const unsigned = { type: "webhook", config: { fields } };
  const dm = { type: "meta_dm", config: {} };

  it("refuses an amount or total from the trigger of a public form, an unsigned webhook or a direct message", () => {
    for (const t of [form, unsigned, dm]) {
      expect(issues(def(t, "{{trigger.amount}}")).join()).toMatch(/payment_due step "ask".*amount/);
      expect(issues(def(t, "350", "{{ trigger.amount }}")).join()).toMatch(/payment_due step "ask".*amount/);
    }
  });

  it("takes a fixed amount anywhere and a trigger amount from a signed webhook or a manual run", () => {
    expect(issues(def(form, "350", "1200"))).toEqual([]);
    expect(issues(def(signed, "{{trigger.amount}}"))).toEqual([]);
    expect(issues(def({ type: "manual", config: { fields } }, "{{trigger.amount}}"))).toEqual([]);
  });

  // L7 (decision 0119): a price is followed through the steps it is read from, so model output cannot become an amount.
  const manual = { type: "manual", config: { fields: [{ name: "room", label: "Room", type: "text", required: true }] } };
  const ai = { id: "read", type: "ai", config: { task: "extract", input: "{{trigger.room}}", fields: { amount: "the amount" } } };
  const quote = (nights: string) => ({ id: "quote", type: "stay_quote", config: { room: "{{trigger.room}}", checkIn: "2026-12-14", nights, guests: "2" } });
  const chain = (trigger: object, steps: { id: string }[], amount: string) => {
    const all = [...steps, due(amount)];
    return { trigger, steps: all, edges: all.slice(1).map((s, i) => ({ from: all[i]!.id, to: s.id })) };
  };

  it("refuses an amount read from an AI step, directly or through another step", () => {
    expect(issues(chain(manual, [ai], "{{steps.read.output.amount}}")).join()).toMatch(/payment_due step "ask".*AI step "read"/);
    const relay = { id: "relay", type: "http", config: { method: "POST", url: "https://example.com/price", headers: {}, body: "{{steps.read.output.amount}}" } };
    expect(issues(chain(manual, [ai, relay], "{{steps.relay.output.body}}")).join()).toMatch(/AI step "read"/);
    expect(issues(chain(manual, [ai, quote("{{steps.read.output.amount}}")], "{{steps.quote.output.deposit}}")).join()).toMatch(/AI step "read"/);
  });

  it("refuses an amount from a step that reads a public visitor's text", () => {
    expect(issues(chain(dm, [quote("{{trigger.text}}")], "{{steps.quote.output.deposit}}")).join()).toMatch(/payment_due step "ask".*meta_dm trigger/);
  });

  it("takes a stay_quote deposit when its inputs come from staff", () => {
    expect(issues(chain(manual, [quote("{{trigger.room}}")], "{{steps.quote.output.deposit}}"))).toEqual([]);
  });
});

// I2 (decision 0105): a Shopify step writes to the owner's store, so a stranger's text must not choose what it writes.
describe("Shopify steps and trigger", () => {
  const fields = [{ name: "sku", label: "SKU", type: "text", required: true }];
  const create = (title: string) => ({ id: "make", type: "shopify_create_product", config: { title, price: "10" } });
  const def = (trigger: object, step: object) => ({ trigger, steps: [step], edges: [] });
  const form = { type: "form", config: { fields } };
  const order = { type: "shopify_order", config: {} };

  it("accepts the order trigger and a new product that is a draft unless told otherwise", () => {
    expect(issues(def(order, create("Tote {{trigger.order_number}}")))).toEqual([]);
    const parsed = definitionSchema.parse(def(order, { id: "make", type: "shopify_create_product", config: { title: "Tote" } }));
    expect(parsed.steps[0]).toMatchObject({ config: { status: "draft" } });
  });

  it("refuses a product step whose fields come from a public form, an unsigned webhook or a message", () => {
    for (const t of [form, { type: "webhook", config: { fields } }, { type: "meta_dm", config: {} }, { type: "email", config: {} }]) {
      expect(issues(def(t, create("{{trigger.sku}}"))).join(), t.type).toMatch(/shopify_create_product step "make" cannot take its fields from a/);
      expect(issues(def(t, { id: "make", type: "shopify_update_product", config: { product: "{{ trigger.sku }}", price: "5" } })).join(), t.type).toMatch(/shopify_update_product step "make"/);
    }
  });

  it("takes fixed values from a form, and trigger values from an order, a signed webhook or a manual run", () => {
    expect(issues(def(form, create("Tote")))).toEqual([]);
    expect(issues(def({ type: "webhook", config: { hmacSecret: "shop_secret", fields } }, create("{{trigger.sku}}")))).toEqual([]);
    expect(issues(def({ type: "manual", config: { fields } }, create("{{trigger.sku}}")))).toEqual([]);
  });

  it("makes an update change something", () => {
    expect(issues(def(order, { id: "up", type: "shopify_update_product", config: { product: "TOTE-1" } })).join()).toMatch(/choose at least one thing to change/);
    expect(issues(def(order, { id: "up", type: "shopify_update_product", config: { product: "TOTE-1", price: "12", status: "active" } }))).toEqual([]);
  });

  it("refuses Shopify product fields coming from an AI step or indirectly from an untrusted trigger (S5)", () => {
    const manual = { type: "manual", config: { fields } };
    const ai = { id: "draft", type: "ai", config: { task: "draft", input: "Write a product title" } };
    const relay = { id: "relay", type: "http", config: { method: "GET", url: "https://example.com/?q={{steps.draft.output.text}}", headers: {} } };
    const chainDef = (trigger: object, steps: object[]) => ({
      trigger,
      steps,
      edges: steps.slice(1).map((s, i) => ({ from: (steps[i] as { id: string }).id, to: (s as { id: string }).id })),
    });

    expect(issues(chainDef(manual, [ai, create("{{steps.draft.output.text}}")])).join()).toMatch(/shopify_create_product step "make".*AI step "draft"/);
    expect(issues(chainDef(manual, [ai, relay, { id: "up", type: "shopify_update_product", config: { product: "TOTE-1", description: "{{steps.relay.output.body}}" } }])).join()).toMatch(/shopify_update_product step "up".*AI step "draft"/);

    const formRelay = { id: "relay", type: "http", config: { method: "GET", url: "https://example.com/?q={{trigger.sku}}", headers: {} } };
    expect(issues(chainDef(form, [formRelay, create("{{steps.relay.output.body}}")])).join()).toMatch(/shopify_create_product step "make".*step "relay"/);
  });
});

// G1 (decision 0123): kymavo internal triggers (booking_event, payment_event) and reusable sub-workflows.
describe("G1 internal triggers and call_workflow step", () => {
  const step = { id: "wait", type: "delay", config: { seconds: 5 } };

  it("accepts booking_event, payment_event, and sub_workflow triggers with sensible defaults", () => {
    const b = definitionSchema.parse({ trigger: { type: "booking_event" }, steps: [step], edges: [] });
    expect(b.trigger).toEqual({ type: "booking_event", config: { events: ["created"] } });

    const p = definitionSchema.parse({ trigger: { type: "payment_event", config: { events: ["confirmed", "expired"] } }, steps: [step], edges: [] });
    expect(p.trigger).toEqual({ type: "payment_event", config: { events: ["confirmed", "expired"] } });

    const s = definitionSchema.parse({ trigger: { type: "sub_workflow", config: { fields: [{ name: "ref", label: "Reference", type: "text", required: true }] } }, steps: [step], edges: [] });
    expect(s.trigger.type).toBe("sub_workflow");
  });

  it("refuses payment_due amounts taken from a sub_workflow trigger (preserves L7 boundary)", () => {
    const def = {
      trigger: { type: "sub_workflow", config: { fields: [{ name: "amount", label: "Amount", type: "text", required: true }] } },
      steps: [{ id: "ask", type: "payment_due", config: { reference: "R-1", amount: "{{trigger.amount}}" } }],
      edges: [],
    };
    expect(issues(def).join()).toMatch(/payment_due step "ask" cannot take its amount or total from a sub_workflow trigger/);
  });

  it("validates call_workflow step slugs and template payload fields", () => {
    const validCall = {
      trigger: { type: "manual", config: {} },
      steps: [{ id: "run_child", type: "call_workflow", config: { workflowSlug: "notify-team", payload: { ref: "{{trigger.ref}}" } } }],
      edges: [],
    };
    expect(issues(validCall)).toEqual([]);

    const badSlug = {
      trigger: { type: "manual", config: {} },
      steps: [{ id: "run_child", type: "call_workflow", config: { workflowSlug: "Bad Slug!", payload: {} } }],
      edges: [],
    };
    expect(issues(badSlug).join()).toMatch(/a-z, 0-9 and -/);
  });
});

// G2 (decision 0127): Google Workspace triggers.
describe("Google triggers", () => {
  const s = step("a");
  it("needs a tab for sheets_row and defaults calendar_event and drive_file", () => {
    expect(definitionSchema.safeParse({ trigger: { type: "sheets_row", config: {} }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.parse({ trigger: { type: "sheets_row", config: { tab: " Orders " } }, steps: [s], edges: [] }).trigger).toEqual({ type: "sheets_row", config: { tab: "Orders" } });
    expect(definitionSchema.parse({ trigger: { type: "calendar_event" }, steps: [s], edges: [] }).trigger).toEqual({ type: "calendar_event", config: { on: "created", minutesBefore: 60 } });
    expect(definitionSchema.parse({ trigger: { type: "drive_file" }, steps: [s], edges: [] }).trigger).toEqual({ type: "drive_file", config: { requireFile: false } });
  });
  it("refuses a reminder window outside 5 minutes to a day, and unknown keys", () => {
    expect(definitionSchema.safeParse({ trigger: { type: "calendar_event", config: { on: "starting", minutesBefore: 2 } }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "drive_file", config: { folderId: "x" } }, steps: [s], edges: [] }).success).toBe(false);
  });
});

describe("assistant_read step (J1)", () => {
  it("defaults what to all (the worker reads in Asia/Manila unless a timezone is set), and accepts each read scope", () => {
    const def = definitionSchema.parse({
      trigger: { type: "telegram_message" },
      steps: [{ id: "read_data", type: "assistant_read", config: {} }],
      edges: [],
    });
    expect(def.steps[0]?.config).toEqual({ what: "all" });

    for (const what of ["all", "calendar", "bookings", "payments", "runs"] as const) {
      const parsed = definitionSchema.parse({
        trigger: { type: "telegram_message" },
        steps: [{ id: "read_data", type: "assistant_read", config: { what, timezone: "UTC" } }],
        edges: [],
      });
      expect(parsed.steps[0]?.config).toEqual({ what, timezone: "UTC" });
    }
  });

  it("rejects invalid scopes, non-IANA timezones, and extra keys", () => {
    expect(definitionSchema.safeParse({
      trigger: { type: "telegram_message" },
      steps: [{ id: "read_data", type: "assistant_read", config: { what: "secrets" } }],
      edges: [],
    }).success).toBe(false);
    expect(definitionSchema.safeParse({
      trigger: { type: "telegram_message" },
      steps: [{ id: "read_data", type: "assistant_read", config: { timezone: "+08:00" } }],
      edges: [],
    }).success).toBe(false);
    expect(definitionSchema.safeParse({
      trigger: { type: "telegram_message" },
      steps: [{ id: "read_data", type: "assistant_read", config: { what: "all", userId: "other" } }],
      edges: [],
    }).success).toBe(false);
  });
});

// G3 (decision 0132): Connected mailbox triggers.
describe("Mailbox triggers", () => {
  const s = step("a");
  it("defaults empty config and trims optional filters for gmail_message and outlook_message", () => {
    expect(definitionSchema.parse({ trigger: { type: "gmail_message" }, steps: [s], edges: [] }).trigger).toEqual({ type: "gmail_message", config: {} });
    expect(definitionSchema.parse({ trigger: { type: "outlook_message" }, steps: [s], edges: [] }).trigger).toEqual({ type: "outlook_message", config: {} });
    expect(
      definitionSchema.parse({
        trigger: { type: "gmail_message", config: { from: " orders@example.com ", subjectContains: " Invoice ", label: " INBOX " } },
        steps: [s],
        edges: [],
      }).trigger,
    ).toEqual({ type: "gmail_message", config: { from: "orders@example.com", subjectContains: "Invoice", label: "INBOX" } });
    expect(
      definitionSchema.parse({
        trigger: { type: "outlook_message", config: { from: " orders@example.com ", subjectContains: " Receipt ", folder: " Orders " } },
        steps: [s],
        edges: [],
      }).trigger,
    ).toEqual({ type: "outlook_message", config: { from: "orders@example.com", subjectContains: "Receipt", folder: "Orders" } });
  });

  it("refuses blank strings, unknown keys, and untrusted payment amounts from mailbox triggers", () => {
    expect(definitionSchema.safeParse({ trigger: { type: "gmail_message", config: { from: "   " } }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "gmail_message", config: { folder: "Inbox" } }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "outlook_message", config: { label: "INBOX" } }, steps: [s], edges: [] }).success).toBe(false);
    const dueStep = { id: "due", type: "payment_due", config: { reference: "R-1", amount: "{{trigger.text}}", kind: "deposit", checkout: false } };
    expect(definitionSchema.safeParse({ trigger: { type: "gmail_message", config: {} }, steps: [dueStep], edges: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "outlook_message", config: {} }, steps: [dueStep], edges: [] }).success).toBe(false);
  });
});

// G4 (decision 0133): web page / RSS monitor and verified team chat triggers.
describe("G4 monitor and team chat triggers", () => {
  const s = step("a");

  it("validates page_changed page and feed configs and rejects CSS selector in feed mode", () => {
    expect(definitionSchema.parse({ trigger: { type: "page_changed", config: { url: "https://example.com/prices" } }, steps: [s], edges: [] }).trigger).toEqual({
      type: "page_changed",
      config: { mode: "page", url: "https://example.com/prices", maxChars: 4000 },
    });
    expect(definitionSchema.parse({ trigger: { type: "page_changed", config: { mode: "feed", url: "https://example.com/feed.xml" } }, steps: [s], edges: [] }).trigger).toEqual({
      type: "page_changed",
      config: { mode: "feed", url: "https://example.com/feed.xml", maxChars: 4000 },
    });
    expect(definitionSchema.safeParse({ trigger: { type: "page_changed", config: { mode: "feed", url: "https://example.com/feed.xml", selector: ".price" } }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "page_changed", config: { url: "ftp://example.com" } }, steps: [s], edges: [] }).success).toBe(false);
  });

  it("validates slack_message, teams_message, and discord_message configs strictly", () => {
    expect(definitionSchema.parse({ trigger: { type: "slack_message", config: { signingSecret: "slack_sig" } }, steps: [s], edges: [] }).trigger).toEqual({
      type: "slack_message",
      config: { signingSecret: "slack_sig", ignoreBots: true },
    });
    expect(definitionSchema.safeParse({ trigger: { type: "slack_message", config: {} }, steps: [s], edges: [] }).success).toBe(false);

    expect(definitionSchema.parse({ trigger: { type: "teams_message", config: { signingSecret: "teams_sig", textContains: "urgent" } }, steps: [s], edges: [] }).trigger).toEqual({
      type: "teams_message",
      config: { signingSecret: "teams_sig", textContains: "urgent" },
    });

    expect(definitionSchema.safeParse({ trigger: { type: "discord_message", config: {} }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "discord_message", config: { publicKey: "not-hex" } }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.parse({ trigger: { type: "discord_message", config: { publicKey: "a".repeat(64) } }, steps: [s], edges: [] }).trigger).toEqual({
      type: "discord_message",
      config: { publicKey: "a".repeat(64) },
    });
    expect(definitionSchema.parse({ trigger: { type: "discord_message", config: { signingSecret: "discord_relay" } }, steps: [s], edges: [] }).trigger).toEqual({
      type: "discord_message",
      config: { signingSecret: "discord_relay" },
    });
  });

  it("blocks payment_due and shopify amount/field injection from G4 public monitor and chat triggers", () => {
    const pageTrigger = { type: "page_changed", config: { url: "https://example.com" } };
    const slackTrigger = { type: "slack_message", config: { signingSecret: "s" } };
    expect(issues({ trigger: pageTrigger, steps: [{ id: "ask", type: "payment_due", config: { reference: "R1", amount: "{{trigger.text}}" } }], edges: [] }).join()).toMatch(/payment_due step "ask"/);
    expect(issues({ trigger: slackTrigger, steps: [{ id: "make", type: "shopify_create_product", config: { title: "{{trigger.text}}", price: "10" } }], edges: [] }).join()).toMatch(/shopify_create_product step "make"/);
  });
});

// G5 (decision 0134): Record-tool triggers.
describe("Record-tool triggers", () => {
  const s = step("a");
  it("defaults airtable_record, notion_page, and trello_card and validates status fields", () => {
    expect(definitionSchema.parse({ trigger: { type: "airtable_record" }, steps: [s], edges: [] }).trigger).toEqual({ type: "airtable_record", config: { on: "created" } });
    expect(definitionSchema.parse({ trigger: { type: "notion_page" }, steps: [s], edges: [] }).trigger).toEqual({ type: "notion_page", config: { on: "created" } });
    expect(definitionSchema.parse({ trigger: { type: "trello_card" }, steps: [s], edges: [] }).trigger).toEqual({ type: "trello_card", config: { on: "created" } });

    expect(definitionSchema.parse({ trigger: { type: "airtable_record", config: { on: "status_changed", statusField: " Status " } }, steps: [s], edges: [] }).trigger).toEqual({
      type: "airtable_record",
      config: { on: "status_changed", statusField: "Status" },
    });
    expect(definitionSchema.parse({ trigger: { type: "notion_page", config: { on: "status_changed", statusProperty: " Stage " } }, steps: [s], edges: [] }).trigger).toEqual({
      type: "notion_page",
      config: { on: "status_changed", statusProperty: "Stage" },
    });
    expect(definitionSchema.parse({ trigger: { type: "trello_card", config: { on: "moved_to_list" } }, steps: [s], edges: [] }).trigger).toEqual({
      type: "trello_card",
      config: { on: "moved_to_list" },
    });
  });

  it("refuses missing statusField/statusProperty or unknown keys", () => {
    expect(definitionSchema.safeParse({ trigger: { type: "airtable_record", config: { on: "status_changed" } }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "airtable_record", config: { on: "created", statusField: "Status" } }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "notion_page", config: { on: "status_changed" } }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "notion_page", config: { on: "created", statusProperty: "Status" } }, steps: [s], edges: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "trello_card", config: { listId: "x" } }, steps: [s], edges: [] }).success).toBe(false);
  });
});

// C10 / N25 (decision 0138): WhatsApp Cloud API trigger and service/template reply steps.
describe("WhatsApp Cloud API trigger and whatsapp_reply step", () => {
  it("parses whatsapp_message trigger and both whatsapp_reply modes (text and template)", () => {
    const textFlow = definitionSchema.parse({
      trigger: { type: "whatsapp_message" },
      steps: [
        { id: "save", type: "conversation_update", config: { fields: { name: "{{trigger.senderName}}" } } },
        { id: "reply", type: "whatsapp_reply", config: { to: "{{trigger.senderId}}", text: "Hi {{trigger.senderName}}" } },
        { id: "late", type: "sms", config: { to: "{{trigger.senderId}}", message: "Fallback SMS" } },
        { id: "staff", type: "delay", config: { seconds: 10 } },
      ],
      edges: [
        { from: "save", to: "reply" },
        { from: "reply", to: "late", on: "outside_window" },
        { from: "reply", to: "staff", on: "paused" },
      ],
    });
    expect(textFlow.trigger).toEqual({ type: "whatsapp_message", config: { requireImage: false } });
    expect(issues(textFlow)).toEqual([]);

    const templateFlow = definitionSchema.parse({
      trigger: { type: "booking_event", config: { events: ["created"] } },
      steps: [
        {
          id: "remind",
          type: "whatsapp_reply",
          config: {
            mode: "template",
            to: "{{trigger.conversationId}}",
            templateName: "deposit_reminder",
            templateLanguage: "en_US",
            templateParams: ["{{trigger.reference}}", "PHP 500"],
          },
        },
      ],
      edges: [],
    });
    expect(issues(templateFlow)).toEqual([]);
  });

  it("refuses invalid whatsapp_reply modes, bad template names, and untrusted amount injection", () => {
    expect(
      definitionSchema.safeParse({
        trigger: { type: "whatsapp_message" },
        steps: [{ id: "r", type: "whatsapp_reply", config: { mode: "text", to: "{{trigger.senderId}}" } }],
        edges: [],
      }).success,
    ).toBe(false);

    expect(
      definitionSchema.safeParse({
        trigger: { type: "manual" },
        steps: [{ id: "r", type: "whatsapp_reply", config: { mode: "template", to: "639171234567", templateName: "Bad-Template!" } }],
        edges: [],
      }).success,
    ).toBe(false);

    expect(
      issues({
        trigger: { type: "whatsapp_message", config: { requireImage: false } },
        steps: [{ id: "ask", type: "payment_due", config: { reference: "R1", amount: "{{trigger.text}}" } }],
        edges: [],
      }).join(),
    ).toMatch(/payment_due step "ask"/);

    expect(
      issues({
        trigger: { type: "whatsapp_message", config: { requireImage: false } },
        steps: [{ id: "make", type: "shopify_create_product", config: { title: "Room", price: "{{trigger.text}}" } }],
        edges: [],
      }).join(),
    ).toMatch(/shopify_create_product step "make"/);
  });
});
