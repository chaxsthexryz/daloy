import * as z from "zod";
import { aiConfigSchema } from "./ai";
import { FILES_PER_FIELD, type FileRef } from "./file-type";
import { isTimeZone, parseZoned } from "./zoned";

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

// A fixed wait, or until a time from the run (a datetime field) moved by offsetSeconds. A wake-up time that has
// passed takes the "late" edge, or ends the run when there is none (decision 0031).
export const delayConfigSchema = z
  .object({
    seconds: z.int().min(1).max(2_592_000).optional(),
    until: template(500)
      .min(1)
      .optional()
      .describe("A date and time with an offset, such as {{trigger.appointment_at}} from a datetime field. If it has passed when the step runs, the run ends here, or takes the step's late edge when it has one."),
    offsetSeconds: z.int().min(-2_592_000).max(2_592_000).optional().describe("Seconds after the until time; negative is before it, e.g. -3600 for an hour before."),
  })
  .superRefine((c, ctx) => {
    if ((c.seconds === undefined) === (c.until === undefined)) ctx.addIssue({ code: "custom", path: ["seconds"], message: "set either seconds or until" });
    if (c.offsetSeconds !== undefined && c.until === undefined) ctx.addIssue({ code: "custom", path: ["offsetSeconds"], message: "offsetSeconds needs until" });
  });
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

// Sheets and Slack go to the destination the owner picked in Apps (decision 0021). The worker queues them
// as deliveries, so the run carries on and each one is retried on its own. The row starts with the request reference
// and the time, then these columns. Keep private details out of Slack text: everyone in the channel can read it.
export const sheetsConfigSchema = z.object({ columns: z.array(template(2000)).min(1).max(20) });
export const slackConfigSchema = z.object({ text: template(3000).min(1) });
// Outlook mail is sent from the mailbox the owner consented with, and a Teams note goes to the channel their Teams
// workflow posts to (decision 0023). Both are queued deliveries too. A Teams note is a notification only: approvals
// are answered in Daloy by the named approver.
export const outlookConfigSchema = emailConfigSchema;
export const teamsConfigSchema = slackConfigSchema;
// A Telegram message goes to the one chat picked in Apps, as plain text (decision 0042). Queued like Slack.
export const telegramConfigSchema = slackConfigSchema;
// A calendar event for the run's booking, in the one calendar picked in Apps (decision 0044). It follows the booking: moved when it is rescheduled, deleted when it is cancelled.
export const calendarConfigSchema = z.object({ title: template(300).min(1), description: template(3000).optional() });
// A PayMongo checkout link for the amount in pesos (text, so a template works), sent on by a later step (decision 0045). Idempotent per run and step.
export const paymongoLinkConfigSchema = z.object({ amount: template(100).min(1), description: template(200).min(1), reference: template(200).min(1) });
// Airtable, Notion and Trello add one record, page or card to the target picked in Apps (decision 0046), queued like
// Sheets. Field and property names are the owner's literals; values are templates. Notion fields are text properties.
const fieldName = z.string().trim().min(1).max(100);
const fieldMap = z.record(fieldName, template(2000)).refine((f) => Object.keys(f).length <= 20, "at most 20 fields");
export const airtableConfigSchema = z.object({ fields: fieldMap.refine((f) => Object.keys(f).length >= 1, "add at least one field") });
export const notionConfigSchema = z.object({ title: template(2000).min(1), fields: fieldMap.default({}) });
export const trelloConfigSchema = z.object({ name: template(500).min(1), desc: template(10_000).optional() });
// link is the id of the paymongo_link step to check. The current status of its payment in this run: pending, paid, needs_review or refunded. Read-only, never calls PayMongo.
export const paymentStatusConfigSchema = z.object({ link: stepId });
// Saves the files a form collected into the Google Drive folder picked in Apps. It takes no settings: the files are
// the form's file fields. Queued like Sheets.
export const driveConfigSchema = z.object({}).default({});
export type SheetsConfig = z.infer<typeof sheetsConfigSchema>;
export type SlackConfig = z.infer<typeof slackConfigSchema>;

