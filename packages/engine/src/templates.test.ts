import { describe, expect, it } from "vitest";
import { definitionSchema, triggerFields } from "./definition";
import { lintDefinition } from "./lint";
import { templatesForLanguage } from "./template-language";
import { TEMPLATES } from "./templates";

const SLUGS = ["inquiry-triage", "invoice-follow-up", "no-show-follow-up", "appointment-reminder", "request-to-sheets", "lead-to-booking", "order-to-sheets", "order-paid", "invoice-paymongo", "quote-deposit", "renewal-reminders", "store-orders", "receipt-expense"];
const parse = (slug: string) => definitionSchema.parse(TEMPLATES.find((t) => t.slug === slug)!.definition);

describe("starter templates", () => {
  it("lists the ready-made templates, simple to complex", () => {
    expect(TEMPLATES.map((t) => t.slug)).toEqual(SLUGS);
  });

  it.each(TEMPLATES.map((t) => [t.slug, t] as const))("%s is valid, lint-clean and only reads fields and steps that exist", (_slug, t) => {
    const result = definitionSchema.safeParse(t.definition);
    expect(result.success ? [] : result.error.issues).toEqual([]);
    const def = definitionSchema.parse(t.definition);
    expect(lintDefinition(def)).toEqual([]);
    const fields = new Set(triggerFields(def.trigger)?.map((f) => f.name));
    const ids = new Set(def.steps.map((s) => s.id));
    for (const m of JSON.stringify(def.steps).matchAll(/\{\{\s*(trigger|steps)\.([a-z0-9_]+)/g)) {
      if (m[1] === "steps") expect(ids.has(m[2]!), `unknown step ${m[2]}`).toBe(true);
      else if (def.trigger.type === "form") expect(fields.has(m[2]!), `unknown field ${m[2]}`).toBe(true);
    }
  });

  it("has Tagalog copy for every email, name and description", () => {
    const tl = templatesForLanguage("tl");
    for (const t of TEMPLATES.slice(3)) {
      const tt = tl.find((x) => x.slug === t.slug)!;
      for (const s of t.definition.steps) if (s.type === "email" || s.type === "approval" || s.type === "slack") expect(JSON.stringify(tt.definition.steps.find((x) => x.id === s.id)), `${t.slug}.${s.id}`).not.toEqual(JSON.stringify(s));
    }
  });

  it("inquiry triage routes on the label an AI classify step returns", () => {
    const def = parse("inquiry-triage");
    expect(def.steps.find((s) => s.id === "classify")).toMatchObject({ type: "ai", config: { task: "classify" } });
    expect(def.steps.find((s) => s.id === "is_billing")!.config).toEqual({ condition: { left: "{{steps.classify.output.label}}", op: "eq", right: "billing" } });
  });

  it("lead-to-booking books first, adds the event on done and offers another time when taken", () => {
    const def = parse("lead-to-booking");
    expect(def.edges).toContainEqual({ from: "book", to: "add_to_calendar", on: "done" });
    expect(def.edges).toContainEqual({ from: "book", to: "tell_taken", on: "taken" });
    expect(def.edges.some((e) => e.from === "book" && e.on === "not_found")).toBe(true);
  });

  it("order-to-sheets logs a pending row, then a link; order-paid listens for PayMongo paid", () => {
    expect(parse("order-to-sheets").steps.map((s) => s.type)).toEqual(["sheets", "paymongo_link", "email"]);
    expect(parse("order-paid").trigger).toEqual({ type: "payment", config: { events: ["paid"] } });
  });

  it("invoice-paymongo reminds only while the payment is pending, twice at most", () => {
    const def = parse("invoice-paymongo");
    const checks = def.steps.filter((s) => s.type === "payment_status");
    expect(checks).toHaveLength(2);
    for (const c of def.steps.filter((s) => s.type === "condition")) expect(c.config).toMatchObject({ condition: { op: "eq", right: "pending" } });
  });

  it("renewal-reminders logs the item, waits until 30 days before it expires, then emails", () => {
    const def = parse("renewal-reminders");
    expect(def.trigger.type).toBe("form");
    expect(def.steps.map((s) => s.type)).toEqual(["sheets", "delay", "email"]);
    expect(def.steps.find((s) => s.id === "wait_until_30_days_before")!.config).toEqual({ until: "{{trigger.expires_at}}", offsetSeconds: -2_592_000 });
  });

  it("receipt-expense saves the photo, lets the model read it, and logs a row only after approval", () => {
    const def = parse("receipt-expense");
    expect(def.steps.map((s) => s.type)).toEqual(["drive", "ai", "approval", "sheets", "email", "email", "email"]);
    expect(def.steps.find((s) => s.id === "read_receipt")).toMatchObject({ config: { task: "extract", files: ["receipt"] } });
    expect(def.edges).toContainEqual({ from: "approve", to: "log_expense", on: "approved" });
    expect(def.edges).toContainEqual({ from: "approve", to: "tell_no_decision", on: "timeout" });
    expect(TEMPLATES.find((t) => t.slug === "receipt-expense")!.description).toMatch(/Google Drive.*Google Sheets.*Gemini, OpenAI or OpenRouter/);
  });

  it("store-orders is a webhook recipe that logs, receipts the customer and tells the owner without private details", () => {
    const def = parse("store-orders");
    expect(def.trigger.type).toBe("webhook");
    expect(def.steps.map((s) => s.type)).toEqual(["sheets", "email", "slack"]);
    expect(JSON.stringify(def.steps.find((s) => s.type === "slack"))).not.toContain("customer_email");
  });
});
