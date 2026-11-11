import { BRANCHES, type Step, type WorkflowDefinition } from "./definition";

/** The step with no incoming edge. definitionSchema guarantees there is exactly one. */
export function entryStep(def: WorkflowDefinition): Step {
  const targets = new Set(def.edges.map((e) => e.to));
  return def.steps.find((s) => !targets.has(s.id))!;
}

/** The step that runs after `fromId`, or undefined when the flow ends there. Branching steps must say which branch they took. */
export function nextStep(def: WorkflowDefinition, fromId: string, branch?: string): Step | undefined {
  const from = def.steps.find((s) => s.id === fromId);
  if (!from) throw new Error(`unknown step "${fromId}"`);
  if (BRANCHES[from.type] && branch === undefined) throw new Error(`${from.type} step "${fromId}" needs a branch`);
  const edge = def.edges.find((e) => e.from === fromId && e.on === branch);
  return edge && def.steps.find((s) => s.id === edge.to);
}