// A booking for a workspace resource (decision 0032). create needs resource, start and minutes; reschedule needs the
// booking reference and start (minutes optional, else kept); cancel needs the reference. start must be
// {{trigger.<datetime field>}} so the field's zone and slot rules apply to every booking.
export const bookingConfigSchema = z
  .object({
    action: z.enum(["create", "reschedule", "cancel"]),
    resource: template(500).min(1).optional().describe("The resource to book: a resource field such as {{trigger.therapist}}, or a resource id."),
    booking: template(500).min(1).optional().describe("The booking reference to change, such as {{trigger.reference}}."),
    start: template(500).min(1).optional().describe("A datetime field of the trigger, such as {{trigger.appointment_at}}."),
    minutes: z.int().min(1).max(1440).optional(),
  })
  .superRefine((c, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (c.action === "create") {
      if (c.resource === undefined || c.start === undefined || c.minutes === undefined) issue(c.resource === undefined ? "resource" : c.start === undefined ? "start" : "minutes", "a create needs resource, start and minutes");
      if (c.booking !== undefined) issue("booking", "a create makes a new booking, so it takes no booking reference");
    } else {
      if (c.resource !== undefined) issue("resource", "only a create picks the resource; a booking keeps its resource");
      if (c.action === "reschedule" && (c.booking === undefined || c.start === undefined)) issue(c.booking === undefined ? "booking" : "start", "a reschedule needs booking and start");
      if (c.action === "cancel" && c.booking === undefined) issue("booking", "a cancel needs the booking reference");
      if (c.action === "cancel" && (c.start !== undefined || c.minutes !== undefined)) issue(c.start !== undefined ? "start" : "minutes", "a cancel takes only the booking reference");
    }
  });
export type BookingConfig = z.infer<typeof bookingConfigSchema>;

const stepSchema = z.discriminatedUnion("type", [
  z.object({ id: stepId, type: z.literal("condition"), config: z.object({ condition: conditionSchema }) }),
  z.object({ id: stepId, type: z.literal("http"), config: httpConfigSchema }),
  z.object({ id: stepId, type: z.literal("email"), config: emailConfigSchema }),
  z.object({ id: stepId, type: z.literal("delay"), config: delayConfigSchema }),
  z.object({ id: stepId, type: z.literal("ai"), config: aiConfigSchema }),
  z.object({ id: stepId, type: z.literal("approval"), config: approvalConfigSchema }),
  z.object({ id: stepId, type: z.literal("sheets"), config: sheetsConfigSchema }),
  z.object({ id: stepId, type: z.literal("drive"), config: driveConfigSchema }),
  z.object({ id: stepId, type: z.literal("slack"), config: slackConfigSchema }),
  z.object({ id: stepId, type: z.literal("outlook"), config: outlookConfigSchema }),
  z.object({ id: stepId, type: z.literal("teams"), config: teamsConfigSchema }),
  z.object({ id: stepId, type: z.literal("telegram"), config: telegramConfigSchema }),
  z.object({ id: stepId, type: z.literal("calendar"), config: calendarConfigSchema }),
  z.object({ id: stepId, type: z.literal("airtable"), config: airtableConfigSchema }),
  z.object({ id: stepId, type: z.literal("notion"), config: notionConfigSchema }),
  z.object({ id: stepId, type: z.literal("trello"), config: trelloConfigSchema }),
  z.object({ id: stepId, type: z.literal("booking"), config: bookingConfigSchema }),
  z.object({ id: stepId, type: z.literal("paymongo_link"), config: paymongoLinkConfigSchema }),
  z.object({ id: stepId, type: z.literal("payment_status"), config: paymentStatusConfigSchema }),
]);
export type Step = z.infer<typeof stepSchema>;

/** Outgoing edge labels for steps that branch. Every other step has at most one unlabelled edge. */
// A condition's "invalid" edge is optional: without one, a comparison on a missing or non-number value fails the step.
export const BRANCHES: Partial<Record<Step["type"], readonly string[]>> = {
  condition: ["true", "false", "invalid"],
  approval: ["approved", "rejected", "timeout"],
  booking: ["done", "taken", "not_found"],
};

