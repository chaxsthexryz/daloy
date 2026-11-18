import { isDraft } from "./drafts";
import { plainState, type LastRun } from "./states";

export type Filter = "all" | "needs_you" | "problem" | "waiting" | "off";
type Listed = { id: string; name: string; createdAt: string; live?: boolean; pausedAt?: string | null; setup?: unknown; last?: LastRun | null; scheduleMissedAt?: string | null };

/** A missed schedule counts as a problem, unless the last run already needs the owner. */
const key = (w: Listed) => {
  const k = w.last ? plainState(w.last).key : null;
  // A paused automation starts nothing on purpose, so only a run that still needs a person counts (N11b).
  if (w.pausedAt) return k === "needs_you" ? k : null;
  return w.scheduleMissedAt && k !== "needs_you" ? "problem" : k;
};
const rank = (w: Listed) => ({ needs_you: 0, problem: 1 })[key(w) as string] ?? 2;

/**
 * The Automations list as shown: drafts apart, the rest narrowed by name and plain state, with the ones that need a
 * person first (the sort is stable, so the API's order holds within each rank).
 */
export function arrange<W extends Listed>(list: W[], query: string, filter: Filter) {
  const q = query.trim().toLowerCase();
  const named = list.filter((w) => w.name.toLowerCase().includes(q));
  const shown = named
    .filter((w) => !isDraft(w))
    .filter((w) => filter === "all" || (filter === "off" ? !w.live || !!w.pausedAt : key(w) === filter))
    .sort((a, b) => rank(a) - rank(b));
  return { shown, drafts: named.filter(isDraft) };
}
