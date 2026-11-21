import { describe, expect, it } from "vitest";
import { answersFrom, canContinue, initials, toggleRelated, withPrimary, type Answers, type OnboardingState } from "./onboarding";

const empty: Answers = { name: "", website: "", primary: null, related: [], goal: null, payment: null };
const saved = (over: Partial<OnboardingState> = {}): OnboardingState => ({
  status: "in_progress", completed: 1, step: 2, identity: { businessName: "Ana's Sweets", website: null, logoUrl: null }, primary: null, related: [], suggestedGoal: "order_follow_up",
  goal: null, payment: null, template: null, workflowId: null, sample: null, ...over,
});

describe("onboarding screens", () => {
  it("restores the saved answers and suggests a first workflow only once the business type is known", () => {
    expect(answersFrom(saved())).toEqual({ name: "Ana's Sweets", website: "", primary: null, related: [], goal: null, payment: null });
    expect(answersFrom(saved({ primary: "beauty_wellness", suggestedGoal: "bookings" })).goal).toBe("bookings");
    expect(answersFrom(saved({ primary: "beauty_wellness", goal: "receipt_review", payment: "manual_qrph" }))).toMatchObject({ goal: "receipt_review", payment: "manual_qrph" });
  });

  it("holds the primary button until the screen has its answer", () => {
    expect(canContinue(1, empty)).toBe(false);
    expect(canContinue(1, { ...empty, name: "   " })).toBe(false);
    expect(canContinue(1, { ...empty, name: "Ana" })).toBe(true);
    expect(canContinue(2, empty)).toBe(false);
    expect(canContinue(2, { ...empty, primary: "other" })).toBe(true);
    expect(canContinue(3, empty)).toBe(false);
    expect(canContinue(3, { ...empty, goal: "bookings" })).toBe(true);
    expect(canContinue(3, { ...empty, goal: "order_follow_up" })).toBe(false);
    expect(canContinue(3, { ...empty, goal: "order_follow_up", payment: "pay_later" })).toBe(true);
  });

  it("allows three related categories at most and drops the one that became primary", () => {
    let related = toggleRelated([], "online_retail");
    related = toggleRelated(related, "food_orders");
    related = toggleRelated(related, "beauty_wellness");
    expect(toggleRelated(related, "other")).toEqual(related);
    expect(toggleRelated(related, "food_orders")).toEqual(["online_retail", "beauty_wellness"]);
    expect(withPrimary({ ...empty, related }, "food_orders").related).toEqual(["online_retail", "beauty_wellness"]);
    expect(withPrimary({ ...empty, related }, "online_retail").related).toEqual(["food_orders", "beauty_wellness"]);
  });

  it("makes initials for the logo placeholder", () => {
    expect(initials("Ana's Sweets")).toBe("AS");
    expect(initials("  lim dental clinic ")).toBe("LC");
    expect(initials("Kape")).toBe("K");
    expect(initials("  ")).toBe("?");
    expect(initials("(Bake) & Co")).toBe("BC");
  });
});
