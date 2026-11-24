import type { StepRun } from "../api";

// The same shape the engine accepts in a placeholder (packages/engine/src/expressions.ts), so every path offered here resolves.
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
// Same key list the API uses to hide values in run history (apps/api/src/mask.ts). The API already masks; this is a second guard.
const SECRET_KEY = /secret|token|passw(or)?d|authorization|api[-_]?key|cookie/i;
const MAX_DEPTH = 6;

/** A one-line, shortened view of a sample value. */
export function previewValue(value: unknown, max = 40): string {
  const text = (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The paths inside a step's sample output that a field can point at: every leaf value, as `a.b.0.c`, with a short preview.
 * Keys the template engine would reject are left out, and a secret-looking key shows "[secret]" instead of its value.
 */
export function outputPaths(output: unknown, max = 40): { path: string; preview: string }[] {
  const found: { path: string; preview: string }[] = [];
  const walk = (value: unknown, path: string[], secret: boolean) => {
    if (found.length >= max) return;
    if (value !== null && typeof value === "object" && path.length < MAX_DEPTH) {
      for (const [key, child] of Object.entries(value)) {
        if (!SEGMENT.test(key) || FORBIDDEN.has(key)) continue;
        walk(child, [...path, key], secret || (SECRET_KEY.test(key) && child !== null));
      }
    } else if (path.length > 0 && !(value !== null && typeof value === "object" && Object.keys(value).length === 0)) {
      found.push({ path: path.join("."), preview: secret ? "[secret]" : previewValue(value) });
    }
  };
  walk(output, [], false);
  return found.slice(0, max);
}

/** The sample trigger data the owner typed, or undefined when it is empty or not JSON. */
export function parseSample(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && Object.keys(v).length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Each listed step's last attempt that finished with an output (the sample from the last test run). */
export function sampleOutputs(attempts: StepRun[], ids: ReadonlySet<string>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const a of attempts) if (ids.has(a.stepId) && a.state === "succeeded" && a.output !== null) out.set(a.stepId, a.output);
  return out;
}

/** The text with `ref` put where the caret (or selection) is, and where the caret goes next. With no caret the reference is appended. */
export function spliceAt(text: string, ref: string, start: number | null, end: number | null): { value: string; caret: number } {
  const from = Math.min(start ?? text.length, text.length);
  const to = Math.min(Math.max(end ?? from, from), text.length);
  return { value: text.slice(0, from) + ref + text.slice(to), caret: from + ref.length };
}

export type VariableItem = { ref: string; label: string; preview?: string };
export type VariableGroup = { id: string; kind: "trigger" | "step"; items: VariableItem[]; sampled: boolean };

/**
 * What the picker offers for one step: the trigger's fields, then each upstream step's output (never a sibling branch or a step
 * after it). `refs` is `insertables(draft, id)`. A step the last test reached also lists the paths found in its real sample
 * output, each with a preview; one it did not reach keeps the fields we know and has `sampled: false`.
 */
export function variableGroups(refs: string[], attempts: StepRun[], triggerSample: unknown, stepIds: ReadonlySet<string>): VariableGroup[] {
  const samples = sampleOutputs(attempts, stepIds);
  const groups = new Map<string, VariableGroup>();
  const sampleOf = (g: VariableGroup) => (g.kind === "trigger" ? triggerSample : samples.get(g.id));
  const group = (id: string, kind: VariableGroup["kind"]) => {
    const g = groups.get(id) ?? { id, kind, items: [], sampled: kind === "trigger" ? triggerSample !== undefined : samples.has(id) };
    groups.set(id, g);
    return g;
  };
  const add = (g: VariableGroup, ref: string, label: string, preview?: string) => {
    if (!g.items.some((i) => i.ref === ref)) g.items.push({ ref, label, ...(preview !== undefined && { preview }) });
  };
  const paths = (g: VariableGroup, max: number) => (sampleOf(g) === undefined ? [] : outputPaths(sampleOf(g), max));
  const root = (g: VariableGroup) => (g.kind === "trigger" ? "trigger" : `steps.${g.id}.output`);

  // The fields we know about, with a preview when the sample has that exact path.
  for (const ref of refs) {
    const inner = ref.slice(2, -2);
    const m = /^steps.([^.]+).output(?:.(.+))?$/.exec(inner);
    const g = m ? group(m[1]!, "step") : group("trigger", "trigger");
    const path = m ? m[2] : inner.replace(/^trigger./, "");
    const found = paths(g, 200);
    // The whole output is only offered when the sample has nothing more specific to point at.
    if (path === undefined && found.length > 0) continue;
    add(g, ref, path ?? "output", path === undefined ? (sampleOf(g) === undefined ? undefined : previewValue(sampleOf(g))) : found.find((p) => p.path === path)?.preview);
  }
  // Paths the sample has and the fields above did not list.
  if (triggerSample !== undefined && outputPaths(triggerSample, 1).length > 0) group("trigger", "trigger");
  for (const g of groups.values()) for (const p of paths(g, 40)) add(g, `{{${root(g)}.${p.path}}}`, p.path, p.preview);
  return [...groups.values()];
}
