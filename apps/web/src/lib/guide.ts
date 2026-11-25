import type { WorkflowDefinition } from "@daloy/engine";

/** Whether the owner's sample result matches the draft on screen, is still running, or was made before the last edit. */
export type SampleResult = { key: string; runId: string };
export type TestState = "none" | "running" | "passed" | "failed" | "stale";

export function testState(draftKey: string, sample: { key: string; runId: string } | null, runState: string | null): TestState {
  if (!sample) return "none";
  if (sample.key !== draftKey) return "stale";
  if (runState === "succeeded") return "passed";
  if (runState === "failed" || runState === "cancelled") return "failed";
  return "running";
}

export const MESSAGE_STEP_TYPES = new Set([
  "email",
  "outlook",
  "sms",
  "meta_reply",
  "whatsapp_reply",
  "slack",
  "teams",
  "telegram",
  "discord",
  "approval",
  "payment_due",
]);

/** First customer- or team-facing message step id in the draft, or null when the draft has none. */
export function firstMessageStep(draft: WorkflowDefinition): string | null {
  return draft.steps.find((s) => MESSAGE_STEP_TYPES.has(s.type))?.id ?? null;
}

export type GuideKey = "connect" | "message" | "explain" | "try" | "turnon";
export type GuideStep = { key: GuideKey; done: boolean };

/** The five steps in order. Each is done on its own facts, so a seller can see what is left without a forced sequence. */
export function guideSteps(f: {
  missingApps: number;
  problems: number;
  hasMessageStep?: boolean;
  messagesChecked?: boolean;
  explained: boolean;
  test: TestState;
  live: boolean;
}): GuideStep[] {
  const messageDone = f.problems === 0 && (!f.hasMessageStep || f.messagesChecked === true);
  return [
    { key: "connect", done: f.missingApps === 0 },
    { key: "message", done: messageDone },
    { key: "explain", done: f.explained },
    { key: "try", done: f.test === "passed" },
    { key: "turnon", done: f.live },
  ];
}
