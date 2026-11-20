import { randomUUID } from "node:crypto";
import { workspaceLanguage, aiConnection, bookFromStep, checkReceiptReference, checkRecipients, claimTimeout, claimUsage, createApproval, findPaymentForStep, findApprover, queueCalendarEvent, queueDelivery, readSecrets, redactSecrets, secretForms, sendAs, type Db, type MailDeps, type Provider } from "@daloy/db";
import { approvalEmailBody, type FileRef, bookingStartField, conditionBranch, normalizePhMobile, parseZoned, SMS_MAX_CHARS, type TestChoice, type Trigger, declaresJson, parseInstant, isRetryable, mockAiOutput, parseJsonTemplate, resolveJsonTemplate, resolveTemplate, StepError, usesSecrets, type ExpressionContext, type Step } from "@daloy/engine";
import type { StepExecutor, StepResult } from "../advance";
import { runAi } from "./ai";
import { loadAiFiles } from "./ai-files";
import { httpRequest } from "./http";
import { paymongoLink } from "./paymongo";
import { defaultGuard, type SsrfGuard } from "./ssrf";

/**
 * publicUrl (PUBLIC_URL) is where the API is reachable, for approval links. The AI model comes from the owner's settings
 * or the LLM_* env vars. Mail goes out as the owner: their Gmail, or the installation server when they connected none.
 */
export type ExecutorDeps = { db: Db; secretsKey: Buffer; mail: MailDeps; guard?: SsrfGuard; publicUrl?: string };
type FullDeps = ExecutorDeps & { guard: SsrfGuard; publicUrl: string };

