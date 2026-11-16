import { edgeId, entryOf, type Draft } from "./graph";

export type NodeState = "done" | "problem" | "waiting" | "needs_you" | "working" | "idle";
export type EdgeState = "done" | "flowing" | "skipped" | "idle";

/** The words and symbol each node state shows, so colour is never the only signal. */
export const STATUS: Record<NodeState, { label: string; symbol: string }> = {
  done: { label: "Done", symbol: "✓" },
  problem: { label: "Problem", symbol: "✕" },
  waiting: { label: "Waiting", symbol: "⏸" },
  needs_you: { label: "Needs you", symbol: "!" },
  working: { label: "Working", symbol: "…" },
  idle: { label: "Not reached", symbol: "–" },
};

type Row = { stepId: string; state: string; branch: string | null; createdAt: string };
/** The part of a run the diagram needs. */
export type FlowRun = { state: string; needsReview: boolean; steps: Row[] };

const ACTIVE = new Set(["pending", "queued", "running"]);
const ROW_STATE: Record<string, NodeState> = { succeeded: "done", failed: "problem", waiting: "waiting", running: "working", pending: "working" };

/**
 * Turns a run's step rows into a state for every node and edge of its definition, so the editor and the run page
 * draw the same picture. Each step takes its newest attempt. An edge is taken when its source is done and the row's
 * branch matches the edge's label; a taken edge flows while the run is active and its target is working or has no row yet.
 */
export function runFlow(draft: Draft, run: FlowRun | null): { nodes: Record<string, NodeState>; edges: Record<string, EdgeState> } {
  const latest = new Map<string, Row>();
  for (const r of run?.steps ?? []) if (!latest.has(r.stepId) || r.createdAt >= latest.get(r.stepId)!.createdAt) latest.set(r.stepId, r);

  const nodes: Record<string, NodeState> = { trigger: run ? "done" : "idle" };
  for (const s of draft.steps) nodes[s.id] = (latest.has(s.id) && ROW_STATE[latest.get(s.id)!.state]) || "idle";
  // A run in review stopped at its last attempt; that step is the one that needs a person.
  const last = run?.steps.at(-1);
  if (run && (run.needsReview || run.state === "needs_review") && last && nodes[last.stepId] !== undefined && nodes[last.stepId] !== "done") nodes[last.stepId] = "needs_you";

  const active = !!run && ACTIVE.has(run.state);
  const edgeState = (from: string, to: string, on?: string): EdgeState => {
    if (nodes[from] !== "done") return "idle";
    if (on && latest.get(from)?.branch !== on) return "skipped";
    if (nodes[to] === "working" || (nodes[to] === "idle" && active)) return "flowing";
    return nodes[to] === "idle" ? "idle" : "done";
  };
  const edges: Record<string, EdgeState> = {};
  const entry = entryOf(draft);
  if (entry) edges["trigger->entry"] = edgeState("trigger", entry.id);
  for (const e of draft.edges) edges[edgeId(e)] = edgeState(e.from, e.to, e.on);
  return { nodes, edges };
}
