import * as z from "zod";
import type { WorkflowDefinition } from "./definition";

/**
 * Builder test runs: "mock" fakes every step that reaches outside kymavo, "ai" calls the model but fakes the rest,
 * "live" makes every call. In mock and ai runs a tester can choose a step's outcome (decision 0028).
 */
export const testModeSchema = z.enum(["mock", "ai", "live"]);
export type TestMode = z.infer<typeof testModeSchema>;

export const testChoiceSchema = z.union([
  z.strictObject({ label: z.string().max(64) }),
  z.strictObject({ decision: z.enum(["approved", "rejected", "timeout"]) }),
  // "unknown" fails the first attempt as if the answer was lost, so the run waits for review (decision 0030).
  z.strictObject({ fail: z.enum(["retryable", "permanent", "unknown"]) }),
  // A booking step's other branches, without touching any booking (decision 0032).
  z.strictObject({ booking: z.enum(["taken", "not_found"]) }),
  // "Try this step for real": this one step calls its app, every other step stays faked (decision 0110).
  z.strictObject({ live: z.literal(true) }),
]);
export type TestChoice = z.infer<typeof testChoiceSchema>;
export const testChoicesSchema = z.record(z.string().max(64), testChoiceSchema).refine((c) => Object.keys(c).length <= 100, "at most 100 choices");

// Steps a mocked run fakes, so a tester can make them fail to see the failure path.
const OUTSIDE = new Set(["http", "email", "approval", "sheets", "drive", "slack", "outlook", "teams", "telegram", "sms", "calendar", "airtable", "notion", "trello", "meta_reply", "whatsapp_reply", "shopify_create_product", "shopify_update_product", "discord", "google_docs", "read_page", "browser", "assistant_read"]);

// Steps a preview may send for real on their own. An approval has nothing to check alone, and a real payment link or
// Shopify product is not a test.
const NOT_LIVE_ALONE = new Set(["approval", "shopify_create_product", "shopify_update_product"]);
export const canSendAlone = (type: string) => OUTSIDE.has(type) && !NOT_LIVE_ALONE.has(type);

/** What is wrong with these choices for this workflow, one message per choice. Empty when they all fit. */
export function choiceProblems(def: WorkflowDefinition, choices: Record<string, TestChoice>, mode: TestMode): string[] {
  if (mode === "live") return Object.keys(choices).length > 0 ? ["choices: a live test run makes real calls, so its outcomes cannot be chosen"] : [];
  const problems = Object.entries(choices).flatMap(([id, c]) => {
    const step = def.steps.find((s) => s.id === id);
    const at = `choices.${id}`;
    if (!step) return [`${at}: there is no step "${id}"`];
    if ("live" in c) {
      if (mode !== "mock") return [`${at}: only a preview that fakes every call can send one step for real`];
      return canSendAlone(step.type) ? [] : [`${at}: only a step that sends to an app can be sent for real, and not an approval, payment or Shopify product`];
    }
    if ("label" in c) {
      if (step.type !== "ai" || step.config.task !== "classify") return [`${at}: only a classify step takes a label`];
      return c.label in (step.config.labels ?? {}) ? [] : [`${at}: "${c.label}" is not a label of this classify step`];
    }
    if ("decision" in c) return step.type === "approval" ? [] : [`${at}: only an approval step takes a decision`];
    if ("booking" in c) return step.type === "booking" ? [] : [`${at}: only a booking step takes a booking outcome`];
    return OUTSIDE.has(step.type) ? [] : [`${at}: only a step that reaches outside kymavo can be set to fail`];
  });
  if (Object.values(choices).filter((c) => "live" in c).length > 1) problems.push("choices: only one step can be sent for real at a time");
  return problems;
}
