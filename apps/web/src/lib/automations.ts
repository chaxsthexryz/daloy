import { isDraft } from "./drafts";
import { plainState, type LastRun } from "./states";

export type Filter = "all" | "needs_you" | "problem" | "waiting" | "off";
type Listed = { id: string; name: string; createdAt: string; live?: boolean; setup?: unknown; last?: LastRun | null };

const key = (w: Listed) => (w.last ? plainState(w.last).key : null);
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
    .filter((w) => filter === "all" || (filter === "off" ? !w.live : key(w) === filter))
    .sort((a, b) => rank(a) - rank(b));
  return { shown, drafts: named.filter(isDraft) };
}
