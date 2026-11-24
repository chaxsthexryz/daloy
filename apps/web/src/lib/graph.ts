import { translate, type Language } from "./locale";
import { BRANCHES, definitionSchema, stepLabel, stepNoteSchema, triggerLabel, type Step, type WorkflowDefinition } from "@daloy/engine";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { STATUS, type EdgeState, type NodeState } from "./run-flow";

/**
 * The editor keeps the workflow definition as its only state. Every edit is a pure function from one
 * draft to the next, and React Flow just draws the result (toFlow). The API validates the draft on save.
 */
export type Draft = WorkflowDefinition;
export type Edge = Draft["edges"][number];

/** Step types the builder can add. */
export const ADDABLE = ["condition", "http", "email", "delay", "ai", "approval", "sheets", "drive", "slack", "outlook", "teams", "telegram", "sms", "calendar", "airtable", "notion", "trello", "booking", "meta_reply", "shopify_create_product", "shopify_update_product", "discord", "google_docs", "browser", "read_page"] as const;
export type AddableType = (typeof ADDABLE)[number];

export const blankDraft = (): Draft => ({ trigger: { type: "manual", config: {} }, steps: [], edges: [] });

export function defaultConfig(type: AddableType, language: Language = "en"): Step["config"] {
  const t = (source: string) => translate(language, source);
  switch (type) {
    case "condition":
      return { condition: { left: "{{trigger.amount}}", op: "gt", right: 100 } };
    case "http":
      return { method: "POST", url: "https://example.com/hook", headers: {}, body: "{{trigger}}" };
    case "email":
    case "outlook":
      return { to: "{{trigger.email}}", subject: t("Hello"), text: t("Hi, thanks for getting in touch.") };
    case "delay":
      return { seconds: 60 };
    case "ai":
      return { task: "classify", input: "{{trigger.message}}", labels: { billing: t("Invoices and payments"), support: t("Everything else") } };
    case "approval":
      return { to: "manager@example.com", subject: t("Approval needed"), message: t("Please approve: {{trigger}}"), timeoutSeconds: 86_400 };
    case "sheets":
      return { columns: ["{{trigger.name}}", "{{trigger.summary}}"] };
    case "drive":
      return {};
    case "slack":
    case "teams":
    case "telegram":
    case "discord":
      return { text: t("New request {{trigger.reference}}: {{trigger.summary}}") };
    case "sms":
      return { to: "{{trigger.phone}}", message: t("Hi {{trigger.name}}, your booking is confirmed.") };
    case "calendar":
      return { title: "{{trigger.name}}", description: t("Booking {{steps.book.output.reference}}") };
    case "airtable":
      return { fields: { Name: "{{trigger.name}}", Summary: "{{trigger.summary}}" } };
    case "notion":
      return { title: "{{trigger.reference}}", fields: { Summary: "{{trigger.summary}}" } };
    case "trello":
      return { name: "{{trigger.reference}}", desc: "{{trigger.summary}}" };
    case "booking":
      // Needs a resource field and a datetime field with these names on the trigger before it saves.
      return { action: "create", resource: "{{trigger.therapist}}", start: "{{trigger.appointment_at}}", minutes: 60 };
    case "read_page":
      return { url: "https://example.com/", maxChars: 4000 };
    case "google_docs":
      // templateId stays empty until the owner picks a template in the step panel, so the step cannot be saved without one.
      return { templateId: "", name: t("Document for {{trigger.name}}"), values: { name: "{{trigger.name}}" } };
    case "meta_reply":
      return { recipientId: "{{trigger.senderId}}", channel: "{{trigger.channel}}", text: t("Thanks for your message.") };
    // A new product is a draft until the owner says active, so nothing goes on sale by surprise.
    case "shopify_create_product":
      return { title: t("New product"), status: "draft" };
    case "shopify_update_product":
      return { by: "sku", product: "", price: "" };
    // Reads one value, so the step is useful as added and the owner only changes the address and the selector.
    case "browser":
      return { url: "https://example.com/", actions: [{ action: "extract", selector: "h1", name: "heading" }] };
  }
}

const branchesOf = (step: Step | undefined) => (step ? BRANCHES[step.type] : undefined);

function newStepId(draft: Draft, type: string) {
  const used = new Set(draft.steps.map((s) => s.id));
  let n = 1;
  while (used.has(`${type}_${n}`)) n++;
  return `${type}_${n}`;
}