// Config fields are templates that must end up as text, even when a placeholder resolves to a number or object.
function text(template: string, ctx: ExpressionContext): string {
  const v = resolveTemplate(template, ctx);
  return v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * A body that parses as a JSON template is filled value by value and serialised once, so form data cannot break it or
 * add keys (decision 0025). A request that says it sends JSON must have such a body. Anything else stays plain text.
 */
function body(template: string, headers: Record<string, string>, ctx: ExpressionContext): string {
  const parsed = parseJsonTemplate(template);
  if (parsed.ok) return resolveJsonTemplate(parsed, ctx);
  if (declaresJson(headers)) throw new StepError(`The request body is not valid JSON (${parsed.error}). Write placeholders as values, e.g. "{{trigger.amount}}" or {{trigger.amount}}.`, false);
  return text(template, ctx);
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

type HttpInput = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers: Record<string, string>; body?: string; idempotent?: boolean };
type EmailInput = { to: string; subject: string; text: string };
type AiInput = { input: string };
type ApprovalInput = { to?: string; approver?: string; subject: string; message: string; timeoutSeconds: number };
type SheetsInput = { columns: string[] };
type SlackInput = { text: string };
type SmsInput = { to: string; message: string; senderId?: string };
type CalendarInput = { title: string; description: string };
type MetaReplyInput = { recipientId: string; channel?: string; text: string };
type RecordInput = { fields?: Record<string, string>; title?: string; name?: string; desc?: string };

/**
 * The config a step runs with, its templates resolved. The executor stores it (redacted) on the step run,
 * so run history shows what was actually sent and not the template.
 */
function resolveInput(step: Step, ctx: ExpressionContext): Record<string, unknown> | null {
  switch (step.type) {
    case "condition": {
      const { left, op, right } = step.config.condition;
      return { left: resolveTemplate(left, ctx), op, right: typeof right === "string" ? resolveTemplate(right, ctx) : right };
    }
    case "delay": {
      const { seconds, until, offsetSeconds } = step.config;
      return until === undefined ? { seconds } : { until: text(until, ctx), ...(offsetSeconds === undefined ? {} : { offsetSeconds }) };
    }
    case "http": {
      const { method, url, headers } = step.config;
      const input: HttpInput = { method, url: text(url, ctx), headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, text(v, ctx)])) };
      if (step.config.body !== undefined) input.body = body(step.config.body, headers, ctx);
      if (step.config.idempotent !== undefined) input.idempotent = step.config.idempotent;
      return input;
    }
    case "email":
    case "outlook": {
      const { to, subject, text: body } = step.config;
      return { to: text(to, ctx), subject: text(subject, ctx), text: text(body, ctx) } satisfies EmailInput;
    }
    case "ai":
      // Only input is a template; labels, fields and instructions are literals (decision 0010).
      return { ...step.config, input: text(step.config.input, ctx) };
    case "approval": {
      const { to, approver, subject, message, timeoutSeconds } = step.config;
      // The link is not part of the input, so the token never reaches the database or run history.
      const who = approver ? { approver } : { to: text(to!, ctx) };
      return { ...who, subject: text(subject, ctx), message: text(message, ctx), timeoutSeconds } satisfies ApprovalInput;
    }
    case "sheets":
      return { columns: step.config.columns.map((c) => text(c, ctx)) } satisfies SheetsInput;
    case "drive":
      return {};
    case "slack":
    case "teams":
    case "telegram":
      return { text: text(step.config.text, ctx) } satisfies SlackInput;
    case "sms": {
      const { to, message, senderId } = step.config;
      return { to: text(to, ctx), message: text(message, ctx), ...(senderId ? { senderId } : {}) } satisfies SmsInput;
    }
    case "meta_reply":
      return { recipientId: text(step.config.recipientId, ctx), channel: text(step.config.channel, ctx), text: text(step.config.text, ctx) } satisfies MetaReplyInput;
    case "calendar":
      return { title: text(step.config.title, ctx), description: step.config.description === undefined ? "" : text(step.config.description, ctx) } satisfies CalendarInput;
    case "payment_status":
      return { link: step.config.link };
    case "paymongo_link": {
      const { amount, description, reference } = step.config;
      return { amount: text(amount, ctx), description: text(description, ctx), reference: text(reference, ctx) };
    }
    case "airtable":
    case "notion":
    case "trello": {
      // Field and property names are the owner's literals; only values are templates.
      const c = step.config as { fields?: Record<string, string>; title?: string; name?: string; desc?: string };
      return {
        ...(c.fields && { fields: Object.fromEntries(Object.entries(c.fields).map(([k, v]) => [k, text(v, ctx)])) }),
        ...(c.title !== undefined && { title: text(c.title, ctx) }),
        ...(c.name !== undefined && { name: text(c.name, ctx) }),
        ...(c.desc !== undefined && { desc: text(c.desc, ctx) }),
      } satisfies RecordInput;
    }
    case "booking": {
      const { action, resource, booking, start, minutes } = step.config;
      // A resource field stores { id, name }; the step books by id.
      const r = resource === undefined ? undefined : resolveTemplate(resource, ctx);
      const resourceId = r !== null && typeof r === "object" && typeof (r as { id?: unknown }).id === "string" ? (r as { id: string }).id : r === undefined ? undefined : text(resource!, ctx);
      return { action, ...(resourceId !== undefined && { resource: resourceId }), ...(booking !== undefined && { booking: text(booking, ctx) }), ...(start !== undefined && { start: text(start, ctx) }), ...(minutes !== undefined && { minutes }) } satisfies BookingInput;
    }
  }
}

