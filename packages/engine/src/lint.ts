import { triggerFields, type Condition, type WorkflowDefinition } from "./definition";
import { conditionBranch, switchBranch, toNumber } from "./expressions";
import { entryStep } from "./graph";

/**
 * Warnings about a definition that is valid but probably not what the business meant (decision 0033). They are advice:
 * saving and publishing never wait for them. Each message names only step ids, field names and labels, which use a
 * fixed charset, so the list can go back to the model in the repair round without carrying any free text.
 */
const SWITCH_NAME = /dry_?run|^(test|testing|test_?mode|is_?test|sandbox|simulate|simulation|debug)$/;
const NUMERIC_OPS = ["gt", "gte", "lt", "lte"];
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const TRIGGER_REF = /^\{\{\s*trigger\.([a-z][a-z0-9_]*)\s*\}\}$/;
const LABEL_REF = /^\{\{\s*steps\.([a-z][a-z0-9_]*)\.output\.label\s*\}\}$/;

export type LintRule = "approval_no_edge" | "classify_dead_end" | "test_switch" | "number_no_invalid" | "unreachable_step";

export const lintDefinition = (def: WorkflowDefinition): string[] => [...lintFindings(def).map((f) => f.message), ...aiFileWarnings(def), ...browserWarnings(def)];

// A browser step (decision 0108) that keeps no value and no picture gives later steps only the last address.
function browserWarnings(def: WorkflowDefinition): string[] {
  return def.steps
    .filter((s) => s.type === "browser" && !s.config.actions.some((a) => a.action === "extract" || a.action === "screenshot"))
    .map((s) => `Browser step "${s.id}" reads nothing and takes no screenshot, so later steps only get the page address. Add an extract or a screenshot action.`);
}

// Advice for the editor and the builder only, so it is not a LintRule: the run explainer has no line for it.
// An AI step in a form with a file field that reads none: the owner has not allowed it yet (decision 0052).
function aiFileWarnings(def: WorkflowDefinition): string[] {
  if (!(triggerFields(def.trigger) ?? []).some((f) => f.type === "file")) return [];
  return def.steps
    .filter((s) => s.type === "ai" && !s.config.files?.length)
    .map((s) => `AI step "${s.id}" reads no file, but the form has a file field. Tick it under "Let the AI read these files" on that step.`);
}

