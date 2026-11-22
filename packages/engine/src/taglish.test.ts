import { describe, expect, it } from "vitest";
import { TEMPLATES } from "./templates";
import { templatesForLanguage } from "./template-language";
import { definitionSchema } from "./definition";
import { lintDefinition } from "./lint";

// R5: Taglish wording next to English and Tagalog, for the templates that message customers.
const ids = (d: { steps: { id: string }[] }) => d.steps.map((s) => s.id);
const customerCopy = (d: { steps: { type: string; config: Record<string, unknown> }[] }) => JSON.stringify(d.steps.filter((s) => ["email", "sms", "meta_reply", "payment_due"].includes(s.type)).map((s) => s.config));

describe("Taglish templates", () => {
  const en = templatesForLanguage("en");
  const tg = templatesForLanguage("en", "taglish");

  it("leaves English and Tagalog as they were", () => {
    expect(en).toEqual(TEMPLATES);
    expect(templatesForLanguage("tl", "default")).toEqual(templatesForLanguage("tl"));
  });

  it("changes the customer messages of the payment, reminder and order templates and nothing else", () => {
    for (const slug of ["booking-deposit-review", "order-gcash-checkout", "invoice-follow-up", "appointment-reminder", "no-show-follow-up", "store-orders", "shopify-orders"]) {
      const a = en.find((t) => t.slug === slug)!;
      const b = tg.find((t) => t.slug === slug)!;
      expect(customerCopy(b.definition as never), slug).not.toEqual(customerCopy(a.definition as never));
      expect(ids(b.definition), slug).toEqual(ids(a.definition));
      expect(b.definition.edges, slug).toEqual(a.definition.edges);
      expect(b.definition.trigger.type, slug).toEqual(a.definition.trigger.type);
    }
  });

  it("keeps every template valid, keeps its placeholders, and uses no dashes", () => {
    for (const t of tg) {
      const def = definitionSchema.parse(t.definition);
      expect(lintDefinition(def), t.slug).toEqual([]);
      const orig = TEMPLATES.find((x) => x.slug === t.slug)!;
      const holes = (x: unknown) => new Set([...JSON.stringify(x).matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]));
      // A message may drop a placeholder only if English never used it; it may not invent one.
      for (const h of holes(t.definition.steps)) expect(holes(orig.definition.steps).has(h), `${t.slug} ${h}`).toBe(true);
      expect(JSON.stringify(t.definition), t.slug).not.toMatch(/[–—]/);
    }
  });

  it("keeps the payment link and the deposit figure in the payment messages", () => {
    const d = JSON.stringify(tg.find((t) => t.slug === "booking-deposit-review")!.definition.steps);
    expect(d).toContain("{{steps.ask_deposit.output.payUrl}}");
    expect(d).toContain("350");
  });
});
