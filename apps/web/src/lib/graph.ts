import { BRANCHES, type Step, type WorkflowDefinition } from "@daloy/engine";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";

/**
 * The editor keeps the workflow definition as its only state. Every edit is a pure function from one
 * draft to the next, and React Flow just draws the result (toFlow). The API validates the draft on save.
 */
export type Draft = WorkflowDefinition;
export type Edge = Draft["edges"][number];

/** Step types the builder can add. */
export const ADDABLE = ["condition", "http", "email", "delay", "ai", "approval"] as const;
export type AddableType = (typeof ADDABLE)[number];

export const blankDraft = (): Draft => ({ trigger: { type: "manual", config: {} }, steps: [], edges: [] });

export function defaultConfig(type: AddableType): Step["config"] {
  switch (type) {
    case "condition":
      return { condition: { left: "{{trigger.amount}}", op: "gt", right: 100 } };
    case "http":
      return { method: "POST", url: "https://example.com/hook", headers: {}, body: "{{trigger}}" };
    case "email":
      return { to: "{{trigger.email}}", subject: "Hello", text: "Hi, thanks for getting in touch." };
    case "delay":
      return { seconds: 60 };
    case "ai":
      return { task: "classify", input: "{{trigger.message}}", labels: { billing: "Invoices and payments", support: "Everything else" } };
    case "approval":
      return { to: "manager@example.com", subject: "Approval needed", message: "Please approve: {{trigger}}", timeoutSeconds: 86_400 };
  }
}

const branchesOf = (step: Step | undefined) => (step ? BRANCHES[step.type] : undefined);

function newStepId(draft: Draft, type: string) {
  const used = new Set(draft.steps.map((s) => s.id));
  let n = 1;
  while (used.has(`${type}_${n}`)) n++;
  return `${type}_${n}`;
}

const entryOf = (draft: Draft) => draft.steps.find((s) => !draft.edges.some((e) => e.to === s.id));

/**
 * Adds a step after `after.id` (on branch `after.on`, or the first free branch). If that slot already
 * leads somewhere, the new step is inserted in between. Without `after`, the step becomes the new entry.
 */
export function addStep(draft: Draft, type: AddableType, after?: { id: string; on?: string }): { draft: Draft; id: string } {
  const id = newStepId(draft, type);
  const step = { id, type, config: defaultConfig(type) } as Step;
  const ownLabel = BRANCHES[type]?.[0];
  const edges = [...draft.edges];

  if (!after) {
    const entry = entryOf(draft);
    if (entry) edges.push({ from: id, to: entry.id, ...(ownLabel && { on: ownLabel }) });
  } else {
    const labels = branchesOf(draft.steps.find((s) => s.id === after.id));
    const on = labels ? (after.on ?? labels.find((l) => !edges.some((e) => e.from === after.id && e.on === l)) ?? labels[0]) : undefined;
    const i = edges.findIndex((e) => e.from === after.id && e.on === on);
    if (i >= 0) {
      const [old] = edges.splice(i, 1);
      edges.push({ from: id, to: old!.to, ...(ownLabel && { on: ownLabel }) });
    }
    edges.push({ from: after.id, to: id, ...(on && { on }) });
  }
  // Keep edges ordered by source so the draft reads top to bottom.
  const order = new Map([...draft.steps.map((s) => s.id), id].map((s, n) => [s, n]));
  edges.sort((a, b) => order.get(a.from)! - order.get(b.from)!);
  return { draft: { ...draft, steps: [...draft.steps, step], edges }, id };
}

/** Removes a step. A step with one parent and one child is bridged, keeping the parent's branch label. */
export function removeStep(draft: Draft, id: string): Draft {
  const incoming = draft.edges.filter((e) => e.to === id);
  const outgoing = draft.edges.filter((e) => e.from === id);
  const edges = draft.edges.filter((e) => e.from !== id && e.to !== id);
  if (incoming.length === 1 && outgoing.length === 1) edges.push({ from: incoming[0]!.from, to: outgoing[0]!.to, ...(incoming[0]!.on && { on: incoming[0]!.on }) });
  return { ...draft, steps: draft.steps.filter((s) => s.id !== id), edges };
}

export const NODE_W = 220;
const COL = 260;
const ROW = 130;

/** Top-to-bottom layout: a step sits one row below its deepest parent, and each row is centred. */
export function layout(draft: Draft): Record<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const visit = (id: string, d: number, seen: Set<string>) => {
    if (seen.has(id) || (depth.get(id) ?? -1) >= d) return; // seen guards against cycles in an unsaved draft
    depth.set(id, d);
    for (const e of draft.edges) if (e.from === id) visit(e.to, d + 1, new Set(seen).add(id));
  };
  for (const s of draft.steps) if (!draft.edges.some((e) => e.to === s.id)) visit(s.id, 1, new Set());
  for (const s of draft.steps) if (!depth.has(s.id)) depth.set(s.id, 1);

  const rows = new Map<number, string[]>();
  for (const s of draft.steps) rows.set(depth.get(s.id)!, [...(rows.get(depth.get(s.id)!) ?? []), s.id]);
  const pos: Record<string, { x: number; y: number }> = { trigger: { x: 0, y: 0 } };
  for (const [d, ids] of rows) ids.forEach((id, i) => (pos[id] = { x: (i - (ids.length - 1) / 2) * COL, y: d * ROW }));
  return pos;
}

export type StepNodeData = { step?: Step; trigger?: Draft["trigger"]; branches?: readonly string[] };

export function toFlow(draft: Draft, selected: string | null): { nodes: FlowNode<StepNodeData>[]; edges: FlowEdge[] } {
  const pos = layout(draft);
  const at = (id: string) => ({ x: pos[id]!.x - NODE_W / 2, y: pos[id]!.y });
  const nodes: FlowNode<StepNodeData>[] = [
    { id: "trigger", type: "trigger", ariaLabel: `Trigger: ${draft.trigger.type}`, position: at("trigger"), data: { trigger: draft.trigger }, selected: selected === "trigger", deletable: false },
    ...draft.steps.map((step) => ({
      id: step.id,
      type: "step",
      // Screen readers announce the node by this name; branches say where each one leads.
      ariaLabel: `${step.type} step ${step.id}${draft.edges
        .filter((e) => e.from === step.id)
        .map((e) => `, ${e.on ? `on ${e.on} ` : ""}goes to ${e.to}`)
        .join("")}`,
      position: at(step.id),
      data: { step, branches: BRANCHES[step.type] },
      selected: selected === step.id,
    })),
  ];
  const entry = entryOf(draft);
  const edges: FlowEdge[] = [
    ...(entry ? [{ id: "trigger->entry", source: "trigger", target: entry.id, deletable: false }] : []),
    ...draft.edges.map((e) => ({
      id: `${e.from}:${e.on ?? "next"}`,
      source: e.from,
      target: e.to,
      deletable: false,
      ...(e.on && { sourceHandle: e.on, label: e.on }),
    })),
  ];
  return { nodes, edges };
}