export const entryOf = (draft: Draft) => draft.steps.find((s) => !draft.edges.some((e) => e.to === s.id));
/** The React Flow id of a draft edge; run-flow.ts keys its edge states by it. */
export const edgeId = (e: Edge) => `${e.from}:${e.on ?? "next"}`;

/**
 * Adds a step after `after.id` (on branch `after.on`, or the first free branch). If that slot already
 * leads somewhere, the new step is inserted in between. Without `after`, the step becomes the new entry.
 * `config` defaults to the type's starting config; a pasted step brings its own.
 */
export function addStep(draft: Draft, type: AddableType, after?: { id: string; on?: string }, language: Language = "en", config: Step["config"] = defaultConfig(type, language), note?: string): { draft: Draft; id: string } {
  const id = newStepId(draft, type);
  return { draft: insert(draft, { id, type, config, ...(note && { note }) } as Step, after), id };
}

function insert(draft: Draft, step: Step, after?: { id: string; on?: string }): Draft {
  const { id } = step;
  const ownLabel = BRANCHES[step.type]?.[0];
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
  return { ...draft, steps: [...draft.steps, step], edges };
}

export type DuplicateError = { id: "branching" | "missing"; step: string };

/**
 * Copies a step (same type and config) under the id `<id>_copy`, `<id>_copy_2` and so on, right after the original. A step with
 * branches is refused: its copy would need a step on every branch, which the owner has to choose.
 */
export function duplicateStep(draft: Draft, id: string): { draft: Draft; id: string } | { error: DuplicateError } {
  const step = draft.steps.find((s) => s.id === id);
  if (!step) return { error: { id: "missing", step: id } };
  if (BRANCHES[step.type]) return { error: { id: "branching", step: id } };
  const used = new Set(draft.steps.map((s) => s.id));
  const base = `${id.slice(0, 50)}_copy`; // step ids are at most 64 characters
  let copy = base;
  for (let n = 2; used.has(copy); n++) copy = `${base}_${n}`;
  return { draft: insert(draft, { ...step, id: copy }, { id }), id: copy };
}

/** Turns a step off or on again. A branching step stays on: a skipped step has no branch to follow (decision 0097). */
export function setDisabled(draft: Draft, id: string, off: boolean): Draft {
  const steps = draft.steps.map((s) => {
    if (s.id !== id || (off && BRANCHES[s.type])) return s;
    const on = { ...s };
    delete on.disabled;
    return off ? { ...on, disabled: true as const } : on;
  });
  return { ...draft, steps };
}

/**
 * The paste check: reads a copied step (`{type, config, note}` as JSON, from the clipboard) and returns it only when the type is one the
 * add menu offers and the config has that step's shape, with unknown keys dropped. Rules that need the rest of the flow (a drive
 * step needs a form with a file field) are left to the save check, as for a step added from the menu.
 */
export function readCopiedStep(text: string): { type: AddableType; config: Step["config"]; note?: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { type, config, note: copiedNote } = value as { type?: unknown; config?: unknown; note?: unknown };
  if (!(ADDABLE as readonly unknown[]).includes(type)) return null;
  // A note that does not fit (too long, not text) is dropped; the step itself still pastes.
  const note = stepNoteSchema.safeParse(copiedNote).data;
  const withNote = note ? { note } : {};
  const r = definitionSchema.safeParse({ ...blankDraft(), steps: [{ id: "pasted", type, config }] });
  if (r.success) return { type: type as AddableType, config: r.data.steps[0]!.config, ...withNote };
  return r.error.issues.every((i) => i.code === "custom") ? { type: type as AddableType, config: config as Step["config"], ...withNote } : null;
}

/** Removes a step. A step with one parent and one child is bridged, keeping the parent's branch label. */
export function removeStep(draft: Draft, id: string): Draft {
  const incoming = draft.edges.filter((e) => e.to === id);
  const outgoing = draft.edges.filter((e) => e.from === id);
  const edges = draft.edges.filter((e) => e.from !== id && e.to !== id);
  if (incoming.length === 1 && outgoing.length === 1) edges.push({ from: incoming[0]!.from, to: outgoing[0]!.to, ...(incoming[0]!.on && { on: incoming[0]!.on }) });
  return { ...draft, steps: draft.steps.filter((s) => s.id !== id), edges };
}

