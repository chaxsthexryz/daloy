import { describe, expect, it } from "vitest";
import { definitionSchema, type Trigger } from "./definition";
import { TEMPLATES } from "./templates";

const book = (over: Record<string, unknown> = {}) => ({
  id: "book_rider",
  type: "lalamove",
  config: {
    pickupAddress: "Unit 1, 123 Shaw Blvd, Mandaluyong",
    pickupLat: "14.5794",
    pickupLng: "121.0359",
    senderName: "Tindahan ni Aling Rosa",
    senderPhone: "+639171234567",
    dropoffAddress: "{{trigger.address}}",
    dropoffLat: "{{trigger.lat}}",
    dropoffLng: "{{trigger.lng}}",
    recipientName: "{{trigger.customer_name}}",
    recipientPhone: "{{trigger.phone}}",
    ...over,
  },
});
const signed: Trigger = { type: "webhook", config: { hmacSecret: "order_webhook_secret", requireTimestamp: true } } as Trigger;

describe("lalamove step", () => {
  it("defaults to the sandbox and a motorcycle", () => {
    const def = definitionSchema.parse({ trigger: signed, steps: [book()] });
    expect(def.steps[0]!.config).toMatchObject({ live: false, serviceType: "MOTORCYCLE" });
  });

  it("refuses a trigger that anyone can fill in, since every run can spend the seller's money", () => {
    const form = definitionSchema.safeParse({ trigger: { type: "form", config: { fields: [{ name: "address", label: "Address", type: "text" }] } }, steps: [book({ dropoffAddress: "Fixed address" })] });
    expect(form.success).toBe(false);
    expect(form.error?.issues.map((i) => i.message).join(" ")).toMatch(/lalamove step "book_rider" can only run from/);
  });

  it("refuses fields taken from an AI step", () => {
    const def = definitionSchema.safeParse({ trigger: signed, steps: [{ id: "guess", type: "ai", config: { task: "extract", input: "x", fields: { address: "string" } } }, book({ dropoffAddress: "{{steps.guess.output.address}}" })] });
    expect(def.success).toBe(false);
    expect(def.error?.issues.map((i) => i.message).join(" ")).toMatch(/cannot take its fields from the AI step "guess"/);
  });

  it("ships a template that passes its own rules and stays in the sandbox", () => {
    const t = TEMPLATES.find((x) => x.slug === "lalamove-confirmed-order");
    expect(t).toBeDefined();
    const def = definitionSchema.parse(t!.definition);
    expect(def.steps.find((s) => s.type === "lalamove")!.config).toMatchObject({ live: false });
  });
});
