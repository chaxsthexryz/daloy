import { translate, type Language } from "./locale";
import type { WorkflowDefinition } from "@daloy/engine";

/**
 * Pure helpers for Build with AI: a plain-words reading of the draft, the people labels the model writes and the page
 * swaps for real addresses, and the nearest ready-made template when no model answers.
 */
export type Member = { email: string; name?: string };

export const PEOPLE = { owner: "owner@people.invalid", member1: "member1@people.invalid" } as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replaces text in every string value (not keys) of a parsed definition, so quotes in an address cannot break anything. */
function swap<T>(value: T, pairs: [string, string][]): T {
  const re = pairs.map(([from, to]) => ({ re: new RegExp(escape(from), "gi"), to }));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return re.reduce((s, p) => s.replace(p.re, () => p.to), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export const withPeople = (def: WorkflowDefinition, real: { owner: string; member1?: string }): WorkflowDefinition =>
  swap(def, [[PEOPLE.owner, real.owner], ...(real.member1 ? ([[PEOPLE.member1, real.member1]] as [string, string][]) : [])]);

export const withLabels = (def: WorkflowDefinition, real: { owner: string; member1?: string }): WorkflowDefinition =>
  swap(def, [[real.owner, PEOPLE.owner], ...(real.member1 ? ([[real.member1, PEOPLE.member1]] as [string, string][]) : [])]);

const WHEN: Record<string, string> = { email: "When an email arrives", payment: "When a payment event arrives", form: "When someone fills the form", webhook: "When another system sends a web request", manual: "When you run it by hand", meta_dm: "When a Messenger or Instagram DM arrives", shopify_order: "When a new Shopify order comes in", telegram_message: "When someone messages your Telegram bot", booking_event: "When a Daloy booking changes", payment_event: "When a Daloy payment changes", sub_workflow: "When another automation calls this one", sheets_row: "When a row is added to Google Sheets", calendar_event: "When a Google Calendar event is added or starts soon", drive_file: "When a file is added to Google Drive" };
const BRANCH: Record<string, string> = {
  approved: "If approved:",
  rejected: "If rejected:",
  timeout: "If no one answers in time:",
  true: "If the check passes:",
  false: "If the check fails:",
  invalid: "If the check cannot be made:",
  late: "If the time has already passed:",
  done: "If it is booked:",
  taken: "If the time is taken:",
  not_found: "If the booking is not found:",
};
const OPS: Record<string, string> = { eq: "is", neq: "is not", gt: "is more than", gte: "is at least", lt: "is less than", lte: "is at most", contains: "contains" };
const AI_TASKS: Record<string, string> = { classify: "sort it into a group", extract: "pull out the details", summarize: "summarize it", draft: "write a draft" };

const text = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : fallback);
function duration(seconds: number, language: Language): string {
  const unit = (n: number, one: string) => translate(language, `{count} ${one}${n === 1 ? "" : "s"}`, { count: n });
  for (const [size, name] of [[86_400, "day"], [3600, "hour"], [60, "minute"]] as const) if (seconds % size === 0) return unit(seconds / size, name);
  return unit(seconds, "second");
}

function sentence(step: WorkflowDefinition["steps"][number], language: Language): string {
  const t = (source: string, values?: Record<string, string | number>) => translate(language, source, values);
  const c = (step.config ?? {}) as Record<string, unknown>;
  // The form sender's address is a template; say who it is in words.
  const who = (v: unknown) => text(v, t("someone")).replace(/{{s*trigger.emails*}}/g, t("the person who filled the form"));
  switch (step.type) {
    case "email": {
      const subject = text(c.subject, "");
      return t("Email {recipient}{subject}", { recipient: who(c.to), subject: subject ? t(" (subject: {subject})", { subject }) : "" });
    }
    case "outlook":
      return t("Email {recipient} from Outlook", { recipient: who(c.to) });
    case "approval":
      return t("Ask {person} to approve: {subject}", { person: text(c.approver, text(c.to, t("someone"))), subject: text(c.subject, t("this")) });
    case "sheets":
      return t("Add a row to your Google Sheet");
    case "slack":
      return t("Post to your Slack channel");
    case "teams":
      return t("Post to your Teams channel");
    case "delay": {
      if (typeof c.until === "string") {
        const off = typeof c.offsetSeconds === "number" ? c.offsetSeconds : 0;
        return t("Wait until {offset}{time}", { offset: off === 0 ? "" : t("{duration} {direction} ", { duration: duration(Math.abs(off), language), direction: t(off < 0 ? "before" : "after") }), time: c.until });
      }
      return typeof c.seconds === "number" ? t("Wait {duration}", { duration: duration(c.seconds, language) }) : t("Wait a while");
    }
    case "condition": {
      const cond = (c.condition ?? {}) as Record<string, unknown>;
      const op = typeof cond.op === "string" ? cond.op : "";
      const right = op === "exists" ? "" : ` ${text(cond.right, "")}`;
      return t("Check {left} {operator}{right}", { left: text(cond.left, t("a value")), operator: t(op === "exists" ? "is filled in" : (OPS[op] ?? "matches")), right }).trimEnd();
    }
    case "ai":
      return t("Ask the AI to {task}", { task: t(AI_TASKS[String(c.task)] ?? "help") });
    case "http":
      return t("Send a web request to {host}", { host: /^(?:[a-z]+:\/\/)?([^/?#]+)/i.exec(text(c.url, ""))?.[1] ?? t("another system") });
    case "booking":
      return t("Hold the booked time");
    case "sms":
      return t("Send an SMS to {recipient}", { recipient: who(c.to) });
    case "meta_reply":
      return t("Reply on Messenger or Instagram");
    case "discord":
      return t("Post to your Discord channel");
    case "read_page":
      return t("Read a web page");
    case "google_docs":
      return t("Make a Google Docs document from your template");
    case "shopify_create_product":
      return t("Create a product in Shopify");
    case "shopify_update_product":
      return t("Update a product in Shopify");
    case "browser":
      return t("Open {host} in Daloy's browser", { host: /^(?:[a-z]+:\/\/)?([^/?#]+)/i.exec(text(c.url, ""))?.[1] ?? t("a web page") });
    case "call_workflow":
      return t("Run automation {slug}", { slug: text(c.workflowSlug, t("another automation")) });
    default:
      return t("Do something");
  }
}

export function draftPlan(def: WorkflowDefinition, language: Language = "en") {
  const t = (source: string, values?: Record<string, string | number>) => translate(language, source, values);
  const trigger = def.trigger;
  const when = trigger.type === "schedule" ? t("On a schedule ({cron})", { cron: trigger.config.cron }) : t(WHEN[trigger.type] ?? "When you run it by hand");
  const rows: { step: WorkflowDefinition["steps"][number]; action: string }[] = [];
  const seen = new Set<string>();
  const targets = new Set(def.edges.map((e) => e.to));
  // The unlabelled edge carries on the main line; labelled ones are walked once the line ends, under their label.
  const walk = (id: string | undefined, prefix: string) => {
    const later: { to: string; on: string }[] = [];
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const step = def.steps.find((s) => s.id === id);
      if (!step) break;
      rows.push({ step, action: prefix + sentence(step, language) });
      const out = def.edges.filter((e) => e.from === id);
      for (const e of out) if (e.on !== undefined) later.push({ to: e.to, on: e.on });
      id = out.find((e) => e.on === undefined)?.to;
    }
    for (const b of later) walk(b.to, `${BRANCH[b.on] ? t(BRANCH[b.on]!) : t("If {branch}:", { branch: b.on })} `);
  };
  walk(def.steps.find((s) => !targets.has(s.id))?.id, "");
  return { when, rows };
}

export function plainDraft(def: WorkflowDefinition, language: Language = "en") {
  const { when, rows } = draftPlan(def, language);
  return { when, steps: rows.map(row => row.action) };
}

export type TemplateChoice = { slug: string; label: string; href?: string; action?: "office" | "purchase" };

export function closestTemplate(answers: { approve?: string }, description: string): TemplateChoice {
  if (answers.approve === "yes") return { slug: "purchase-request", label: "Purchase request with a named approver", action: "purchase" };
  if (/website|inquiry/i.test(description)) return { slug: "website-inquiry", label: "Reply to a website inquiry", href: "#/settings/business" };
  return { slug: "office-request", label: "Track an office request", action: "office" };
}


/** Known engine lint wording is fixed; all captured identifiers remain as written. Other warnings pass through. */
export function warningForLanguage(warning: string, language: Language): string {
  const patterns: [RegExp, string, string[]][] = [
    [/^Approval step "([^"]+)" has no "([^"]+)" edge, so the run ends there and nobody is told\.$/, 'Approval step "{step}" has no "{branch}" edge, so the run ends there and nobody is told.', ["step", "branch"]],
    [/^Classify label "([^"]+)" of "([^"]+)" reaches condition "([^"]+)" and takes its "([^"]+)" branch, which has no edge, so the run ends there\.$/, 'Classify label "{label}" of "{step}" reaches condition "{condition}" and takes its "{branch}" branch, which has no edge, so the run ends there.', ["label", "step", "condition", "branch"]],
    [/^"([^"]+)" looks like a switch for testing\. Mock test runs already send nothing, but a Live run or a real event follows the branch and can send, so remove it and its branch and test with Mock mode\.$/, '"{field}" looks like a switch for testing. Mock test runs already send nothing, but a Live run or a real event follows the branch and can send, so remove it and its branch and test with Mock mode.', ["field"]],
    [/^Condition "([^"]+)" compares numbers but has no "invalid" edge, so a missing or non-number value fails the run\.$/, 'Condition "{step}" compares numbers but has no "invalid" edge, so a missing or non-number value fails the run.', ["step"]],
    [/^Step "([^"]+)" can never run: only an "invalid" edge that cannot be taken leads to it\.$/, 'Step "{step}" can never run: only an "invalid" edge that cannot be taken leads to it.', ["step"]],
  ];
  for (const [pattern, source, keys] of patterns) {
    const match = pattern.exec(warning);
    if (match) return translate(language, source, Object.fromEntries(keys.map((key, i) => [key, match[i + 1]!])));
  }
  return warning;
}