type BookingInput = { action: "create" | "reschedule" | "cancel"; resource?: string; booking?: string; start?: string; minutes?: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Attempt = { runId: string; idempotencyKey: string; attempt: number; stepRunId: string; userId: string; workflowId?: string; mock: boolean; test?: boolean; aiLive?: boolean; choice?: TestChoice; claimSend?: () => Promise<() => void>; booking?: { test: boolean; workflowId: string; trigger: Trigger }; fileFields?: string[] };

async function runStep(deps: FullDeps, step: Step, input: unknown, ctx: ExpressionContext, { runId, idempotencyKey, attempt, stepRunId, userId, workflowId, mock, test, aiLive, choice, claimSend, booking, fileFields }: Attempt): Promise<StepResult> {
  // The API only accepts a fail choice on a step a faked run fakes (choiceProblems).
  // "unknown" fails only the first attempt, so Send again in review shows the step going through. Nothing is sent.
  if (mock && choice && "fail" in choice && (choice.fail !== "unknown" || attempt === 1)) {
    throw new StepError(`Test run: this step was set to fail (${choice.fail}).`, choice.fail === "retryable", choice.fail === "unknown" ? { outcome: "unknown" } : {});
  }
  // Counted right before the outside call, under the step key, so a retried attempt is not counted twice. A QuotaError
  // is not retryable and not sent, so the run fails with its plain message.
  const claim = (kind: "ai" | "email" | "http" | "mailbox", n = 1) => claimUsage(deps.db, userId, kind, { n, key: idempotencyKey });
  switch (step.type) {
    case "condition":
      return { branch: conditionBranch(step.config.condition, ctx) };
    case "booking": {
      const cfg = input as BookingInput;
      // A faked test run can take another branch without touching any booking (decision 0032).
      if (choice && "booking" in choice) return { branch: choice.booking, output: { mocked: true, reason: `Test run: this step was set to ${choice.booking}.` } };
      if (!booking) throw new StepError("A booking step needs its run's details.", false);
      let start: Date | undefined;
      if (cfg.start !== undefined) {
        // The datetime field's own zone, slot and future rules, again at the moment of booking, whatever the data path.
        const field = bookingStartField(booking.trigger, step.config);
        const r = field ? parseZoned(cfg.start.trim(), { timezone: field.timezone!, slotMinutes: field.slotMinutes }) : { ok: false as const, error: "needs a datetime field of the trigger" };
        if (!r.ok) throw new StepError(`"start" ${r.error}, but got ${JSON.stringify(cfg.start)}`, false);
        start = r.at;
      }
      const at = { workspaceId: userId, test: booking.test, runId, stepId: step.id, workflowId: booking.workflowId };
      const found = (reason: string) => ({ branch: "not_found", output: { reason } });
      let r;
      if (cfg.action === "create") {
        if (!UUID.test(cfg.resource ?? "")) return found("There is no active resource with that id in this workspace.");
        const field = bookingStartField(booking.trigger, step.config)!;
        r = await bookFromStep(deps.db, at, { action: "create", resourceId: cfg.resource!, start: start!, minutes: cfg.minutes!, timezone: field.timezone! });
      } else if (!cfg.booking?.trim()) return found("No booking reference was given.");
      else r = await bookFromStep(deps.db, at, cfg.action === "cancel" ? { action: "cancel", reference: cfg.booking.trim() } : { action: "reschedule", reference: cfg.booking.trim(), start: start!, minutes: cfg.minutes });
      return { branch: r.branch, output: r.output };
    }
    case "calendar": {
      const cfg = input as CalendarInput;
      // A test run, and a booking made by one, never reach a real calendar.
      if (mock || booking?.test) return { output: { mocked: true, ...cfg } };
      // Queued, not sent: the worker syncs it apart from the run, and later booking changes keep it in line (decision 0044).
      const d = await queueCalendarEvent(deps.db, { userId, runId, stepId: step.id, ...cfg });
      if (!d) throw new StepError("A calendar step needs a booking step before it in the same run.", false);
      return { output: { deliveryId: d.id, reference: d.reference, state: d.state } };
    }
    case "delay": {
      const cfg = input as { seconds?: number; until?: string; offsetSeconds?: number };
      let resumeAt: Date;
      if (cfg.until === undefined) resumeAt = new Date(Date.now() + cfg.seconds! * 1000);
      else {
        const at = parseInstant(cfg.until);
        if (!at) throw new StepError(`"until" needs a date and time with an offset, like 2030-01-20T14:00:00+08:00, but got ${JSON.stringify(cfg.until)}`, false);
        resumeAt = new Date(at.getTime() + (cfg.offsetSeconds ?? 0) * 1000);
        // Already past: the advance step ends the run here unless the delay has a "late" edge (decision 0031).
        if (resumeAt.getTime() <= Date.now()) return { branch: "late", output: { resumeAt: resumeAt.toISOString(), late: true } };
      }
      // A mocked test run waits at most one second, so the builder shows the result straight away, but it reports
      // the wake-up time a live run would have.
      if (mock) return { output: { resumeAt: resumeAt.toISOString(), mocked: true }, waitUntil: new Date(Math.min(resumeAt.getTime(), Date.now() + 1000)) };
      return { output: { resumeAt: resumeAt.toISOString() }, waitUntil: resumeAt };
    }
    case "http": {
      const cfg = input as HttpInput;
      // Same shape as a real response, so later steps that read {{steps.x.output.body}} still resolve.
      if (mock) return { output: { mocked: true, status: 200, headers: {}, body: null, request: { method: cfg.method, url: cfg.url } } };
      await claim("http");
      return { output: await httpRequest(cfg, idempotencyKey, { guard: deps.guard, claim: claimSend }) };
    }
    case "email": {
      const mail = input as EmailInput;
      if (mock) return { output: { mocked: true, to: mail.to, subject: mail.subject } };
      await claim("email", checkRecipients(mail.to).length);
      // The Message-ID stays per attempt; the step key is the same on every attempt.
      // An email may not be sent twice on its own: sendAs claims the send once the sender is known.
      const sent = await sendAs(deps.db, deps.secretsKey, deps.mail, userId, mail, `${idempotencyKey}:${attempt}`, { claim: claimSend, capKey: idempotencyKey });
      return { output: { messageId: sent.messageId, to: sent.to, from: sent.from } };
    }
    case "ai": {
      if (mock && choice && "label" in choice) return { output: { label: choice.label } };
      if (mock && !aiLive) return { output: mockAiOutput(step.config) };
      // The model the workflow owner picked in the console, or the env vars if they picked none.
      const { model, imageTypes, ...connection } = await aiConnection(deps.db, deps.secretsKey, userId);
      const trigger = (ctx.trigger ?? {}) as Record<string, unknown>;
      const refs = (fileFields ?? []).flatMap((name) => (Array.isArray(trigger[name]) ? (trigger[name] as FileRef[]) : []));
      const files = refs.length ? await loadAiFiles(deps.db, { userId, runId, refs, imageTypes }) : undefined;
      // Each file is one more AI action. The claim key is the step key, so a retry is not counted twice; the checks
      // and the PDF reading happen before, so a refused file costs nothing.
      await claim("ai", 1 + refs.length);
      const aiRes = await runAi(step.config, (input as AiInput).input, { connection, model, attempt, files });
      if (step.config.task === "extract" && refs.length > 0 && aiRes.output && typeof aiRes.output === "object") {
        const out = aiRes.output as Record<string, unknown>;
        const hasIsReceiptField = "is_receipt" in (step.config.fields ?? {}) || "is_receipt" in ((step.config as { schema?: Record<string, unknown> }).schema ?? {});
        if (typeof out.reference === "string" && (out.is_receipt === "yes" || (hasIsReceiptField && out.is_receipt !== "no"))) {
          const flag = await checkReceiptReference(deps.db, {
            userId,
            runId,
            provider: typeof out.provider === "string" ? out.provider : null,
            reference: out.reference,
            test: test || mock || booking?.test,
          });
          return {
            ...aiRes,
            output: {
              ...out,
              duplicate_reference: flag.duplicate ? "yes" : "no",
              duplicate_warning: flag.warning,
              ...(flag.duplicate && flag.firstRunId ? { previous_run_id: flag.firstRunId } : {}),
            },
          };
        }
      }
      return aiRes;
    }
    case "approval": {
      // A mocked test run decides straight away (approved unless the tester chose otherwise), without an email.
      if (mock) {
        const decision = choice && "decision" in choice ? choice.decision : "approved";
        return { output: { mocked: true, decision }, branch: decision };
      }
      const cfg = input as ApprovalInput;
      // A named approver must still be a member who may approve; the API checks again when they answer (decision 0022).
      const approver = cfg.approver ? await findApprover(deps.db, userId, cfg.approver) : null;
      if (cfg.approver && !approver) throw new StepError(`The approver ${cfg.approver} is not a member of this workspace who can approve.`, false);
      // Each recipient counts, once per step key: a retry sends a new link under the same key.
      const to = approver?.email ?? cfg.to!;
      await claim("email", checkRecipients(to).length);
      const created = await createApproval(deps.db, stepRunId, new Date(Date.now() + cfg.timeoutSeconds * 1000), approver?.id);
      if (!created) {
        // A retry or re-run, and the approver already answered an earlier link: take that answer, ask nobody again.
        const { branch, decidedBy, decidedAt } = await deps.db.transaction((tx) => claimTimeout(tx, stepRunId));
        if (branch === null) throw new StepError("approval has no recorded decision", true);
        return { output: { decision: branch, ...(decidedBy ? { decidedBy, decidedAt } : {}) }, branch };
      }
      // A retry's link keeps the first link's deadline (decision 0009).
      const { token, expiresAt } = created;
      const link = `${deps.publicUrl}/approvals/${token}`;
      const language = await workspaceLanguage(deps.db, userId);
      const body = approvalEmailBody(cfg.message, link, expiresAt.toISOString(), approver?.email, language);
      // A retry or re-run sends a new link (earlier ones still work), so it needs its own Message-ID, or a mail server
      // could drop it as a duplicate of the earlier message.
      await sendAs(deps.db, deps.secretsKey, deps.mail, userId, { to, subject: cfg.subject, text: body }, `${idempotencyKey}:${randomUUID().slice(0, 8)}`, { capKey: idempotencyKey }).catch((err: unknown) => {
        // Each attempt sends its own working link and decisions carry across attempts, so a link email that may have
        // arrived is safe to send again: retry it instead of asking for review.
        throw err instanceof StepError && err.outcome === "unknown" ? new StepError(err.message, true, { cause: err, outcome: "unknown" }) : err;
      });
      // The run waits until the timeout; recording a decision wakes it earlier (decision 0009).
      return { output: { expiresAt: expiresAt.toISOString() }, waitUntil: expiresAt };
    }
    case "drive": {
      // The files a hosted form stored for this run: the values of the definition's file fields, never client-supplied text.
      const trigger = (ctx.trigger ?? {}) as Record<string, unknown>;
      const files = (fileFields ?? []).flatMap((name) => (Array.isArray(trigger[name]) ? (trigger[name] as FileRef[]) : []));
      if (mock) return { output: { mocked: true, files: files.length } };
      if (files.length === 0) return { output: { files: 0 } };
      const ref = trigger.reference;
      const reference = typeof ref === "string" ? ref : runId;
      const d = await queueDelivery(deps.db, { userId, runId, stepId: step.id, provider: "google_drive", reference, payload: { files } });
      return { output: { deliveryId: d.id, reference, state: d.state, files: files.length } };
    }
    case "sms": {
      const cfg = input as SmsInput;
      const phone = normalizePhMobile(cfg.to);
      if (!phone.ok) throw new StepError(phone.error, false);
      const message = cfg.message.trim();
      if (!message) throw new StepError("SMS message cannot be empty.", false);
      if (message.length > SMS_MAX_CHARS) throw new StepError(`SMS message is ${message.length} characters, above the ${SMS_MAX_CHARS}-character limit.`, false);
      const ref = (ctx.trigger as { reference?: unknown } | null)?.reference;
      const reference = typeof ref === "string" ? ref : runId;
      const payload = { to: phone.value, message, ...(cfg.senderId ? { senderId: cfg.senderId } : {}) };
      if (mock) return { output: { mocked: true, reference, ...payload } };
      const d = await queueDelivery(deps.db, { userId, runId, stepId: step.id, provider: "unisms", reference, payload });
      return { output: { deliveryId: d.id, reference, to: phone.value, state: d.state } };
    }
    case "sheets":
    case "slack":
    case "outlook":
    case "teams":
    case "telegram":
    case "airtable":
    case "notion":
    case "trello": {
      // The request reference when the run came from a guided form, else the run id, so every row and message can be traced.
      const ref = (ctx.trigger as { reference?: unknown } | null)?.reference;
      const reference = typeof ref === "string" ? ref : runId;
      const payload =
        step.type === "sheets"
          ? { row: [reference, new Date().toISOString(), ...(input as SheetsInput).columns] }
          : step.type === "outlook"
            ? { ...(input as EmailInput), to: checkRecipients((input as EmailInput).to).join(",") }
            : step.type === "airtable" || step.type === "notion" || step.type === "trello"
              ? (input as RecordInput)
              : { text: (input as SlackInput).text };
      if (mock) return { output: { mocked: true, reference, ...payload } };
      if (step.type === "outlook") {
        const n = (payload as { to: string }).to.split(",").length;
        await claim("email", n);
        await claim("mailbox", n);
      }
      // Queued, not sent: the worker delivers it apart from the run, so one provider's trouble never holds up the other
      // (decision 0021). A re-run of this step gets the first delivery back, with its original payload.
      const provider: Provider = step.type === "sheets" ? "google_sheets" : step.type;
      const d = await queueDelivery(deps.db, { userId, runId, stepId: step.id, provider, reference, payload });
      return { output: { deliveryId: d.id, reference, state: d.state } };
    }
    case "meta_reply": {
      const cfg = input as MetaReplyInput;
      const recipientId = cfg.recipientId.trim();
      const body = cfg.text.trim();
      const channel = cfg.channel?.trim() || undefined;
      if (!recipientId) throw new StepError("Meta reply needs a recipient id.", false);
      if (!body) throw new StepError("Meta reply message cannot be empty.", false);
      if (body.length > 2000) throw new StepError("Meta reply message can be at most 2,000 characters.", false);
      const trig = (ctx.trigger ?? {}) as Record<string, unknown>;
      if (typeof trig.senderId === "string" && trig.senderId.trim() && recipientId !== trig.senderId.trim()) {
        throw new StepError("Meta reply recipient must match the incoming message sender.", false);
      }
      if (channel && typeof trig.channel === "string" && trig.channel.trim() && channel !== trig.channel.trim()) {
        throw new StepError("Meta reply channel must match the incoming message channel.", false);
      }
      if (mock) return { output: { mocked: true, recipientId: cfg.recipientId, channel: cfg.channel, text: cfg.text } };
      const ref = trig.reference ?? trig.messageId;
      const reference = typeof ref === "string" ? ref : runId;
      const inboundTimestamp = typeof trig.timestamp === "string" && trig.timestamp.trim() ? trig.timestamp.trim() : undefined;
      const receivingPageId = typeof trig.pageId === "string" && trig.pageId.trim() ? trig.pageId.trim() : undefined;
      const receivingInstagramAccountId = typeof trig.instagramAccountId === "string" && trig.instagramAccountId.trim() ? trig.instagramAccountId.trim() : undefined;
      const d = await queueDelivery(deps.db, {
        userId,
        runId,
        stepId: step.id,
        provider: "meta_messenger",
        reference,
        payload: {
          recipientId,
          ...(channel ? { channel } : {}),
          text: body,
          ...(inboundTimestamp ? { inboundTimestamp } : {}),
          ...(receivingPageId ? { receivingPageId } : {}),
          ...(receivingInstagramAccountId ? { receivingInstagramAccountId } : {}),
        },
      });
      return { output: { deliveryId: d.id, reference, state: d.state, recipientId } };
    }
    case "payment_status": {
      const cfg = input as { link: string };
      if (mock) return { output: { mocked: true, status: "pending", paid: false } };
      const p = await findPaymentForStep(deps.db, runId, cfg.link);
      if (!p) throw new StepError(`Step ${cfg.link} made no payment link in this run.`, false);
      return { output: { status: p.status, paid: p.status === "paid", reference: p.reference, amount: p.amountCentavos, url: p.url } };
    }
    case "paymongo_link": {
      const cfg = input as { amount: string; description: string; reference: string };
      if (mock) return { output: { mocked: true, reference: cfg.reference, amount: cfg.amount } };
      // Counted under the step key, like an HTTP call, and only once PayMongo is really going to be called.
      return { output: await paymongoLink(deps.db, deps.secretsKey, { userId, workflowId: workflowId!, runId, stepId: step.id, idempotencyKey }, cfg, () => claim("http")) };
    }
  }
}

/**
 * Runs real steps. The owner's secrets are decrypted for this attempt only and given to HTTP steps alone (decision 0025).
 * What is stored is a preview resolved with every secret as the literal [secret], never the request that went out, so
 * no encoding of a secret can reach run history through the input. Outputs and errors come from outside, so every
 * form of every secret value is replaced with [secret] in them before anything is written to the database.
 */
export function createExecutor(deps: ExecutorDeps): StepExecutor {
  const full: FullDeps = {
    ...deps,
    guard: deps.guard ?? defaultGuard(),
    publicUrl: (deps.publicUrl ?? "http://localhost:3000").replace(/\/+$/, ""),
  };
  return {
    async execute({ runId, step, userId, workflowId, idempotencyKey, attempt, stepRunId, ctx, mock = false, test, aiLive, choice, claimSend, booking, fileFields }) {
      const secrets = await readSecrets(deps.db, deps.secretsKey, userId);
      const forms = secretForms(Object.values(secrets));
      // Only an HTTP step sees secrets. Every other step resolves without them, so an email, AI prompt or condition can't carry one.
      const real: ExpressionContext = step.type === "http" ? { ...ctx, secrets } : ctx;
      const masked: ExpressionContext = step.type === "http" ? { ...ctx, secrets: Object.fromEntries(Object.keys(secrets).map((k) => [k, "[secret]"])) } : ctx;
      let preview: unknown = null;
      try {
        preview = resolveInput(step, masked);
        const input = step.type === "http" ? resolveInput(step, real) : preview;
        if (step.type === "http" && usesSecrets(step.config)) {
          // Where a secret goes may depend on literal text and secrets only, never on trigger or step data.
          const fixed = text(step.config.url, { trigger: {}, steps: {}, secrets });
          if (originOf(fixed) !== originOf((input as HttpInput).url)) {
            throw new StepError("A request that uses a secret must go to a fixed address: trigger or step data changed its host. Move that data into the path or query.", false);
          }
        }
        const result = await runStep(full, step, input, real, { runId, idempotencyKey, attempt, stepRunId, userId, workflowId, mock, test, aiLive, choice, claimSend, booking, fileFields });
        return { ...result, input: preview, output: redactSecrets(result.output, forms) };
      } catch (err) {
        const message = redactSecrets(err instanceof Error ? err.message : String(err), forms) as string;
        const e = err instanceof StepError ? err : undefined;
        throw new StepError(message, isRetryable(err), { input: preview, usage: e?.usage, outcome: e?.outcome, retryAfterMs: e?.retryAfterMs, review: e?.review });
      }
    },
  };
}