const quiet = (d: Draft, id: string) => {
  const step = d.steps.find((s) => s.id === id);
  const out = d.edges.filter((e) => e.from === id);
  return !!step && !BRANCHES[step.type] && out.length <= 1 && out.every((e) => e.on === undefined);
};
/** The step that `id` would swap places with when moved down: both have one plain way out and the other has one way in. */
function below(d: Draft, id: string): string | undefined {
  const next = d.edges.find((e) => e.from === id)?.to;
  if (!next || !quiet(d, id) || !quiet(d, next) || d.edges.filter((e) => e.to === next).length !== 1) return undefined;
  return next;
}
/** The step above `id` in a straight stretch: its only parent, when that parent has no other way out. */
function above(d: Draft, id: string): string | undefined {
  const into = d.edges.filter((e) => e.to === id);
  return into.length === 1 && below(d, into[0]!.from) === id ? into[0]!.from : undefined;
}
export const canMove = (d: Draft, id: string, dir: "up" | "down") => (dir === "down" ? below(d, id) : above(d, id)) !== undefined;

/**
 * Swaps a step with its neighbour on a straight stretch of the flow. Steps with branches, and steps next to them, stay put
 * (the draft comes back unchanged). Edges into the stretch keep their branch labels, and the steps are renumbered in flow order.
 */
export function moveStep(draft: Draft, id: string, dir: "up" | "down"): Draft {
  const top = dir === "down" ? id : above(draft, id);
  const bottom = top && below(draft, top);
  if (!top || !bottom) return draft;
  const edges = draft.edges.map((e) => (e.to === top ? { ...e, to: bottom } : e.from === top ? { from: bottom, to: top } : e.from === bottom ? { from: top, to: e.to } : e));
  const moved = { ...draft, edges };
  const y = layout(moved);
  const steps = [...draft.steps].sort((a, b) => y[a.id]!.y - y[b.id]!.y);
  const at = new Map(steps.map((s, n) => [s.id, n]));
  return { ...moved, steps, edges: [...edges].sort((a, b) => at.get(a.from)! - at.get(b.from)!) };
}

export type ConnectError = { id: "self" } | { id: "loop"; from: string; to: string } | { id: "branch"; from: string } | { id: "orphan"; step: string };

/**
 * Points the `on` path of step `from` at step `to`, replacing what that path led to before. It refuses, with a reason, a link to
 * itself, a loop, a missing or wrong branch, and a change that would leave another step with no way in.
 */
export function connectSteps(draft: Draft, from: string, on: string | undefined, to: string): { draft: Draft } | { error: ConnectError } {
  const source = draft.steps.find((s) => s.id === from);
  if (!source || !draft.steps.some((s) => s.id === to)) return { error: { id: "branch", from } };
  if (from === to) return { error: { id: "self" } };
  const labels = BRANCHES[source.type];
  if (labels ? on === undefined || !labels.includes(on) : on !== undefined) return { error: { id: "branch", from } };
  const edges = [...draft.edges.filter((e) => !(e.from === from && e.on === on)), { from, to, ...(on && { on }) }];
  const leadsTo = (a: string, b: string, seen = new Set<string>()): boolean => a === b || (!seen.has(a) && edges.some((e) => e.from === a && leadsTo(e.to, b, seen.add(a))));
  if (leadsTo(to, from)) return { error: { id: "loop", from, to } };
  const orphan = draft.steps.find((s) => !edges.some((e) => e.to === s.id) && draft.edges.some((e) => e.to === s.id));
  if (orphan) return { error: { id: "orphan", step: orphan.id } };
  const order = new Map(draft.steps.map((s, n) => [s.id, n]));
  return { draft: { ...draft, edges: edges.sort((a, b) => order.get(a.from)! - order.get(b.from)!) } };
}

export const NODE_W = 220;
const COL = 260;
const DEFAULT_H = 88;
const ROW_GAP = 82; // DEFAULT_H + ROW_GAP = 170px default spacing with room for exit add stubs and branch pills

export type MeasuredSizes = Record<string, { width?: number; height?: number }>;

/**
 * Branch-aware top-to-bottom DAG layout: assigns each step to one row below its deepest parent,
 * orders children by `BRANCHES` order (e.g., true left of false), centers parents above subtrees,
 * and spaces rows using measured card heights when available.
 */
