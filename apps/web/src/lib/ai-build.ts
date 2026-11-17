import type { WorkflowDefinition } from "@daloy/engine";

/**
 * Pure helpers for the Build with AI tab (docs/console-navigation-plan.md, section 4): the fixed questions, the
 * request sent to the model, a plain-words reading of the draft, and the nearest ready-made template.
 * People are labels only: the model never sees a real address, and the page swaps them in after the draft returns.
 */
export type Answers = Record<string, string>;
export type Question = { id: string; text: string; choices: { value: string; label: string }[] };
export type Member = { email: string; name?: string };
/** Provider names as GET /settings/connections reports them (PROVIDERS in packages/db). */
export type ConnectedSet = ReadonlySet<string>;

/** Every question also takes a free answer, stored as "other:" followed by what the owner typed. */
export const OTHER = "other:";
export const PEOPLE = { owner: "owner@people.invalid", member1: "member1@people.invalid" } as const;

const PROVIDER_KINDS = ["google_sheets", "slack", "outlook", "teams"];
const choice = (value: string, label: string) => ({ value, label });

export function questions(connected: ConnectedSet, members: Member[]): Question[] {
  const where = [choice("email", "Email"), choice("daloy", "Only Daloy's request list")];
  if (connected.has("google_sheets")) where.push(choice("sheets", "Google Sheet"));
  if (connected.has("slack")) where.push(choice("slack", "Slack"));
  if (connected.has("outlook") || connected.has("teams")) where.push(choice("outlook_teams", "Outlook or Teams"));
  return [
    {
      id: "start",
      text: "What starts it?",
      choices: [choice("form", "Someone fills a form"), choice("booking", "A booking is made"), choice("webhook", "Another system sends a web request"), choice("schedule", "On a schedule")],
    },
    {
      id: "who",
      text: "Who should know?",
      choices: [
        choice("me", "Me"),
        ...members.map((m, i) => choice(`member:${i}`, m.name?.trim() || m.email.split("@")[0]!)),
        choice("filler", "The person who filled the form"),
        choice("none", "No one"),
      ],
    },
    { id: "where", text: "Where should it go?", choices: where },
    { id: "approve", text: "Does someone need to approve it first?", choices: [choice("no", "No"), choice("yes", "Yes, the person named above")] },
  ];
}

const WHERE_LABELS: Record<string, string> = { email: "Email", daloy: "Daloy's request list", sheets: "Google Sheet", slack: "Slack", outlook_teams: "Outlook or Teams" };
const START_LINES: Record<string, string> = {
  form: "It starts when someone fills a form.",
  booking: "It starts when a booking is made.",
  webhook: "It starts when another system sends a web request.",
  schedule: "It runs on a schedule.",
};

const other = (a: string | undefined) => (a?.startsWith(OTHER) ? a.slice(OTHER.length).trim().slice(0, 200) : undefined);

export function buildRequest(description: string, answers: Answers, connected: ConnectedSet, members: Member[]): string {
  const { start, who, where, approve } = answers;
  // The picked member is only ever named by the placeholder; the list is read for its length, never printed.
  const memberPicked = who?.startsWith("member:") && members[Number(who.slice(7))] !== undefined;
  const lines = [description.trim().slice(0, 1200)];
  const add = (s: string | undefined) => s && lines.push(s);

  add(other(start) !== undefined ? `It starts like this: ${other(start)}.` : start && START_LINES[start]);
  if (other(who) !== undefined) add(`Tell: ${other(who)}.`);
  else if (who === "me") add(`Tell the owner (${PEOPLE.owner}).`);
  else if (memberPicked) add(`Tell approver ${PEOPLE.member1}.`);
  else if (who === "filler") add("Send the answer to the person who filled the form ({{trigger.email}}).");
  else if (who === "none") add("No one is told.");
  add(other(where) !== undefined ? `Send it here: ${other(where)}.` : where && WHERE_LABELS[where] && `Send it to ${WHERE_LABELS[where]}.`);
  if (other(approve) !== undefined) add(`About approval: ${other(approve)}.`);
  else if (approve === "yes") add(`Ask ${memberPicked ? PEOPLE.member1 : "the owner"} to approve it first.`);
  else if (approve === "no") add("No approval is needed.");
  const apps = PROVIDER_KINDS.filter((p) => connected.has(p));
  add(`Apps connected: ${apps.length ? apps.join(", ") : "none"}.`);
  return lines.join("\n").slice(0, 2000);
}

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

