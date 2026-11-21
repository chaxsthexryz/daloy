import { needsPayment, type BusinessCategory, type OnboardingGoal, type OnboardingPayment } from "@daloy/engine";

/** What GET /onboarding returns (apps/api/src/onboarding.ts). */
export type OnboardingState = {
  status: "not_started" | "in_progress" | "completed" | "dismissed";
  completed: number;
  step: 1 | 2 | 3;
  identity: { businessName: string | null; website: string | null; logoUrl: string | null };
  primary: BusinessCategory | null;
  related: BusinessCategory[];
  suggestedGoal: OnboardingGoal;
  goal: OnboardingGoal | null;
  payment: OnboardingPayment | null;
  template: { slug: string; stopgap: boolean } | null;
  workflowId: string | null;
  sample: Record<string, string | number> | null;
};

export type Answers = { name: string; website: string; primary: BusinessCategory | null; related: BusinessCategory[]; goal: OnboardingGoal | null; payment: OnboardingPayment | null };

/** The answers a screen opens with: what is saved, else nothing, except the suggested first workflow on screen 3. */
export function answersFrom(s: OnboardingState): Answers {
  return { name: s.identity.businessName ?? "", website: s.identity.website ?? "", primary: s.primary, related: s.related, goal: s.goal ?? (s.primary ? s.suggestedGoal : null), payment: s.payment };
}

/** Whether the primary button of a screen can be pressed. The API checks the same rules again. */
export function canContinue(step: 1 | 2 | 3, a: Answers): boolean {
  if (step === 1) return a.name.trim().length > 0;
  if (step === 2) return a.primary !== null;
  return a.goal !== null && (!needsPayment(a.goal) || a.payment !== null);
}

/** Related categories after a tap: toggled, never the primary one, never more than three. */
export function toggleRelated(related: BusinessCategory[], category: BusinessCategory): BusinessCategory[] {
  if (related.includes(category)) return related.filter((c) => c !== category);
  return related.length >= 3 ? related : [...related, category];
}

/** Picking a new primary category drops it from the related list. */
export const withPrimary = (a: Answers, primary: BusinessCategory): Answers => ({ ...a, primary, related: a.related.filter((c) => c !== primary) });

/** Up to two capital letters for the mark shown until the seller adds a logo. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return "?";
  const first = (w: string) => Array.from(w.replace(/^[^\p{L}\p{N}]+/u, ""))[0]!.toUpperCase();
  return words.length === 1 ? first(words[0]!) : first(words[0]!) + first(words[words.length - 1]!);
}
