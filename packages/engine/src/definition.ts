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
  // Safe to send twice. Unset, GET, PUT and DELETE are; POST and PATCH are not (decision 0030).
  idempotent: z.boolean().optional(),
});

export const emailConfigSchema = z.object({
  // Comma-separated; the worker checks each address and the recipient cap after resolving the template.
  to: template(2000).min(1),
  subject: template(500).min(1),
  text: template(50_000).min(1),
});

export const delayConfigSchema = z.object({ seconds: z.int().min(1).max(2_592_000) });
export type HttpConfig = z.infer<typeof httpConfigSchema>;
export const isIdempotent = (cfg: Pick<HttpConfig, "method" | "idempotent">) => cfg.idempotent ?? ["GET", "PUT", "DELETE"].includes(cfg.method);
export type EmailConfig = z.infer<typeof emailConfigSchema>;

// The approver gets an email with a single-use link. timeoutSeconds later, an unanswered approval takes the timeout branch.
// With `approver` set, only that workspace member can decide, signed in, and the link goes to their sign-in email
// (decision 0022). Without it, `to` gets a link that whoever holds it can use (decision 0009). The approver is a plain
// email, not a template, so publishing can check that it names a member who may approve.
export const approvalConfigSchema = z
  .object({
    to: template(2000).min(1).optional(),
    approver: z.email().max(254).transform((s) => s.toLowerCase()).optional(),
    subject: template(500).min(1),
    message: template(10_000).min(1),
    timeoutSeconds: z.int().min(60).max(2_592_000),
  })
  .refine((c) => c.to !== undefined || c.approver !== undefined, { message: "set a recipient (to) or a named approver", path: ["to"] });
export type ApprovalConfig = z.infer<typeof approvalConfigSchema>;

// Sheets and Slack go to the destination the owner picked in Business and email (decision 0021). The worker queues them
// as deliveries, so the run carries on and each one is retried on its own. The row starts with the request reference
// and the time, then these columns. Keep private details out of Slack text: everyone in the channel can read it.
export const sheetsConfigSchema = z.object({ columns: z.array(template(2000)).min(1).max(20) });
export const slackConfigSchema = z.object({ text: template(3000).min(1) });
// Outlook mail is sent from the mailbox the owner consented with, and a Teams note goes to the channel their Teams
// workflow posts to (decision 0023). Both are queued deliveries too. A Teams note is a notification only: approvals
// are answered in Daloy by the named approver.
export const outlookConfigSchema = emailConfigSchema;
export const teamsConfigSchema = slackConfigSchema;
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
  z.object({ id: stepId, type: z.literal("outlook"), config: outlookConfigSchema }),
  z.object({ id: stepId, type: z.literal("teams"), config: teamsConfigSchema }),
]);
export type Step = z.infer<typeof stepSchema>;

/** Outgoing edge labels for steps that branch. Every other step has at most one unlabelled edge. */
// A condition's "invalid" edge is optional: without one, a comparison on a missing or non-number value fails the step.
export const BRANCHES: Partial<Record<Step["type"], readonly string[]>> = {
  condition: ["true", "false", "invalid"],
  approval: ["approved", "rejected", "timeout"],
};

const edgeSchema = z.object({ from: stepId, to: stepId, on: z.string().max(32).optional() });

// Field names become keys of the trigger payload ({{trigger.<name>}}), so they use the same charset as step ids.
// min, max and integer limit a number field; the API checks them wherever a payload comes in (decision 0027).
export const formFieldSchema = z
  .object({
    name: stepId,
    label: z.string().min(1).max(200),
    type: z.enum(["text", "email", "textarea", "number"]),
    required: z.boolean().default(false),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type !== "number" && (f.min !== undefined || f.max !== undefined || f.integer !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["type"], message: "min, max and integer are for number fields" });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) ctx.addIssue({ code: "custom", path: ["max"], message: "max must not be below min" });
  });
export type FormField = z.infer<typeof formFieldSchema>;

const fieldList = z.array(formFieldSchema).min(1).max(30);

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual"), config: z.object({}).default({}) }),
  // hmacSecret names a stored secret; the API checks X-Daloy-Signature against it. fields, when set, are checked like a form's.
  // eventKey is a template such as {{trigger.event_id}}: a second event with the same key gets the first run (decision 0029).
  z.object({ type: z.literal("webhook"), config: z.object({ hmacSecret: z.string().max(100).optional(), fields: fieldList.optional(), eventKey: z.string().min(1).max(500).optional() }).default({}) }),
  // pg-boss validates the expression fully when the schedule is saved.
  z.object({ type: z.literal("schedule"), config: z.object({ cron: z.string().regex(/^\S+( \S+){4,5}$/, "cron needs 5 or 6 fields") }) }),
  z.object({ type: z.literal("form"), config: z.object({ fields: fieldList }) }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

/** The fields a trigger's payload is checked against: a form's, or a webhook's when it lists any. */
export const triggerFields = (t: Trigger): FormField[] | undefined => (t.type === "form" || t.type === "webhook" ? t.config.fields : undefined);

// Plain decimal text only, so "45,000", "0x10" and "Infinity" are refused instead of read as some other number.
const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const notGiven = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const required = (fallback: string) => ({ error: (iss: { input: unknown }) => (iss.input === undefined ? "is required" : fallback) });

/**
 * The schema a submission must pass: from the public form, a test run, the console Run button, MCP, or a webhook with
 * fields. Empty text and null count as not given. Keys that are not fields are dropped.
 */
export function payloadSchema(fields: FormField[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    let base: z.ZodType;
    if (f.type === "number") {
      let n = z.number(required("must be a number"));
      if (f.min !== undefined) n = n.min(f.min, `must be at least ${f.min}`);
      if (f.max !== undefined) n = n.max(f.max, `must be at most ${f.max}`);
      if (f.integer) n = n.int("must be a whole number");
      base = n;
    } else if (f.type === "email") {
      base = z.email(required("must be an email address")).max(254, "must be at most 254 characters");
    } else {
      const max = f.type === "textarea" ? 5000 : 500;
      base = z.string(required("must be text")).trim().max(max, `must be at most ${max} characters`);
    }
    const read = (v: unknown) => (notGiven(v) ? undefined : f.type === "number" && typeof v === "string" && NUMBER_TEXT.test(v.trim()) ? Number(v) : typeof v === "string" && f.type === "email" ? v.trim() : v);
    shape[f.name] = z.preprocess(read, f.required ? base : base.optional());
  }
  return z.object(shape);
}

/** Checks a payload against its fields. Errors read "<field>: <problem>", one per field, in field order. */
export function parsePayload(fields: FormField[], data: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; errors: string[] } {
  const r = payloadSchema(fields).safeParse(data ?? {});
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`) };
}

export const definitionSchema = z
  .object({
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1).max(100),
    edges: z.array(edgeSchema).max(200).default([]),
  })
  .superRefine((def, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });

    const fields = triggerFields(def.trigger);
    if (fields) {
      const names = new Set<string>();
      for (const f of fields) {
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