const WHEN: Record<string, string> = { form: "When someone fills the form", webhook: "When another system sends a web request", manual: "When you run it by hand" };
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
const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
function duration(seconds: number): string {
  for (const [size, name] of [[86_400, "day"], [3600, "hour"], [60, "minute"]] as const) if (seconds % size === 0) return unit(seconds / size, name);
  return unit(seconds, "second");
}

function sentence(step: WorkflowDefinition["steps"][number]): string {
  const c = (step.config ?? {}) as Record<string, unknown>;
  switch (step.type) {
    case "email": {
      const subject = text(c.subject, "");
      return `Email ${text(c.to, "someone")}${subject ? ` (subject: ${subject})` : ""}`;
    }
    case "outlook":
      return `Email ${text(c.to, "someone")} from Outlook`;
    case "approval":
      return `Ask ${text(c.approver, text(c.to, "someone"))} to approve: ${text(c.subject, "this")}`;
    case "sheets":
      return "Add a row to your Google Sheet";
    case "slack":
      return "Post to your Slack channel";
    case "teams":
      return "Post to your Teams channel";
    case "delay": {
      if (typeof c.until === "string") {
        const off = typeof c.offsetSeconds === "number" ? c.offsetSeconds : 0;
        return `Wait until ${off === 0 ? "" : `${duration(Math.abs(off))} ${off < 0 ? "before" : "after"} `}${c.until}`;
      }
      return typeof c.seconds === "number" ? `Wait ${duration(c.seconds)}` : "Wait a while";
    }
    case "condition": {
      const cond = (c.condition ?? {}) as Record<string, unknown>;
      const op = typeof cond.op === "string" ? cond.op : "";
      const right = op === "exists" ? "" : ` ${text(cond.right, "")}`;
      return `Check ${text(cond.left, "a value")} ${op === "exists" ? "is filled in" : (OPS[op] ?? "matches")}${right}`.trimEnd();
    }
    case "ai":
      return `Ask the AI to ${AI_TASKS[String(c.task)] ?? "help"}`;
    case "http":
      return `Send a web request to ${/^(?:[a-z]+:\/\/)?([^/?#]+)/i.exec(text(c.url, ""))?.[1] ?? "another system"}`;
    case "booking":
      return "Hold the booked time";
    default:
      return "Do something";
  }
}

export function plainDraft(def: WorkflowDefinition): { when: string; steps: string[] } {
  const t = def.trigger;
  const when = t.type === "schedule" ? `On a schedule (${t.config.cron})` : (WHEN[t.type] ?? "When you run it by hand");
  const steps: string[] = [];
  const seen = new Set<string>();
  const targets = new Set(def.edges.map((e) => e.to));
  // The unlabelled edge carries on the main line; labelled ones are walked once the line ends, under their label.
  const walk = (id: string | undefined, prefix: string) => {
    const later: { to: string; on: string }[] = [];
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const step = def.steps.find((s) => s.id === id);
      if (!step) break;
      steps.push(prefix + sentence(step));
      const out = def.edges.filter((e) => e.from === id);
      for (const e of out) if (e.on !== undefined) later.push({ to: e.to, on: e.on });
      id = out.find((e) => e.on === undefined)?.to;
    }
    for (const b of later) walk(b.to, `${BRANCH[b.on] ?? `If ${b.on}:`} `);
  };
  walk(def.steps.find((s) => !targets.has(s.id))?.id, "");
  return { when, steps };
}

export type TemplateChoice = { slug: string; label: string; href?: string; action?: "office" | "purchase" };

export function closestTemplate(answers: Answers, description: string): TemplateChoice {
  if (answers.approve === "yes") return { slug: "purchase-request", label: "Purchase request with a named approver", action: "purchase" };
  if (/website|inquiry/i.test(description)) return { slug: "website-inquiry", label: "Reply to a website inquiry", href: "#/settings/business" };
  return { slug: "office-request", label: "Track an office request", action: "office" };
}