const edgeSchema = z.object({ from: stepId, to: stepId, on: z.string().max(32).optional() });

// Field names become keys of the trigger payload ({{trigger.<name>}}), so they use the same charset as step ids.
// min, max and integer limit a number field; the API checks them wherever a payload comes in (decision 0027).
export const formFieldSchema = z
  .object({
    name: stepId,
    label: z.string().min(1).max(200),
    type: z.enum(["text", "email", "textarea", "number", "datetime", "resource", "file"]),
    required: z.boolean().default(false),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
    // datetime: the IANA zone the time is read in, and an optional slot grid counted from local midnight (decision 0031).
    timezone: z.string().max(64).optional(),
    slotMinutes: z.int().min(1).max(1440).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "datetime" && f.timezone === undefined) ctx.addIssue({ code: "custom", path: ["timezone"], message: "a datetime field needs a timezone such as Asia/Manila" });
    if (f.type === "datetime" && f.timezone !== undefined && !isTimeZone(f.timezone)) ctx.addIssue({ code: "custom", path: ["timezone"], message: "use an IANA timezone name such as Asia/Manila" });
    if (f.type !== "datetime" && (f.timezone !== undefined || f.slotMinutes !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["type"], message: "timezone and slotMinutes are for datetime fields" });
    }
    if (f.type !== "number" && (f.min !== undefined || f.max !== undefined || f.integer !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["type"], message: "min, max and integer are for number fields" });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) ctx.addIssue({ code: "custom", path: ["max"], message: "max must not be below min" });
  });
export type FormField = z.infer<typeof formFieldSchema>;

