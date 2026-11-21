import * as z from "zod";
import type { WorkflowDefinition } from "./definition";
import { profileInput } from "./website-inquiry";

/**
 * First-time onboarding (roadmap phase R1, decision 0082): three screens, each saved on its own.
 * Everything here is pure, so the API and the console share one set of rules.
 */

export const BUSINESS_CATEGORIES = ["online_retail", "food_orders", "beauty_wellness", "professional_services", "other"] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];
export const ONBOARDING_GOALS = ["receipt_review", "bookings", "order_follow_up"] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];
export const ONBOARDING_PAYMENTS = ["manual_qrph", "gcash_paymongo", "pay_later"] as const;
export type OnboardingPayment = (typeof ONBOARDING_PAYMENTS)[number];

/** Screen 1. The same name and website rules as Business settings, so a name saved here never fails there. */
export const identityInput = profileInput.pick({ businessName: true, website: true });

/** Screen 2: one primary category, then up to three related ones that differ from it and from each other. */
export const typeInput = z
  .strictObject({ primary: z.enum(BUSINESS_CATEGORIES), related: z.array(z.enum(BUSINESS_CATEGORIES)).max(3) })
  .refine((v) => new Set(v.related).size === v.related.length && !v.related.includes(v.primary), { message: "related categories must differ from the primary one and from each other", path: ["related"] });

/** Receipt review and order follow-up take money, so they ask how the customer pays. Bookings do not. */
export const needsPayment = (goal: OnboardingGoal) => goal !== "bookings";

/** Screen 3. A booking draft drops any payment answer, so a changed mind never leaves a stale choice behind. */
export const workflowInput = z
  .strictObject({ goal: z.enum(ONBOARDING_GOALS), payment: z.enum(ONBOARDING_PAYMENTS).nullish() })
  .refine((v) => !needsPayment(v.goal) || !!v.payment, { message: "choose how customers pay", path: ["payment"] })
  .transform((v) => ({ goal: v.goal, payment: needsPayment(v.goal) ? (v.payment ?? null) : null }));

export type OnboardingState = { completed: number };

/** The screen to open: the first one not saved yet. After all three, the last one, so the owner can edit the answers. */
export const resumeStep = (s: OnboardingState): 1 | 2 | 3 => Math.min(Math.max(s.completed + 1, 1), 3) as 1 | 2 | 3;

/** Pre-selected on screen 3 from the primary category. The owner can pick any of the three. */
export const suggestedGoal = (primary: BusinessCategory | null): OnboardingGoal => (primary === "beauty_wellness" || primary === "professional_services" ? "bookings" : "order_follow_up");

/**
 * The closest template that exists today. Checkout wins over the goal because its template has the PayMongo step.
 * TODO(R3): receipt review with manual QR Ph transfer gets its own "receipt-review" template, and order follow-up
 * with manual transfer or pay later gets the matching payment-review template. Until then these two stand in.
 */
export function templateFor(goal: OnboardingGoal, payment: OnboardingPayment | null): { slug: string; stopgap: boolean } {
  if (goal === "bookings") return { slug: "lead-to-booking", stopgap: false };
  if (payment === "gcash_paymongo") return { slug: "order-to-sheets", stopgap: false };
  if (goal === "receipt_review") return { slug: "receipt-expense", stopgap: true };
  return { slug: "store-orders", stopgap: true };
}

const SAMPLE_VALUES: Record<string, string | number> = {
  name: "Ana Reyes",
  customer_name: "Ana Reyes",
  email: "ana@example.com",
  customer_email: "ana@example.com",
  order_id: "SAMPLE-1001",
  item: "Dried mango, 3 packs",
  total: 850,
  amount: 850,
  deposit: 850,
  service: "Haircut and color",
  request: "Is the 3-pack still available?",
  message: "Is the 3-pack still available?",
};

/**
 * A realistic sample for the draft's own trigger fields, in pesos for a Manila seller. Files and resources are left
 * out: a test run takes no files, and a resource id belongs to the owner's own list.
 */
export function sampleOrder(def: WorkflowDefinition, now = new Date()): Record<string, string | number> {
  if (def.trigger.type !== "form" && def.trigger.type !== "webhook") return {};
  const tomorrowAtTen = `${new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)}T10:00`;
  const sample: Record<string, string | number> = {};
  for (const f of def.trigger.config.fields ?? []) {
    if (f.type === "file" || f.type === "resource") continue;
    sample[f.name] = f.type === "datetime" ? tomorrowAtTen : (SAMPLE_VALUES[f.name] ?? (f.type === "number" ? 1 : f.type === "email" ? "ana@example.com" : `Sample ${f.label.toLowerCase()}`));
  }
  return sample;
}