export function lintFindings(def: WorkflowDefinition): { rule: LintRule; message: string }[] {
  const warnings: { rule: LintRule; message: string }[] = [];
  const warn = (rule: LintRule, message: string) => warnings.push({ rule, message });
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const edgeTo = (from: string, on?: string) => def.edges.find((e) => e.from === from && e.on === on)?.to;
  const conditions = def.steps.flatMap((s) => (s.type === "condition" ? [{ id: s.id, cond: s.config.condition }] : []));

  // A decision nobody answers, or a timeout nobody is told about, ends the run in silence.
  for (const s of def.steps) {
    if (s.type !== "approval") continue;
    for (const branch of ["rejected", "timeout"]) {
      if (!edgeTo(s.id, branch)) warn("approval_no_edge", `Approval step "${s.id}" has no "${branch}" edge, so the run ends there and nobody is told.`);
    }
  }

  // Follow each classify label through the conditions or switches that test it. A label that lands on a branch with no edge ends the run.
  for (const s of def.steps) {
    if (s.type !== "ai" || s.config.task !== "classify") continue;
    for (const label of Object.keys(s.config.labels ?? {})) {
      const ctx = { trigger: {}, steps: { [s.id]: { output: { label } } } };
      const seen = new Set<string>();
      let at = edgeTo(s.id);
      while (at && !seen.has(at)) {
        seen.add(at);
        const step = byId.get(at);
        if (step?.type === "condition") {
          // The branch is only known when one side is this label and the other is a fixed value, whichever way round.
          const { left, right } = step.config.condition;
          const isLabel = (v: unknown) => typeof v === "string" && LABEL_REF.exec(v)?.[1] === s.id;
          const fixed = (v: unknown) => typeof v !== "string" || !v.includes("{{");
          if (!((isLabel(left) && (fixed(right) || isLabel(right))) || (isLabel(right) && fixed(left)))) break;
          const branch = safeBranch(step.config.condition, ctx);
          const next = branch && edgeTo(step.id, branch);
          if (!next) {
            warn("classify_dead_end", `Classify label "${label}" of "${s.id}" reaches condition "${step.id}" and takes its "${branch ?? "unknown"}" branch, which has no edge, so the run ends there.`);
            break;
          }
          at = next;
        } else if (step?.type === "switch") {
          if (LABEL_REF.exec(step.config.value)?.[1] !== s.id) break;
          const branch = switchBranch(step.config, ctx);
          const next = edgeTo(step.id, branch);
          if (!next) {
            warn("classify_dead_end", `Classify label "${label}" of "${s.id}" reaches switch "${step.id}" and takes its "${branch}" branch, which has no edge, so the run ends there.`);
            break;
          }
          at = next;
        } else {
          break;
        }
      }
    }
  }

  // Test runs already fake every outside call (decision 0028), so a switch for testing only changes real behaviour.
  const names = new Set<string>();
  for (const f of triggerFields(def.trigger) ?? []) if (SWITCH_NAME.test(f.name)) names.add(f.name);
  const checkTestRef = (text: string) => {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const name = /^trigger\.([a-z][a-z0-9_]*)$/.exec(m[1]!)?.[1];
      if (name && SWITCH_NAME.test(name)) names.add(name);
    }
  };
  for (const { cond } of conditions) {
    checkTestRef(cond.left);
    if (typeof cond.right === "string") checkTestRef(cond.right);
  }
  for (const s of def.steps) if (s.type === "switch") checkTestRef(s.config.value);
  for (const name of names) warn("test_switch", `"${name}" looks like a switch for testing. Mock test runs already send nothing, but a Live run or a real event follows the branch and can send, so remove it and its branch and test with Mock mode.`);

  // A number comparison on a value that may be missing or text needs an "invalid" edge, or bad data fails the run (decision 0027).
  const required = new Set((triggerFields(def.trigger) ?? []).filter((f) => f.type === "number" && f.required).map((f) => f.name));
  const certain = (side: Condition["right"]) =>
    typeof side === "number" || (typeof side === "string" && (side.includes("{{") ? required.has(TRIGGER_REF.exec(side)?.[1] ?? "") : Number.isFinite(toNumber(side))));
  const neverInvalid = ({ op, left, right }: Condition) => !NUMERIC_OPS.includes(op) || (certain(left) && certain(right));
  for (const { id, cond } of conditions) {
    if (NUMERIC_OPS.includes(cond.op) && !neverInvalid(cond) && !edgeTo(id, "invalid")) {
      warn("number_no_invalid", `Condition "${id}" compares numbers but has no "invalid" edge, so a missing or non-number value fails the run.`);
    }
  }

  // Walk from the entry step along edges that can be taken. An "invalid" edge of a check that cannot be invalid is dead.
  const never = new Set(conditions.filter(({ cond }) => neverInvalid(cond)).map(({ id }) => id));
  const reached = new Set<string>();
  const queue = [entryStep(def).id];
  while (queue.length) {
    const id = queue.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const e of def.edges) if (e.from === id && !(e.on === "invalid" && never.has(id))) queue.push(e.to);
  }
  for (const s of def.steps) {
    if (!reached.has(s.id)) warn("unreachable_step", `Step "${s.id}" can never run: only an "invalid" edge that cannot be taken leads to it.`);
  }

  return warnings;
}

function safeBranch(cond: Condition, ctx: Parameters<typeof conditionBranch>[1]): string | undefined {
  try {
    return conditionBranch(cond, ctx);
  } catch {
    return undefined;
  }
}
