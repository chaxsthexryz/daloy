import type { Language } from "./language";
import type { Step, WorkflowDefinition } from "./definition";
import { destination, entryLabel, stepEntry, triggerEntry, type Text } from "./catalog";

/**
 * Plain-language reading of a saved draft (roadmap R2b): the "Explain this flow" lines, the configuration checks of the
 * sample test and the payment mode shown when the owner turns the automation on. Pure functions over the draft, so the
 * result is the same in the browser and in tests, and the validator (not an AI) decides what counts as a problem.
 */
const pick = (t: Text, l: Language) => t[l];

export type StepLine = { id: string; label: string; where: string; after?: string; note?: string };

/** Every step in the order a run reaches it (breadth first from the entry), then any step no edge reaches. `chosen` maps a step id to the destination picked in Apps. */
export function stepLines(def: WorkflowDefinition, language: Language, chosen: Record<string, string> = {}): StepLine[] {
  const incoming = new Set(def.edges.map((e) => e.to));
  const queue = def.steps.filter((s) => !incoming.has(s.id)).map((s) => ({ step: s, after: undefined as string | undefined }));
  const seen = new Set<string>();
  const out: StepLine[] = [];
  const visit = (step: Step, after?: string) => {
    if (seen.has(step.id)) return;
    seen.add(step.id);
    out.push({ id: step.id, label: entryLabel(stepEntry(step.type), language), where: destination(step, { language, trigger: def.trigger, chosen: chosen[step.id] }), after, ...(step.note?.trim() && { note: step.note.trim() }) });
    for (const e of def.edges.filter((x) => x.from === step.id)) {
      const next = def.steps.find((s) => s.id === e.to);
      if (next) queue.push({ step: next, after: e.on });
    }
  };
  while (queue.length) {
    const { step, after } = queue.shift()!;
    visit(step, after);
  }
  for (const s of def.steps) visit(s);
  return out;
}

const STARTS = { en: "Starts when", tl: "Nagsisimula kapag" };
const AFTER = { en: "After", tl: "Pagkatapos ng" };
const NOTE = { en: "Your note", tl: "Tala mo" };

/** The "Explain this flow" lines: how it starts, then one numbered line per step with who or where it acts on, and the owner's note quoted as typed. */
export function explainFlow(def: WorkflowDefinition, language: Language, chosen: Record<string, string> = {}): string[] {
  const t = triggerEntry(def.trigger.type);
  return [
    `${STARTS[language]}: ${pick(t.action, language)}. ${pick(t.description, language)}`,
    ...stepLines(def, language, chosen).map((l, i) => `${i + 1}. ${l.after ? `${AFTER[language]} ${l.after}: ` : ""}${l.label}. ${l.where}${l.note ? ` ${NOTE[language]}: "${l.note}"` : ""}`),
  ];
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

export type ConfigProblem = { stepId: string; message: string };

/** A step whose recipient is a plain `to` field. */
const hasTo = (s: Step): s is Extract<Step, { type: "email" | "outlook" | "sms" }> => s.type === "email" || s.type === "outlook" || s.type === "sms";

/** Configuration checks for the sample test: a required field left empty, a missing recipient, a form without fields. */
export function configProblems(def: WorkflowDefinition, language: Language): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const say = (stepId: string, label: string, field: string) => {
    const en = field === "to" ? `${label} has no recipient.` : `${label} needs ${field}.`;
    const tl = field === "to" ? `Walang tatanggap ang ${label}.` : `Kailangan ng ${label} ang ${field}.`;
    out.push({ stepId, message: language === "tl" ? tl : en });
  };
  const trigger = triggerEntry(def.trigger.type);
  const triggerConfig = def.trigger.config as Record<string, unknown>;
  for (const f of trigger.required) if (blank(triggerConfig[f])) say("trigger", entryLabel(trigger, language), f);
  if (def.trigger.type === "discord_message" && blank(triggerConfig.publicKey) && blank(triggerConfig.signingSecret)) {
    say("trigger", entryLabel(trigger, language), "publicKey or signingSecret");
  }
  for (const step of def.steps) {
    const entry = stepEntry(step.type);
    const config = step.config as Record<string, unknown>;
    for (const f of entry.required) if (blank(config[f])) say(step.id, entryLabel(entry, language), f);
    if (step.type === "sheets" && blank(config.columns) && blank(config.rows)) say(step.id, entryLabel(entry, language), "columns");
    if (step.type === "approval" && blank(config.approver) && blank(config.to)) say(step.id, entryLabel(entry, language), "to");
  }
  return out;
}

/** The draft with its first recipient emptied: the failure example the sample test shows next to the success. */
export function withoutRecipient(def: WorkflowDefinition): WorkflowDefinition {
  const target = def.steps.find(hasTo);
  if (!target) return def;
  return { ...def, steps: def.steps.map((s) => (s === target ? ({ ...s, config: { ...s.config, to: "" } } as Step) : s)) };
}

/** How the flow collects payment, for the Turn on summary. null when it asks for none. */
export function paymentMode(def: WorkflowDefinition): "manual" | "checkout" | "later" | null {
  const due = def.steps.find((s): s is Extract<Step, { type: "payment_due" }> => s.type === "payment_due");
  if (!due) return null;
  return due.config.checkout ? "checkout" : due.config.kind === "balance" ? "later" : "manual";
}
