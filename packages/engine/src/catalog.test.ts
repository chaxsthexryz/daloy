import { describe, expect, it } from "vitest";
import { definitionSchema, type Step, type Trigger } from "./definition";
import { stepJsonSchemas } from "./step-schemas";
import { destination, stepEntry, stepLabel, STEP_CATALOG, TRIGGER_CATALOG, triggerEntry, triggerLabel, type Text } from "./catalog";

// Every step and trigger type the definition accepts, read from the schema itself so a new type fails here until it has an entry.
const STEP_TYPES = Object.keys(stepJsonSchemas()) as Step["type"][];
const TRIGGER_TYPES = (definitionSchema.shape.trigger as unknown as { options: { shape: { type: { value: string } } }[] }).options.map((o) => o.shape.type.value) as Trigger["type"][];

const texts = (e: ReturnType<typeof stepEntry>): Text[] => [e.action, e.description, e.input, e.output, ...e.outcomes, ...(e.app ? [e.app] : [])];
const filled = (t: Text) => t.en.trim().length > 0 && t.tl.trim().length > 0;

describe("step catalog", () => {
  it("has the schema's step and trigger types (sanity check on the test itself)", () => {
    expect(STEP_TYPES.length).toBeGreaterThanOrEqual(21);
    expect(TRIGGER_TYPES).toEqual(expect.arrayContaining(["form", "webhook", "schedule", "manual", "email", "payment", "meta_dm"]));
  });

  it.each(STEP_TYPES)("has a complete entry for step type %s", (type) => {
    const e = STEP_CATALOG[type];
    expect(e, `no catalog entry for step type "${type}"`).toBeDefined();
    for (const text of texts(e)) expect(filled(text), `empty text in the "${type}" entry`).toBe(true);
    expect(e.outcomes.length).toBeGreaterThan(0);
    expect(e.mark.length).toBeGreaterThan(0);
    // A required field must be a real config field of the step.
    const props = Object.keys(((stepJsonSchemas()[type] as { properties?: object }).properties ?? {}) as object);
    for (const field of e.required) expect(props, `"${field}" is not a config field of ${type}`).toContain(field);
  });

  it.each(TRIGGER_TYPES)("has a complete entry for trigger type %s", (type) => {
    const e = TRIGGER_CATALOG[type];
    expect(e, `no catalog entry for trigger type "${type}"`).toBeDefined();
    for (const text of texts(e)) expect(filled(text), `empty text in the "${type}" trigger entry`).toBe(true);
  });

  it("has no entry for a type the schema does not know", () => {
    expect(Object.keys(STEP_CATALOG).sort()).toEqual([...STEP_TYPES].sort());
    expect(Object.keys(TRIGGER_CATALOG).sort()).toEqual([...TRIGGER_TYPES].sort());
  });

  it("labels a step with the app and the action, in English and in Tagalog", () => {
    expect(stepLabel("email", "en")).toBe("Gmail, Send email");
    expect(stepLabel("sheets", "en")).toBe("Google Sheets, Add a row");
    expect(stepLabel("email", "tl")).toBe("Gmail, Magpadala ng email");
    expect(stepLabel("sheets", "tl")).toBe("Google Sheets, Magdagdag ng row");
    // A built-in action has no app, so the label is the action alone.
    expect(stepLabel("delay", "en")).toBe("Delay");
    expect(stepLabel("delay", "tl")).toBe("Paghihintay");
    expect(triggerLabel("form", "en")).toBe("A form is submitted");
    expect(triggerLabel("form", "tl")).toBe("May nag-submit ng form");
  });

  it("gives every label in both languages a different text unless it is a name", () => {
    const same = STEP_TYPES.filter((t) => STEP_CATALOG[t].action.en === STEP_CATALOG[t].action.tl);
    expect(same).toEqual([]);
  });

  it("names the connected app a step needs", () => {
    expect(stepEntry("slack").provider).toBe("slack");
    expect(stepEntry("sms").provider).toBe("unisms");
    expect(stepEntry("calendar").provider).toBe("google_calendar");
    expect(stepEntry("delay").provider).toBeUndefined();
    expect(triggerEntry("payment").provider).toBe("paymongo");
  });
});

describe("destination line", () => {
  const form: Trigger = { type: "form", config: { fields: [{ name: "email", label: "Customer email", type: "email", required: true }] } };
  const step = (s: object) => s as Step;

  it("shows the recipient as words, not as a template", () => {
    const d = destination(step({ id: "a", type: "email", config: { to: "{{trigger.email}}", subject: "Hi", text: "x" } }), { language: "en", trigger: form });
    expect(d).toBe("To: Customer email from the form");
  });

  it("shows a literal address as typed", () => {
    expect(destination(step({ id: "a", type: "email", config: { to: "ana@example.com", subject: "Hi", text: "x" } }), { language: "en", trigger: form })).toBe("To: ana@example.com");
  });

  it("reads a field of an earlier step", () => {
    expect(destination(step({ id: "a", type: "sms", config: { to: "{{steps.ai_1.output.phone}}", message: "x" } }), { language: "en", trigger: form })).toBe("To: phone from step ai_1");
  });

  it("speaks Tagalog", () => {
    expect(destination(step({ id: "a", type: "email", config: { to: "{{trigger.email}}", subject: "Hi", text: "x" } }), { language: "tl", trigger: form })).toBe("Para kay: Customer email mula sa form");
  });

  it("shows the destination the owner picked in Apps, or says it is not chosen yet", () => {
    const slack = step({ id: "s", type: "slack", config: { text: "hello" } });
    expect(destination(slack, { language: "en", trigger: form, chosen: "#orders" })).toBe("Channel: #orders");
    expect(destination(slack, { language: "en", trigger: form })).toBe("Channel: chosen in Apps");
    expect(destination(step({ id: "t", type: "telegram", config: { text: "hi" } }), { language: "tl", trigger: form, chosen: "Shop team" })).toBe("Chat: Shop team");
  });

  it("gives every step type a destination line", () => {
    const configs: Record<string, object> = {
      condition: { condition: { left: "{{trigger.n}}", op: "gt", right: "1" } },
      http: { method: "POST", url: "https://example.com/hook", headers: {} },
      delay: { seconds: 60 },
      ai: { task: "extract", fields: {} },
      approval: { approver: "owner@example.com", subject: "s", message: "m", timeoutSeconds: 3600 },
      drive: {},
      airtable: { fields: { Name: "x" } },
      notion: { title: "t", fields: {} },
      trello: { name: "n" },
      booking: { action: "cancel", booking: "{{trigger.reference}}" },
      paymongo_link: { amount: "100", description: "d", reference: "r" },
      payment_due: { reference: "D-1042", amount: "350" },
      payment_expire: { due: "ask_deposit" },
      payment_status: { link: "pay_1" },
      meta_reply: { recipientId: "{{trigger.senderId}}", channel: "{{trigger.channel}}", text: "t" },
      calendar: { title: "t" },
      sheets: { columns: ["a"] },
    };
    for (const type of STEP_TYPES) {
      const config = configs[type] ?? { to: "a@b.co", subject: "s", text: "t", message: "m" };
      const line = destination(step({ id: "x", type, config }), { language: "en", trigger: form });
      expect(line.length, `no destination line for ${type}`).toBeGreaterThan(0);
    }
  });
});