export function layout(draft: Draft, measured?: MeasuredSizes): Record<string, { x: number; y: number }> {
  const stepById = new Map(draft.steps.map((s) => [s.id, s]));
  const stepOrder = new Map(draft.steps.map((s, i) => [s.id, i]));
  const branchRank = (from: string, on?: string) => {
    const step = stepById.get(from);
    const list = step && BRANCHES[step.type];
    if (!list || !on) return 0;
    const i = list.indexOf(on);
    return i >= 0 ? i : list.length;
  };

  const depth = new Map<string, number>();
  const visit = (id: string, d: number, seen: Set<string>) => {
    if (seen.has(id) || (depth.get(id) ?? -1) >= d) return; // seen guards against cycles in an unsaved draft
    depth.set(id, d);
    for (const e of draft.edges) if (e.from === id) visit(e.to, d + 1, new Set(seen).add(id));
  };
  for (const s of draft.steps) if (!draft.edges.some((e) => e.to === s.id)) visit(s.id, 1, new Set());
  for (const s of draft.steps) if (!depth.has(s.id)) depth.set(s.id, 1);

  // Pick each non-root node's primary parent (deepest parent, ties broken by branch order then parent order).
  const treeParent = new Map<string, string>();
  const treeChildren = new Map<string, string[]>();
  const roots: string[] = [];
  for (const s of draft.steps) {
    const incoming = draft.edges.filter((e) => e.to === s.id && e.from !== s.id);
    if (incoming.length === 0) {
      roots.push(s.id);
      continue;
    }
    incoming.sort(
      (a, b) =>
        (depth.get(b.from) ?? 0) - (depth.get(a.from) ?? 0) ||
        branchRank(a.from, a.on) - branchRank(b.from, b.on) ||
        (stepOrder.get(a.from) ?? 0) - (stepOrder.get(b.from) ?? 0),
    );
    const chosen = incoming[0]!.from;
    treeParent.set(s.id, chosen);
    treeChildren.set(chosen, [...(treeChildren.get(chosen) ?? []), s.id]);
  }
  // Order each parent's children by branch order (true before false, approved before rejected/timeout).
  for (const [parent, kids] of treeChildren) {
    const out = draft.edges.filter((e) => e.from === parent);
    const rankOf = (kid: string) => {
      const edge = out.find((e) => e.to === kid);
      return branchRank(parent, edge?.on);
    };
    kids.sort((a, b) => rankOf(a) - rankOf(b) || (stepOrder.get(a) ?? 0) - (stepOrder.get(b) ?? 0));
  }

  const slotWidth = new Map<string, number>();
  const widthOf = (id: string, seen = new Set<string>()): number => {
    if (slotWidth.has(id)) return slotWidth.get(id)!;
    if (seen.has(id)) return 1;
    const nextSeen = new Set(seen).add(id);
    const kids = (treeChildren.get(id) ?? []).filter((k) => treeParent.get(k) === id);
    const w = kids.length === 0 ? 1 : kids.reduce((sum, k) => sum + widthOf(k, nextSeen), 0);
    slotWidth.set(id, w);
    return w;
  };
  for (const s of draft.steps) widthOf(s.id);

  const rawX = new Map<string, number>();
  const place = (id: string, leftSlot: number, seen = new Set<string>()): number => {
    if (seen.has(id)) return leftSlot + 0.5;
    const nextSeen = new Set(seen).add(id);
    const kids = (treeChildren.get(id) ?? []).filter((k) => treeParent.get(k) === id);
    if (kids.length === 0) {
      const cx = (leftSlot + 0.5) * COL;
      rawX.set(id, cx);
      return cx;
    }
    let cursor = leftSlot;
    const centers: number[] = [];
    for (const k of kids) {
      centers.push(place(k, cursor, nextSeen));
      cursor += slotWidth.get(k) ?? 1;
    }
    const cx = (centers[0]! + centers[centers.length - 1]!) / 2;
    rawX.set(id, cx);
    return cx;
  };

  let rootCursor = 0;
  for (const r of roots) {
    place(r, rootCursor);
    rootCursor += widthOf(r);
  }
  const entryCenter = roots.length ? rawX.get(roots[0]!) ?? 0 : 0;

  // Row-level minimum gap enforcement for DAG joins and shifted coordinates centered on entry (trigger x = 0).
  const maxDepth = Math.max(0, ...depth.values());
  const rows = new Map<number, string[]>();
  for (const s of draft.steps) rows.set(depth.get(s.id)!, [...(rows.get(depth.get(s.id)!) ?? []), s.id]);
  for (const [, ids] of rows) {
    ids.sort((a, b) => (rawX.get(a) ?? 0) - (rawX.get(b) ?? 0) || (stepOrder.get(a) ?? 0) - (stepOrder.get(b) ?? 0));
    for (let i = 1; i < ids.length; i++) {
      const prev = rawX.get(ids[i - 1]!) ?? 0;
      const curr = rawX.get(ids[i]!) ?? 0;
      if (curr - prev < COL) rawX.set(ids[i]!, prev + COL);
    }
  }

  const yByDepth: number[] = [0];
  for (let d = 0; d < maxDepth; d++) {
    const ids = d === 0 ? ["trigger"] : (rows.get(d) ?? []);
    const rowH = ids.reduce((m, id) => Math.max(m, measured?.[id]?.height ?? DEFAULT_H), DEFAULT_H);
    yByDepth[d + 1] = yByDepth[d]! + rowH + ROW_GAP;
  }

  const pos: Record<string, { x: number; y: number }> = { trigger: { x: 0, y: 0 } };
  for (const s of draft.steps) {
    pos[s.id] = { x: (rawX.get(s.id) ?? 0) - entryCenter, y: yByDepth[depth.get(s.id)!]! };
  }
  return pos;
}