const fieldList = z.array(formFieldSchema).min(1).max(30);

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual"), config: z.object({}).default({}) }),
  // The mailbox credential belongs to the installation's encrypted source row, never to a saved version.
  z.object({ type: z.literal("email"), config: z.strictObject({}).default({}) }),
  // hmacSecret names a stored secret; the API checks X-Daloy-Signature against it. fields, when set, are checked like a form's.
  // eventKey is a template such as {{trigger.event_id}}: a second event with the same key gets the first run (decision 0029).
  // requireTimestamp (N11b): refuse a call signed without X-Daloy-Timestamp. Off by default, so callers written before it keep working.
  z.object({ type: z.literal("webhook"), config: z.object({ hmacSecret: z.string().max(100).optional(), requireTimestamp: z.boolean().optional(), fields: fieldList.optional(), eventKey: z.string().min(1).max(500).optional() }).default({}) }),
  // pg-boss validates the expression fully when the schedule is saved.
  z.object({ type: z.literal("schedule"), config: z.object({ cron: z.string().regex(/^\S+( \S+){4,5}$/, "cron needs 5 or 6 fields") }) }),
  z.object({ type: z.literal("form"), config: z.object({ fields: fieldList }) }),
  // Starts a run when PayMongo reports a payment (paid by default). The run gets the payment as its trigger payload.
  z.object({ type: z.literal("payment"), config: z.object({ events: z.array(z.enum(["paid", "refunded"])).min(1).default(["paid"]) }).default({ events: ["paid"] }) }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

const TRIGGER_FIELD = /^\{\{\s*trigger\.([a-z][a-z0-9_]*)\s*\}\}$/;
/** The datetime field a booking step's start reads, or undefined when start is anything else (decision 0032). */
export function bookingStartField(trigger: Trigger, config: Pick<BookingConfig, "start">): FormField | undefined {
  const name = config.start === undefined ? undefined : TRIGGER_FIELD.exec(config.start)?.[1];
  return triggerFields(trigger)?.find((f) => f.name === name && f.type === "datetime");
}

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
export type Resource = { id: string; name: string };
/** resources: the workspace's active resources, the only ids a resource field accepts. now: for "in the future". */
/**
 * files: what the hosted form stored for each file field. Without it (a webhook, MCP, a test run, the Run button)
 * file fields are not part of the payload at all. With it, a file field's value is only ever what is listed here,
 * never what the client sent.
 */
export type PayloadContext = { resources?: Resource[]; now?: number; files?: Record<string, FileRef[]> };

export function payloadSchema(fields: FormField[], { resources = [], now, files }: PayloadContext = {}) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    if (f.type === "file") {
      if (!files) continue;
      const given = files[f.name] ?? [];
      const list = z.array(z.custom<FileRef>(), required("must be files")).max(FILES_PER_FIELD, `must be at most ${FILES_PER_FIELD} files`);
      shape[f.name] = z.preprocess(() => (given.length === 0 ? undefined : given), f.required ? list : list.optional());
      continue;
    }
    let base: z.ZodType;
    if (f.type === "datetime") {
      base = z.string(required("must be a date and time like 2027-01-20T14:00")).transform((v, ctx) => {
        const r = parseZoned(v.trim(), { timezone: f.timezone!, slotMinutes: f.slotMinutes }, now ?? Date.now());
        if (r.ok) return r.value;
        ctx.addIssue({ code: "custom", message: r.error });
        return z.NEVER;
      });
    } else if (f.type === "resource") {
      // The name is copied from the database row, so a later rename leaves this run's payload as it was.
      const choices = resources.map((r) => `${r.name} (${r.id})`).join(", ");
      base = z
        .string(required("must be a resource id"))
        .transform((v, ctx) => {
          const r = resources.find((x) => x.id === v.trim());
          if (r) return { id: r.id, name: r.name };
          ctx.addIssue({ code: "custom", message: "must be one of this workspace's resources" });
          return z.NEVER;
        })
        .describe(choices ? `A resource id: ${choices}` : "A resource id");
    } else if (f.type === "number") {
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
export function parsePayload(fields: FormField[], data: unknown, context?: PayloadContext): { ok: true; data: Record<string, unknown> } | { ok: false; errors: string[] } {
  // zod skips an absent key, so file fields get a key here and their preprocess reads context.files.
  const files = context?.files ? Object.fromEntries(fields.filter((f) => f.type === "file").map((f) => [f.name, null])) : {};
  const r = payloadSchema(fields, context).safeParse({ ...((data ?? {}) as Record<string, unknown>), ...files });
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
    if (def.trigger.type === "webhook" && def.trigger.config.fields?.some((f) => f.type === "file")) fail("file fields are for forms; a webhook cannot take files");
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
      if (s.type === "drive" && !(def.trigger.type === "form" && def.trigger.config.fields.some((f) => f.type === "file"))) fail(`drive step "${s.id}" needs a form trigger with at least one file field`);
      if (s.type === "ai") {
        const fileFields = def.trigger.type === "form" ? def.trigger.config.fields.filter((f) => f.type === "file").map((f) => f.name) : [];
        for (const name of s.config.files ?? []) if (!fileFields.includes(name)) fail(`ai step "${s.id}" reads "${name}", which is not a file field of the form`);
      }
      if (s.type === "payment_status" && !def.steps.some((o) => o.id === s.config.link && o.type === "paymongo_link")) fail(`payment_status step "${s.id}" needs link to be the id of a paymongo_link step`);
      if (s.type !== "booking") continue;
      if (s.config.start !== undefined && !bookingStartField(def.trigger, s.config)) fail(`booking step "${s.id}" needs start to be {{trigger.<field>}} for a datetime field of the trigger`);
      // Changing a booking is for staff (the Run button), MCP (its own tools) and signed webhooks, never a public form.
      const signed = def.trigger.type === "manual" || (def.trigger.type === "webhook" && def.trigger.config.hmacSecret !== undefined);
      if (s.config.action !== "create" && !signed) fail(`booking step "${s.id}" can reschedule or cancel only from a manual trigger or a webhook with a signing secret`);
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
      // A delay until a time may add a "late" edge next to its usual one (decision 0031).
      if (!labels && e.on === "late" && from.type === "delay") {
        if (from.config.until === undefined) fail(`only a delay with "until" can have a "late" edge, and "${from.id}" waits a fixed time`);
      } else if (!labels && e.on !== undefined) fail(`step "${from.id}" does not branch, so its edge cannot have a label`);

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
