import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { identityInput, needsPayment, ONBOARDING_GOALS, resumeStep, sampleOrder, suggestedGoal, templateFor, typeInput, workflowInput, type OnboardingState } from "./onboarding";
import { TEMPLATES } from "./templates";

const state = (over: Partial<OnboardingState> = {}): OnboardingState => ({ completed: 0, ...over });

describe("onboarding resume step", () => {
  it("starts at screen 1, then resumes at the first screen that is not saved yet", () => {
    expect(resumeStep(state())).toBe(1);
    expect(resumeStep(state({ completed: 1 }))).toBe(2);
    expect(resumeStep(state({ completed: 2 }))).toBe(3);
  });

  it("stays on the last screen once all three are saved, so an owner can edit the answers", () => {
    expect(resumeStep(state({ completed: 3 }))).toBe(3);
  });
});

describe("onboarding input", () => {
  it("trims the business name and turns an empty website into null", () => {
    expect(identityInput.parse({ businessName: "  Ana's Sweets ", website: "" })).toEqual({ businessName: "Ana's Sweets", website: null });
    expect(identityInput.parse({ businessName: "Ana's Sweets", website: "https://anassweets.example" }).website).toBe("https://anassweets.example");
  });

  it("refuses an empty name, a name that is only spaces and a website that is not http or https", () => {
    expect(identityInput.safeParse({ businessName: "   ", website: "" }).success).toBe(false);
    expect(identityInput.safeParse({ businessName: "A", website: "javascript:alert(1)" }).success).toBe(false);
    expect(identityInput.safeParse({ businessName: "A", website: "ftp://x.example" }).success).toBe(false);
    expect(identityInput.safeParse({ businessName: "A".repeat(121), website: "" }).success).toBe(false);
  });

  it("takes one primary category and at most three related ones that differ from it", () => {
    expect(typeInput.parse({ primary: "food_orders", related: ["online_retail", "other"] })).toEqual({ primary: "food_orders", related: ["online_retail", "other"] });
    expect(typeInput.parse({ primary: "other", related: [] }).related).toEqual([]);
    expect(typeInput.safeParse({ primary: "food_orders", related: ["food_orders"] }).success).toBe(false);
    expect(typeInput.safeParse({ primary: "food_orders", related: ["online_retail", "online_retail"] }).success).toBe(false);
    expect(typeInput.safeParse({ primary: "online_retail", related: ["food_orders", "beauty_wellness", "professional_services", "other"] }).success).toBe(false);
    expect(typeInput.safeParse({ primary: "pet_shop", related: [] }).success).toBe(false);
  });

  it("needs a payment choice for receipt review and order follow-up, and none for bookings", () => {
    expect(needsPayment("receipt_review")).toBe(true);
    expect(needsPayment("order_follow_up")).toBe(true);
    expect(needsPayment("bookings")).toBe(false);
    expect(workflowInput.safeParse({ goal: "receipt_review" }).success).toBe(false);
    expect(workflowInput.safeParse({ goal: "order_follow_up", payment: "pay_later" }).success).toBe(true);
    // A booking draft never keeps a payment choice that does not apply to it.
    expect(workflowInput.parse({ goal: "bookings", payment: "manual_qrph" })).toEqual({ goal: "bookings", payment: null });
    expect(workflowInput.safeParse({ goal: "order_follow_up", payment: "card" }).success).toBe(false);
  });
});

describe("closest existing template", () => {
  it("picks a template that exists for every goal and payment choice", () => {
    const slugs = new Set<string>(TEMPLATES.map((t) => t.slug));
    for (const goal of ONBOARDING_GOALS) {
      for (const payment of [null, "manual_qrph", "gcash_paymongo", "pay_later"] as const) {
        expect(slugs.has(templateFor(goal, payment).slug)).toBe(true);
      }
    }
  });

  it("maps goals to the templates the first release has", () => {
    expect(templateFor("bookings", null).slug).toBe("lead-to-booking");
    expect(templateFor("receipt_review", "manual_qrph").slug).toBe("receipt-expense");
    expect(templateFor("order_follow_up", "pay_later").slug).toBe("store-orders");
    expect(templateFor("order_follow_up", "gcash_paymongo").slug).toBe("order-to-sheets");
  });

  it("suggests a goal from the primary category and falls back to order follow-up", () => {
    expect(suggestedGoal("beauty_wellness")).toBe("bookings");
    expect(suggestedGoal("professional_services")).toBe("bookings");
    expect(suggestedGoal("online_retail")).toBe("order_follow_up");
    expect(suggestedGoal("other")).toBe("order_follow_up");
    expect(suggestedGoal(null)).toBe("order_follow_up");
  });
});

describe("sample order", () => {
  it("fills every field of the chosen template's form or webhook with a realistic value, leaving out files and resources", () => {
    for (const goal of ONBOARDING_GOALS) {
      const template = templateFor(goal, "manual_qrph");
      const def = definitionSchema.parse(TEMPLATES.find((t) => t.slug === template.slug)!.definition);
      const sample = sampleOrder(def, new Date("2026-11-21T00:00:00Z"));
      const fields = def.trigger.type === "form" || def.trigger.type === "webhook" ? def.trigger.config.fields ?? [] : [];
      for (const f of fields) {
        if (f.type === "file" || f.type === "resource") expect(sample).not.toHaveProperty(f.name);
        else expect(sample[f.name], `${template.slug}.${f.name}`).toBeDefined();
      }
    }
  });

  it("uses a fixed customer, a peso amount and tomorrow at ten for a booking time", () => {
    const def = definitionSchema.parse(TEMPLATES.find((t) => t.slug === "store-orders")!.definition);
    expect(sampleOrder(def, new Date("2026-11-21T00:00:00Z"))).toEqual({ order_id: "SAMPLE-1001", customer_name: "Ana Reyes", customer_email: "ana@example.com", total: 850 });
    const booking = definitionSchema.parse(TEMPLATES.find((t) => t.slug === "lead-to-booking")!.definition);
    expect(sampleOrder(booking, new Date("2026-11-21T00:00:00Z")).appointment_at).toBe("2026-11-22T10:00");
  });
});
