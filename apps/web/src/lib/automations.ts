import { isDraft } from "./drafts";
import { plainState, type LastRun } from "./states";

/** The plain states of the newest run, then the four statuses an automation can be in. */
export type Filter = "all" | "needs_you" | "problem" | "waiting" | "on" | "paused" | "off" | "draft";
type Listed = { id: string; name: string; createdAt: string; live?: boolean; pausedAt?: string | null; setup?: unknown; last?: LastRun | null; scheduleMissedAt?: string | null };

/** A missed schedule counts as a problem, unless the last run already needs the owner. */
export const stateKey = (w: Listed) => {
  const k = w.last ? plainState(w.last).key : null;
  // A paused automation starts nothing on purpose, so only a run that still needs a person counts (N11b).
  if (w.pausedAt) return k === "needs_you" ? k : null;
  return w.scheduleMissedAt && k !== "needs_you" ? "problem" : k;
};
const rank = (w: Listed) => ({ needs_you: 0, problem: 1 })[stateKey(w) as string] ?? 2;

/** One status per automation: paused wins, then a draft (set up, never turned on), then on, then off. */
export const statusOf = (w: Listed): "on" | "paused" | "off" | "draft" => (w.pausedAt ? "paused" : isDraft(w) ? "draft" : w.live ? "on" : "off");

export type DisplayTone = "needs" | "problem" | "on" | "paused" | "off" | "draft";
export type DisplayLabel = "Needs you" | "Problem" | "On" | "Paused" | "Off" | "Draft";

/** Unified status shown in both the table row dot and the inspector panel badge. */
export function displayStatus(w: Listed, reviewCount = 0): { tone: DisplayTone; label: DisplayLabel } {
  const key = stateKey(w);
  if (reviewCount > 0 || key === "needs_you") return { tone: "needs", label: "Needs you" };
  if (key === "problem") return { tone: "problem", label: "Problem" };
  const status = statusOf(w);
  if (status === "paused") return { tone: "paused", label: "Paused" };
  if (status === "draft") return { tone: "draft", label: "Draft" };
  if (status === "off") return { tone: "off", label: "Off" };
  return { tone: "on", label: "On" };
}

const matches = (w: Listed, filter: Filter) => (filter === "all" ? true : filter === "on" || filter === "paused" || filter === "off" || filter === "draft" ? statusOf(w) === filter : stateKey(w) === filter);

/**
 * The Automations table as shown: narrowed by name and status or plain state, with the ones that need a person first
 * (the sort is stable, so the API's order holds within each rank). Drafts are rows with the status Draft.
 */
export function arrange<W extends Listed>(list: W[], query: string, filter: Filter) {
  const q = query.trim().toLowerCase();
  const shown = list
    .filter((w) => w.name.toLowerCase().includes(q))
    .filter((w) => matches(w, filter))
    .sort((a, b) => rank(a) - rank(b));
  return { shown };
}

/** How many automations each filter shows with no search, so a tile and the list it opens always agree. */
export function counts(list: Listed[]) {
  const c = { total: list.length, needs_you: 0, problem: 0, waiting: 0, on: 0, paused: 0, off: 0, draft: 0 };
  for (const w of list) {
    c[statusOf(w)] += 1;
    const k = stateKey(w);
    if (k === "needs_you" || k === "problem" || k === "waiting") c[k] += 1;
  }
  return c;
}

const TRIGGERS: Record<string, string> = { form: "Form", email: "Email in", schedule: "Schedule", webhook: "Webhook", manual: "Manual", payment: "Payment" };

/** A trigger type in a word or two for the Trigger column. An unknown type shows as it is, no type shows nothing. */
export const triggerLabel = (type: string | undefined) => (type === undefined ? "" : (TRIGGERS[type] ?? type));

/** Keeps the rows whose trigger type is loaded and equals the chosen one; "any" keeps every row. */
export const withTrigger = <W extends { id: string }>(rows: W[], type: string, of: Record<string, string>) => (type === "any" ? rows : rows.filter((w) => of[w.id] === type));
