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
// T3: what a step's onError does. Unset or "stop" says nothing, since stopping is what every step has always done.
const ON_ERROR = {
  skip: { en: "If it fails, the automation skips it and carries on.", tl: "Kapag pumalya ito, lalaktawan ito at magpapatuloy ang automation." },
  failed_edge: { en: "If it fails, the automation takes the failed path.", tl: "Kapag pumalya ito, dadaan ang automation sa failed na daan." },
};
const AFTER_FAILED = { en: "If the step before fails", tl: "Kapag pumalya ang naunang hakbang" };

/** The "Explain this flow" lines: how it starts, then one numbered line per step with who or where it acts on, what a failure does, and the owner's note quoted as typed. */
export function explainFlow(def: WorkflowDefinition, language: Language, chosen: Record<string, string> = {}): string[] {
  const t = triggerEntry(def.trigger.type);
  const policy = (id: string) => {
    const s = def.steps.find((x) => x.id === id);
    const p = s && "onError" in s ? s.onError : undefined;
    return p === "skip" || p === "failed_edge" ? ` ${ON_ERROR[p][language]}` : "";
  };
  const after = (on?: string) => (on === "failed" ? `${AFTER_FAILED[language]}: ` : on ? `${AFTER[language]} ${on}: ` : "");
  return [
    `${STARTS[language]}: ${pick(t.action, language)}. ${pick(t.description, language)}`,
    ...stepLines(def, language, chosen).map((l, i) => `${i + 1}. ${after(l.after)}${l.label}. ${l.where}${policy(l.id)}${l.note ? ` ${NOTE[language]}: "${l.note}"` : ""}`),
  ];
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

export type PreflightKind = "config" | "missing_resource" | "sms_unavailable" | "sms_plan" | "sms_quota" | "knowledge";
export type ConfigProblem = { stepId: string; message: string; kind?: PreflightKind; blocksPublish?: boolean };
export type PreflightEnv = {
  smsConfigured?: boolean;
  smsLimit?: number | null;
  smsUsed?: number;
  resourceCount?: number;
  knowledgePublished?: boolean;
};

/** A step whose recipient is a plain `to` field. */
const hasTo = (s: Step): s is Extract<Step, { type: "email" | "outlook" | "sms" }> => s.type === "email" || s.type === "outlook" || s.type === "sms";

/** Configuration checks for the sample test: a required field left empty, a missing recipient, a form without fields. */
export function configProblems(def: WorkflowDefinition, language: Language): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const say = (stepId: string, label: string, field: string) => {
    const en = field === "to" ? `${label} has no recipient.` : `${label} needs ${field}.`;
    const tl = field === "to" ? `Walang tatanggap ang ${label}.` : `Kailangan ng ${label} ang ${field}.`;
    out.push({ stepId, kind: "config", message: language === "tl" ? tl : en });
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
    if (step.type === "whatsapp_reply") {
      if ((config.mode ?? "text") === "template") {
        if (blank(config.templateName)) say(step.id, entryLabel(entry, language), "templateName");
      } else if (blank(config.text)) {
        say(step.id, entryLabel(entry, language), "text");
      }
    }
  }
  return out;
}

/** Full preflight checks combining step configuration with workspace prerequisites (resources, SMS, knowledge). */
export function preflightProblems(def: WorkflowDefinition, env: PreflightEnv, language: Language): ConfigProblem[] {
  const out = configProblems(def, language);
  const activeSteps = def.steps.filter((s) => !s.disabled);
  const hasResourceField =
    (def.trigger.type === "form" || def.trigger.type === "webhook" || def.trigger.type === "sub_workflow") &&
    (def.trigger.config.fields ?? []).some((f) => f.type === "resource");
  const bookingCreate = activeSteps.find((s) => s.type === "booking" && s.config.action === "create");
  if ((hasResourceField || bookingCreate) && env.resourceCount === 0) {
    out.push({
      stepId: hasResourceField ? "trigger" : bookingCreate!.id,
      kind: "missing_resource",
      message:
        language === "tl"
          ? "Magdagdag muna ng kahit isang room o resource sa Resources bago subukan o i-on ito."
          : "Add at least one room or resource on the Resources page before testing or turning on.",
    });
  }
  const smsStep = activeSteps.find((s) => s.type === "sms" || (s.type === "payment_due" && s.config.channel === "sms"));
  if (smsStep) {
    const blocks = activeSteps.some((s) => s.type === "sms");
    if (env.smsConfigured === false) {
      out.push({
        stepId: smsStep.id,
        kind: "sms_unavailable",
        blocksPublish: blocks,
        message:
          language === "tl"
            ? "Hindi naka-set up ang SMS sa server na ito, kaya hindi maipapadala ang mga SMS step."
            : "SMS is not set up on this server, so SMS steps cannot send.",
      });
    }
    if (env.smsLimit === 0) {
      out.push({
        stepId: smsStep.id,
        kind: "sms_plan",
        blocksPublish: blocks,
        message:
          language === "tl"
            ? "Walang kasamang pagpapadala ng SMS sa Preview plan (0 SMS bawat buwan). Humiling ng paid plan bago i-on."
            : "SMS sending is not included on the Preview plan (0 SMS per month). Ask kymavo to move you to a paid plan before turning on.",
      });
    } else if (env.smsLimit !== undefined && env.smsLimit !== null && env.smsLimit > 0 && (env.smsUsed ?? 0) >= env.smsLimit) {
      out.push({
        stepId: smsStep.id,
        kind: "sms_quota",
        message:
          language === "tl"
            ? "Naubos na ang buwanang SMS limit ng opisinang ito. Hintayin ang pag-reset o humiling ng mas mataas na plan."
            : "This office used all of its monthly SMS messages. Wait for the reset or ask kymavo for a larger plan.",
      });
    }
  }
  const knowledgeStep = activeSteps.find((s) => (s.type === "ai" && s.config.task === "answer") || s.type === "stay_quote");
  if (knowledgeStep && env.knowledgePublished === false) {
    out.push({
      stepId: knowledgeStep.id,
      kind: "knowledge",
      message:
        language === "tl"
          ? "I-publish muna ang knowledge sheet sa Knowledge page bago patakbuhin ang hakbang na ito."
          : "Publish your knowledge sheet on the Knowledge page before running this step.",
    });
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