/** context: the draft's trigger, for a step's destination line. chosen: the destination picked in Apps (a channel, a sheet, a list). */
export type StepNodeData = { step?: Step; trigger?: Draft["trigger"]; context?: Draft["trigger"]; chosen?: string; branches?: readonly string[]; status?: NodeState };
export type RunEdgeData = { state: EdgeState };
/** What a run says about the diagram (see runFlow). Without it the diagram is drawn plain, as in the editor with no run. */
export type FlowState = { nodes: Record<string, NodeState>; edges: Record<string, EdgeState> };

export function toFlow(draft: Draft, selected: string | null, state?: FlowState, language: Language = "en", measured?: MeasuredSizes): { nodes: FlowNode<StepNodeData>[]; edges: FlowEdge[] } {
  const t = (source: string, values?: Record<string, string | number>) => translate(language, source, values);
  const pos = layout(draft, measured);
  // Screen readers get the state in words, as sighted users do on the node.
  const said = (id: string) => (state ? t(", {status}", { status: t(STATUS[state.nodes[id] ?? "idle"].label) }) : "");
  const edgeProps = (id: string) => (state ? { type: "run", data: { state: state.edges[id] ?? "idle" } satisfies RunEdgeData } : {});
  const at = (id: string) => ({ x: pos[id]!.x - NODE_W / 2, y: pos[id]!.y });
  const nodes: FlowNode<StepNodeData>[] = [
    { id: "trigger", type: "trigger", ariaLabel: t("Trigger: {type}", { type: triggerLabel(draft.trigger.type, language) }) + said("trigger"), position: at("trigger"), data: { trigger: draft.trigger, status: state?.nodes.trigger }, selected: selected === "trigger", deletable: false },
    ...draft.steps.map((step) => ({
      id: step.id,
      type: "step",
      // Screen readers announce the node by this name; branches say where each one leads.
      ariaLabel: `${t("{type} step {id}", { type: stepLabel(step.type, language), id: step.id })}${draft.edges
        .filter((e) => e.from === step.id)
        .map((e) => t(", {branch}goes to {id}", { branch: e.on ? `${t("on {branch}", { branch: t(e.on) })} ` : "", id: e.to }))
        .join("")}${step.disabled ? t(", turned off") : ""}${said(step.id)}`,
      position: at(step.id),
      data: { step, context: draft.trigger, branches: BRANCHES[step.type], status: state?.nodes[step.id] },
      selected: selected === step.id,
    })),
  ];
  const entry = entryOf(draft);
  const edges: FlowEdge[] = [
    ...(entry ? [{ id: "trigger->entry", source: "trigger", target: entry.id, deletable: false, ...edgeProps("trigger->entry") }] : []),
    ...draft.edges.map((e) => ({
      id: edgeId(e),
      source: e.from,
      target: e.to,
      deletable: false,
      ...edgeProps(edgeId(e)),
      ...(e.on && { sourceHandle: e.on, label: t(e.on) }),
    })),
  ];
  return { nodes, edges };
}
