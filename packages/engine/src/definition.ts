import * as z from "zod";

// Ids end up inside expression paths ({{steps.<id>.output}}), so keep them to a safe charset.
const stepId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "step ids use a-z, 0-9 and _, starting with a letter");

export const conditionSchema = z.object({
  left: z.string().max(1000),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists"]),
  right: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

// shortcut: per-type config is an open record until each step type lands (phases 4 and 7), then each gets its own schema.
const config = z.record(z.string(), z.unknown()).default({});

const stepSchema = z.discriminatedUnion("type", [
  z.object({ id: stepId, type: z.literal("condition"), config: z.object({ condition: conditionSchema }) }),
  z.object({ id: stepId, type: z.enum(["http", "email", "delay", "ai", "approval"]), config }),
]);
export type Step = z.infer<typeof stepSchema>;

/** Outgoing edge labels for steps that branch. Every other step has at most one unlabelled edge. */
export const BRANCHES: Partial<Record<Step["type"], readonly string[]>> = {
  condition: ["true", "false"],
  approval: ["approved", "rejected", "timeout"],
};

const edgeSchema = z.object({ from: stepId, to: stepId, on: z.string().max(32).optional() });

export const definitionSchema = z
  .object({
    trigger: z.object({ type: z.enum(["webhook", "schedule", "form", "manual"]), config }),
    steps: z.array(stepSchema).min(1).max(100),
    edges: z.array(edgeSchema).max(200).default([]),
  })
  .superRefine((def, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });

    const byId = new Map<string, Step>();
    for (const s of def.steps) {
      if (byId.has(s.id)) fail(`duplicate step id "${s.id}"`);
      byId.set(s.id, s);
    }

    for (const e of def.edges) {
      for (const id of [e.from, e.to]) if (!byId.has(id)) fail(`edge refers to unknown step "${id}"`);
    }
    // Graph checks below assume every edge points at a real step.
    if (def.edges.some((e) => !byId.has(e.from) || !byId.has(e.to))) return;

    const seen = new Set<string>();
    for (const e of def.edges) {
      const from = byId.get(e.from)!;
      const labels = BRANCHES[from.type];
      if (labels && e.on === undefined) fail(`edge from ${from.type} step "${from.id}" needs a branch label`);
      if (labels && e.on !== undefined && !labels.includes(e.on)) {
        fail(`"${e.on}" is not a branch of ${from.type} step "${from.id}"`);
      }
      if (!labels && e.on !== undefined) fail(`step "${from.id}" does not branch, so its edge cannot have a label`);

      const label = e.on ?? "next";
      const key = `${e.from}\u0000${label}`;
      if (seen.has(key)) fail(`step "${e.from}" has more than one "${label}" edge`);
      seen.add(key);
    }

    // Kahn's algorithm: if some steps never reach in-degree 0, there is a cycle.
    const inDegree = new Map(def.steps.map((s) => [s.id, 0]));
    for (const e of def.edges) inDegree.set(e.to, inDegree.get(e.to)! + 1);
    const roots = [...inDegree].filter(([, d]) => d === 0).map(([id]) => id);
    if (roots.length !== 1) fail(`a workflow needs exactly one entry step, found ${roots.length}`);

    const queue = [...roots];
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.pop()!;
      visited++;
      for (const e of def.edges) {
        if (e.from !== id) continue;
        const d = inDegree.get(e.to)! - 1;
        inDegree.set(e.to, d);
        if (d === 0) queue.push(e.to);
      }
    }
    if (visited !== def.steps.length) fail("the workflow contains a cycle");
  });

export type WorkflowDefinition = z.infer<typeof definitionSchema>;
