import * as z from "zod";
import { aiConfigSchema } from "./ai";

// Ids end up inside expression paths ({{steps.<id>.output}}), so keep them to a safe charset.
const stepId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "step ids use a-z, 0-9 and _, starting with a letter");

export const conditionSchema = z.object({
  left: z.string().max(1000),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists"]),
  right: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

// String fields are templates: {{trigger...}}, {{steps...}} and {{secrets...}} are resolved when the step runs.
const template = (max: number) => z.string().max(max);

export const httpConfigSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: template(2000).min(1),
  headers: z
    .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "header names use letters, digits and -"), template(2000))
    .refine((h) => Object.keys(h).length <= 20, "at most 20 headers")
    .default({}),
  body: template(100_000).optional(),
});

export const emailConfigSchema = z.object({
  // Comma-separated; the worker checks each address and the recipient cap after resolving the template.
  to: template(2000).min(1),
  subject: template(500).min(1),
  text: template(50_000).min(1),
});

export const delayConfigSchema = z.object({ seconds: z.int().min(1).max(2_592_000) });
export type HttpConfig = z.infer<typeof httpConfigSchema>;
export type EmailConfig = z.infer<typeof emailConfigSchema>;

// The approver gets an email with a single-use link. timeoutSeconds later, an unanswered approval takes the timeout branch.
export const approvalConfigSchema = z.object({
  to: template(2000).min(1),
  subject: template(500).min(1),
  message: template(10_000).min(1),
  timeoutSeconds: z.int().min(60).max(2_592_000),
});
export type ApprovalConfig = z.infer<typeof approvalConfigSchema>;

// Sheets and Slack go to the destination the owner picked in Business and email (decision 0021). The worker queues them
// as deliveries, so the run carries on and each one is retried on its own. The row starts with the request reference
// and the time, then these columns. Keep private details out of Slack text: everyone in the channel can read it.
export const sheetsConfigSchema = z.object({ columns: z.array(template(2000)).min(1).max(20) });
export const slackConfigSchema = z.object({ text: template(3000).min(1) });
export type SheetsConfig = z.infer<typeof sheetsConfigSchema>;
export type SlackConfig = z.infer<typeof slackConfigSchema>;

const stepSchema = z.discriminatedUnion("type", [
  z.object({ id: stepId, type: z.literal("condition"), config: z.object({ condition: conditionSchema }) }),
  z.object({ id: stepId, type: z.literal("http"), config: httpConfigSchema }),
  z.object({ id: stepId, type: z.literal("email"), config: emailConfigSchema }),
  z.object({ id: stepId, type: z.literal("delay"), config: delayConfigSchema }),
  z.object({ id: stepId, type: z.literal("ai"), config: aiConfigSchema }),
  z.object({ id: stepId, type: z.literal("approval"), config: approvalConfigSchema }),
  z.object({ id: stepId, type: z.literal("sheets"), config: sheetsConfigSchema }),
  z.object({ id: stepId, type: z.literal("slack"), config: slackConfigSchema }),
]);
export type Step = z.infer<typeof stepSchema>;

/** Outgoing edge labels for steps that branch. Every other step has at most one unlabelled edge. */
export const BRANCHES: Partial<Record<Step["type"], readonly string[]>> = {
  condition: ["true", "false"],
  approval: ["approved", "rejected", "timeout"],
};

const edgeSchema = z.object({ from: stepId, to: stepId, on: z.string().max(32).optional() });

// Field names become keys of the trigger payload ({{trigger.<name>}}), so they use the same charset as step ids.
export const formFieldSchema = z.object({
  name: stepId,
  label: z.string().min(1).max(200),
  type: z.enum(["text", "email", "textarea", "number"]),
  required: z.boolean().default(false),
});
export type FormField = z.infer<typeof formFieldSchema>;

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual"), config: z.object({}).default({}) }),
  // hmacSecret names a stored secret; the API checks X-Daloy-Signature against it.
  z.object({ type: z.literal("webhook"), config: z.object({ hmacSecret: z.string().max(100).optional() }).default({}) }),
  // pg-boss validates the expression fully when the schedule is saved.
  z.object({ type: z.literal("schedule"), config: z.object({ cron: z.string().regex(/^\S+( \S+){4,5}$/, "cron needs 5 or 6 fields") }) }),
  z.object({ type: z.literal("form"), config: z.object({ fields: z.array(formFieldSchema).min(1).max(30) }) }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

export const definitionSchema = z
  .object({
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1).max(100),
    edges: z.array(edgeSchema).max(200).default([]),
  })
  .superRefine((def, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });

    if (def.trigger.type === "form") {
      const names = new Set<string>();
      for (const f of def.trigger.config.fields) {
        if (names.has(f.name)) fail(`duplicate form field "${f.name}"`);
        names.add(f.name);
      }
    }

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
