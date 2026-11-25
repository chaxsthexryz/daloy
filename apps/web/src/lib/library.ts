import type { WorkflowDefinition } from "@daloy/engine";

export type TaglishSample = { subject?: string; body: string };

const SAMPLE_STEPS = new Set(["payment_due", "sms", "meta_reply", "whatsapp_reply", "email", "telegram"]);

/** Extracts the first customer-facing message sample from a template definition for Taglish wording preview. */
export function taglishSampleFor(definition: WorkflowDefinition): TaglishSample | null {
  for (const step of definition.steps) {
    if (!SAMPLE_STEPS.has(step.type)) continue;
    const cfg = step.config as Record<string, unknown>;
    if (step.type === "email" && cfg.to === "owner@example.com") continue;
    const rawBody =
      (typeof cfg.text === "string" && cfg.text.trim()) ||
      (typeof cfg.message === "string" && cfg.message.trim()) ||
      (typeof cfg.confirmedMessage === "string" && cfg.confirmedMessage.trim()) ||
      "";
    if (!rawBody) continue;
    const subject = typeof cfg.subject === "string" && cfg.subject.trim() ? cfg.subject.trim() : undefined;
    return subject ? { subject, body: rawBody } : { body: rawBody };
  }
  return null;
}
