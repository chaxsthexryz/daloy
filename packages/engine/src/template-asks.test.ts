import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { applyAskAnswers, asksForTemplate, defaultAskAnswers, TEMPLATE_ASKS } from "./template-asks";
import { TEMPLATES } from "./templates";

describe("template asks metadata (G2)", () => {
  it("gives every starter template valid owner questions in English and Tagalog", () => {
    for (const template of TEMPLATES) {
      const def = definitionSchema.parse(template.definition);
      const asks = asksForTemplate(template.slug, def);
      expect(TEMPLATE_ASKS[template.slug], `missing TEMPLATE_ASKS for ${template.slug}`).toBeDefined();
      expect(asks.length, `no active asks for ${template.slug}`).toBeGreaterThan(0);
      for (const ask of asks) {
        expect(ask.label.en.trim().length, `${template.slug}.${ask.key} en label`).toBeGreaterThan(0);
        expect(ask.label.tl.trim().length, `${template.slug}.${ask.key} tl label`).toBeGreaterThan(0);
        expect(ask.targets.length, `${template.slug}.${ask.key} targets`).toBeGreaterThan(0);
      }
      const defaults = defaultAskAnswers(asks, {
        ownerEmail: "owner@bakery.ph",
        businessName: "Panaderia",
        workflowName: template.name,
      });
      const updated = applyAskAnswers(def, asks, defaults);
      expect(() => definitionSchema.parse(updated), `invalid applied definition for ${template.slug}`).not.toThrow();
    }
  });

  it("derives fallback asks for AI-generated or custom definitions without a template slug", () => {
    const custom = definitionSchema.parse({
      trigger: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } },
      steps: [
        { id: "decide", type: "approval", config: { to: "owner@example.com", subject: "Review", message: "Check", timeoutSeconds: 86400 } },
        { id: "reply", type: "email", config: { to: "{{trigger.email}}", subject: "Thanks", text: "We got your message." } },
      ],
      edges: [{ from: "decide", to: "reply", on: "approved" }],
    });
    const asks = asksForTemplate(undefined, custom);
    expect(asks.some((a) => a.type === "approver")).toBe(true);
    expect(asks.some((a) => a.targets.some((t) => t.kind === "step" && t.stepId === "reply"))).toBe(true);
    const answers = defaultAskAnswers(asks, { ownerEmail: "boss@shop.ph", businessName: "Shop", workflowName: "Custom" });
    const next = applyAskAnswers(custom, asks, answers);
    expect(next.steps[0]!.config).toMatchObject({ to: "boss@shop.ph" });
  });
});
