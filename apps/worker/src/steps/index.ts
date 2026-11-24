import { randomUUID } from "node:crypto";
import { workspaceLanguage, readKnowledge, aiConnection, bookFromStep, bookingEventPayload, bookingOfStep, bookingReference, centavosToPesos, createDue, dispatchInternalTrigger, dueConversationId, dueForStep, DueTakenError, expireDue, findReviewer, mockAssistantSnapshot, parseAssistantScope, paymentEventPayload, pendingCheckout, pesosToCentavos, readAssistantSnapshot, checkReceiptReference, checkRecipients, claimTimeout, claimUsage, createApproval, findPaymentForStep, findApprover, queueCalendarEvent, queueDelivery, readSecrets, redactSecrets, secretForms, sendAs, startSubWorkflow, type BookingTriggerEvent, type Db, type MailDeps, type Provider, type StepBookingResult } from "@daloy/db";
import { conversationMessages, deliveries, emailThreadFor, isPaused, PAST_WINDOW, prepareReply, providerUrls, recordOutboundEmail, recordOutboundReply, runConversation, runs, saveConversationFields, sendStaffAlert, takeOverConversation, windowOpen, type ProviderUrls } from "@daloy/db";
import { and, eq, gt, ne } from "drizzle-orm";
import { approvalEmailBody, checkDiscordContent, DEFAULT_STAY_TIMEZONE, numberedMenu, type Menu, wouldDo, type FileRef, bookingStartField, conditionBranch, normalizePhMobile, parseZoned, SMS_MAX_CHARS, stayRange, stayTimesFromKnowledge, type TestChoice, type Trigger, declaresJson, parseInstant, isRetryable, mockAiOutput, parseJsonTemplate, resolveJsonTemplate, resolveTemplate, StepError, usesSecrets, type ExpressionContext, type HistoryItem, type Language, quoteStay, QuoteError, type Step } from "@daloy/engine";
import type { StepExecutor, StepResult } from "../advance";
import { runAi, runAnswer } from "./ai";
import { browserService, browserStep, type BrowserInput, type BrowserService } from "./browser";
import { loadAiFiles } from "./ai-files";
import { googleDocsStep, type DocsInput } from "./google-docs";
import { httpRequest } from "./http";
import { expireCheckout, paymongoLink } from "./paymongo";
import { previousValue, readPage, SAMPLE_PAGE, type ReadPageInput } from "./read-page";
import { shopifyPayload, type ShopifyCreateInput, type ShopifyUpdateInput } from "./shopify";
import { defaultGuard, type SsrfGuard } from "./ssrf";

/**
 * publicUrl (PUBLIC_URL) is where the API is reachable, for approval links. The AI model comes from the owner's settings
 * or the LLM_* env vars. Mail goes out as the owner: their Gmail, or the installation server when they connected none.
 */
export type ExecutorDeps = {
  db: Db;
  secretsKey: Buffer;
  mail: MailDeps;
  guard?: SsrfGuard;
  publicUrl?: string;
  /** Where Google and the other providers live. Defaults to providerUrls() (env); tests point it at the fakes. */
  urls?: ProviderUrls;
  /** The browser service for the browser step (B2). Defaults to BROWSER_URL and BROWSER_TOKEN; null when there is none. */
  browser?: BrowserService | null;
  /** Enqueues child or event-triggered runs onto RUN_QUEUE immediately after creation. */
  enqueue?: (runId: string) => Promise<void>;
};
type FullDeps = ExecutorDeps & { guard: SsrfGuard; publicUrl: string; urls: ProviderUrls; browser: BrowserService | null };

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
type SlackInput = { text: string; chatId?: string };
type SmsInput = { to: string; message: string; senderId?: string };
type CalendarInput = { title: string; description: string };
type MetaReplyInput = { recipientId: string; channel?: string; text: string; quickReplies?: Menu };
type RecordInput = { fields?: Record<string, string>; title?: string; name?: string; desc?: string };
type DueInput = { reference: string; kind: "deposit" | "full" | "balance"; amount: string; total?: string; booking?: string; checkout: boolean; reviewer?: string; channel?: "sms" | "messenger"; to?: string; confirmedMessage?: string };
type CallWorkflowInput = { workflowSlug: string; payload: Record<string, string> };

async function enqueueAll(enqueue: ExecutorDeps["enqueue"], runIds: string[]) {
  if (!enqueue || runIds.length === 0) return;
  for (const id of runIds) await enqueue(id);
}

/**
 * The automations whose runs led to this run, this one last. Events and sub-workflow calls raised by its steps carry
 * it on, so a loop of automations stops (decision 0128).
 */
async function runCallChain(db: Db, runId: string, workflowId: string | undefined): Promise<string[]> {
  let callChain: string[] = workflowId ? [workflowId] : [];
  if (UUID.test(runId)) {
    const [parentRun] = await db.select({ triggerPayload: runs.triggerPayload }).from(runs).where(eq(runs.id, runId));
    const raw = (parentRun?.triggerPayload as { _callChain?: unknown } | undefined)?._callChain;
    if (Array.isArray(raw)) {
      const parsed = raw.filter((x): x is string => typeof x === "string");
      callChain = workflowId && !parsed.includes(workflowId) ? [...parsed, workflowId] : parsed;
    }
  }
  return callChain;
}

async function notifyBookingStepEvent(deps: FullDeps, userId: string, event: BookingTriggerEvent, output: Record<string, unknown>, callChain: string[]) {
  const out = output as { id?: string; version?: number } & Record<string, unknown>;
  if (!out.id || out.version === undefined) return;
  const { runIds } = await dispatchInternalTrigger(deps.db, {
    callChain,
    workspaceId: userId,
    type: "booking_event",
    event,
    eventKey: `booking:${out.id}:v${out.version}:${event}`,
    payload: bookingEventPayload(event, out),
  });
  await enqueueAll(deps.enqueue, runIds);
}

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
      const { to, subject, text: body, menu } = step.config;
      // The menu goes below the message as 1, 2, 3; email-in reads a reply of just a number back as that choice (decision 0118).
      return { to: text(to, ctx), subject: text(subject, ctx), text: menu ? `${text(body, ctx)}

${numberedMenu(menu)}` : text(body, ctx) } satisfies EmailInput;
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
    case "telegram":
      return { text: text(step.config.text, ctx), ...(step.config.chatId === undefined ? {} : { chatId: text(step.config.chatId, ctx).trim() }) } satisfies SlackInput;
    case "slack":
    case "teams":
    case "discord":
      return { text: text(step.config.text, ctx) } satisfies SlackInput;
    case "google_docs": {
      // Placeholder names are the owner's literals; only the name and the values are templates.
      const { templateId, templateName, name, values } = step.config;
      return { templateId, ...(templateName === undefined ? {} : { templateName }), name: text(name, ctx), values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, text(v, ctx)])) } satisfies DocsInput;
    }
    case "read_page": {
      const { url, selector, maxChars } = step.config;
      return { url: text(url, ctx), ...(selector === undefined ? {} : { selector }), maxChars } satisfies ReadPageInput;
    }
    case "sms": {
      const { to, message, senderId } = step.config;
      return { to: text(to, ctx), message: text(message, ctx), ...(senderId ? { senderId } : {}) } satisfies SmsInput;
    }
    case "meta_reply":
      return { recipientId: text(step.config.recipientId, ctx), channel: text(step.config.channel, ctx), text: text(step.config.text, ctx), ...(step.config.quickReplies ? { quickReplies: step.config.quickReplies } : {}) } satisfies MetaReplyInput;
    case "conversation_update":
      return { fields: Object.fromEntries(Object.entries(step.config.fields).map(([k, v]) => [k, text(v ?? "", ctx)])) };
    case "stay_quote": {
      const { room, checkIn, nights, guests } = step.config;
      return { room: text(room, ctx).trim(), checkIn: text(checkIn, ctx).trim(), nights: text(nights, ctx).trim(), guests: text(guests, ctx).trim() };
    }
    case "assistant_read": {
      const what = text(step.config.what, ctx).trim().toLowerCase() || "all";
      return { what, ...(step.config.timezone ? { timezone: step.config.timezone } : {}) };
    }
    case "shopify_create_product": {
      const c = step.config;
      const opt = (v: string | undefined) => (v === undefined ? "" : text(v, ctx));
      return { title: text(c.title, ctx), description: opt(c.description), price: opt(c.price), sku: opt(c.sku), status: c.status, imageUrl: opt(c.imageUrl) } satisfies ShopifyCreateInput;
    }
    case "shopify_update_product": {
      const c = step.config;
      const opt = (v: string | undefined) => (v === undefined ? "" : text(v, ctx));
      return { by: c.by, product: text(c.product, ctx), title: opt(c.title), description: opt(c.description), price: opt(c.price), sku: opt(c.sku), imageUrl: opt(c.imageUrl), ...(c.status ? { status: c.status } : {}) } satisfies ShopifyUpdateInput;
    }
    case "browser":
      // Addresses and typed values are templates; selectors, texts and names are the owner's literals.
      return { url: text(step.config.url, ctx), actions: step.config.actions.map((a) => (a.action === "goto" ? { ...a, url: text(a.url, ctx) } : a.action === "fill" ? { ...a, value: text(a.value, ctx) } : a)) } satisfies BrowserInput;
    case "calendar":
      return { title: text(step.config.title, ctx), description: step.config.description === undefined ? "" : text(step.config.description, ctx) } satisfies CalendarInput;
    case "payment_status":
      return { link: step.config.link };
    case "payment_due": {
      const c = step.config;
      return {
        reference: text(c.reference, ctx).trim(),
        kind: c.kind,
        amount: text(c.amount, ctx),
        ...(c.total !== undefined && { total: text(c.total, ctx) }),
        ...(c.booking !== undefined && { booking: c.booking }),
        checkout: c.checkout,
        ...(c.reviewer !== undefined && { reviewer: c.reviewer }),
        ...(c.channel !== undefined && { channel: c.channel, to: text(c.to!, ctx).trim() }),
        ...(c.confirmedMessage !== undefined && { confirmedMessage: text(c.confirmedMessage, ctx).trim() }),
      } satisfies DueInput;
    }
    case "payment_expire":
      return { due: step.config.due };
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
      const { action, mode, resource, booking, start, minutes, checkIn, nights, timezone, checkInTime, checkOutTime, conversation } = step.config;
      // A resource field stores { id, name }; the step books by id.
      const r = resource === undefined ? undefined : resolveTemplate(resource, ctx);
      const resourceId = r !== null && typeof r === "object" && typeof (r as { id?: unknown }).id === "string" ? (r as { id: string }).id : r === undefined ? undefined : text(resource!, ctx);
      const nightsText = nights === undefined ? undefined : typeof nights === "number" ? String(nights) : text(nights, ctx).trim();
      return {
        action,
        ...(mode !== undefined && { mode }),
        ...(resourceId !== undefined && { resource: resourceId }),
        ...(booking !== undefined && { booking: text(booking, ctx) }),
        ...(start !== undefined && { start: text(start, ctx) }),
        ...(minutes !== undefined && { minutes }),
        ...(checkIn !== undefined && { checkIn: text(checkIn, ctx).trim() }),
        ...(nightsText !== undefined && { nights: nightsText }),
        ...(timezone !== undefined && { timezone }),
        ...(checkInTime !== undefined && { checkInTime }),
        ...(checkOutTime !== undefined && { checkOutTime }),
        ...(conversation !== undefined && { conversation: text(conversation, ctx).trim() }),
      } satisfies BookingInput;
    }
    case "call_workflow": {
      const { workflowSlug, payload = {} } = step.config;
      return {
        workflowSlug: workflowSlug.trim(),
        payload: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, text(v, ctx)])),
      } satisfies CallWorkflowInput;
    }
  }
}

type BookingInput = {
  action: "create" | "reschedule" | "cancel";
  mode?: "slot" | "stay";
  resource?: string;
  booking?: string;
  start?: string;
  minutes?: number;
  checkIn?: string;
  nights?: string;
  timezone?: string;
  checkInTime?: string;
  checkOutTime?: string;
  conversation?: string;
};
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
      const at = { workspaceId: userId, test: booking.test, runId, stepId: step.id, workflowId: booking.workflowId };
      const found = (reason: string) => ({ branch: "not_found", output: { reason } });

      let r: StepBookingResult | undefined;
      if (cfg.mode === "stay") {
        if (cfg.action === "create") {
          if (!UUID.test(cfg.resource ?? "")) return found("There is no active resource with that id in this workspace.");
          const nights = /^\d{1,2}$/.test(cfg.nights ?? "") ? Number(cfg.nights) : NaN;
          const published = await readKnowledge(deps.db, userId);
          const times = stayTimesFromKnowledge(published?.entries ?? []);
          const range = stayRange({
            checkIn: cfg.checkIn ?? "",
            nights,
            timezone: cfg.timezone ?? DEFAULT_STAY_TIMEZONE,
            checkInTime: cfg.checkInTime ?? times.checkInTime,
            checkOutTime: cfg.checkOutTime ?? times.checkOutTime,
          });
          if (!range.ok) throw new StepError(range.error, false);
          let conversationId: string | undefined;
          if (cfg.conversation) {
            if (!UUID.test(cfg.conversation)) return found("There is no conversation with that id in this workspace.");
            conversationId = cfg.conversation;
          } else {
            const [linked] = await deps.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, runId));
            conversationId = linked?.conversationId ?? undefined;
          }
          r = await bookFromStep(deps.db, at, {
            action: "create",
            resourceId: cfg.resource!,
            start: range.start,
            end: range.end,
            nights: range.nights,
            timezone: range.timezone,
            ...(conversationId ? { conversationId } : {}),
          });
        } else if (cfg.action === "reschedule") {
          if (!cfg.booking?.trim()) return found("No booking reference was given.");
          r = await bookFromStep(deps.db, at, { action: "reschedule", reference: cfg.booking.trim(), checkIn: cfg.checkIn ?? "" });
        }
      }

      if (!r) {
        let start: Date | undefined;
        if (cfg.start !== undefined) {
          // The datetime field's own zone, slot and future rules, again at the moment of booking, whatever the data path.
          const field = bookingStartField(booking.trigger, step.config);
          const parsed = field ? parseZoned(cfg.start.trim(), { timezone: field.timezone!, slotMinutes: field.slotMinutes }) : { ok: false as const, error: "needs a datetime field of the trigger" };
          if (!parsed.ok) throw new StepError(`"start" ${parsed.error}, but got ${JSON.stringify(cfg.start)}`, false);
          start = parsed.at;
        }
        if (cfg.action === "create") {
          if (!UUID.test(cfg.resource ?? "")) return found("There is no active resource with that id in this workspace.");
          const field = bookingStartField(booking.trigger, step.config)!;
          r = await bookFromStep(deps.db, at, { action: "create", resourceId: cfg.resource!, start: start!, minutes: cfg.minutes!, timezone: field.timezone! });
        } else if (!cfg.booking?.trim()) return found("No booking reference was given.");
        else r = await bookFromStep(deps.db, at, cfg.action === "cancel" ? { action: "cancel", reference: cfg.booking.trim() } : { action: "reschedule", reference: cfg.booking.trim(), start: start!, minutes: cfg.minutes });
      }
      if (!booking.test && r.branch === "done") {
        const event: BookingTriggerEvent = cfg.action === "create" ? "created" : cfg.action === "reschedule" ? "rescheduled" : "cancelled";
        await notifyBookingStepEvent(deps, userId, event, r.output, await runCallChain(deps.db, runId, workflowId));
      }
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
    case "browser": {
      const cfg = input as BrowserInput;
      // A test run opens nothing: it lists what the page would see, with each extract name present but empty.
      if (mock) return { output: { mocked: true, url: cfg.url, wouldDo: wouldDo(cfg.url, cfg.actions), screenshots: [], ...Object.fromEntries(cfg.actions.flatMap((a) => (a.action === "extract" ? [[a.name, ""]] : []))) } };
      await claim("http");
      return { output: await browserStep(deps.db, deps.browser, { userId, runId, stepId: step.id }, cfg, claimSend) };
    }
    case "email": {
      const mail = input as EmailInput;
      if (mock) return { output: { mocked: true, to: mail.to, subject: mail.subject } };
      const recipients = checkRecipients(mail.to);
      await claim("email", recipients.length);
      // C6 (decision 0121): thread only direct replies to the conversation's own email address, never staff alerts or
      // multi-recipient messages, so guest thread headers cannot leak to another recipient.
      const [linked] = UUID.test(runId) ? await deps.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, runId)) : [];
      const convo = await runConversation(deps.db, linked?.conversationId);
      const isGuestReply = Boolean(convo && convo.channel === "email" && recipients.length === 1 && recipients[0]!.toLowerCase() === convo.externalId.toLowerCase());
      const thread = isGuestReply ? await emailThreadFor(deps.db, convo!.id) : undefined;
      // The Message-ID stays per attempt; the step key is the same on every attempt.
      // An email may not be sent twice on its own: sendAs claims the send once the sender is known.
      const sent = await sendAs(deps.db, deps.secretsKey, deps.mail, userId, mail, `${idempotencyKey}:${attempt}`, { claim: claimSend, capKey: idempotencyKey, thread });
      if (isGuestReply) {
        await recordOutboundEmail(deps.db, { conversationId: convo!.id, runId, text: mail.text, messageId: sent.messageId, references: thread?.references });
      }
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
      if (step.config.task === "answer") {
        const published = await readKnowledge(deps.db, userId);
        if (!published) throw new StepError("Publish the knowledge sheet (Business, Knowledge) before the concierge can answer.", false);
        const convo = trigger.conversation as { history?: unknown } | undefined;
        const history = Array.isArray(convo?.history) ? (convo.history as HistoryItem[]).filter((h) => typeof h?.text === "string") : [];
        const language = (await workspaceLanguage(deps.db, userId)) as Language;
        const ans = await runAnswer(step.config, (input as AiInput).input, { connection, model, attempt, entries: published.entries, version: published.version, history, language });
        if (!mock && !test && !booking?.test && (ans.output as { needsHuman?: boolean })?.needsHuman && UUID.test(runId)) {
          const [linked] = await deps.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, runId));
          if (linked?.conversationId) {
            await takeOverConversation(deps.db, userId, linked.conversationId);
            await sendStaffAlert(
              { db: deps.db, secretsKey: deps.secretsKey, mail: deps.mail, urls: deps.urls, publicUrl: deps.publicUrl },
              { workspaceId: userId, conversationId: linked.conversationId, reason: "Needs staff reply" },
            ).catch((err: unknown) => console.error("staff alert failed", err));
          }
        }
        return ans;
      }
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
    case "google_docs": {
      const cfg = input as DocsInput;
      if (mock) {
        const name = cfg.name.trim();
        if (!name) throw new StepError("The document name is empty after the values were filled in.", false);
        return { output: { mocked: true, documentId: "mock-document", url: "https://docs.google.com/document/d/mock-document/edit", name, unmatched: [] } };
      }
      return { output: await googleDocsStep(deps.db, deps.secretsKey, deps.urls, { userId, runId, stepId: step.id }, cfg, () => claim("http")) };
    }
    case "read_page": {
      const cfg = input as ReadPageInput;
      // A faked run returns one fixed page and no request leaves the machine (decision 0107).
      if (mock) return { output: { mocked: true, ...SAMPLE_PAGE, value: cfg.selector === undefined ? SAMPLE_PAGE.text : SAMPLE_PAGE.value, previous: null, changed: false } };
      const page = await readPage(cfg, { guard: deps.guard, publicUrl: deps.publicUrl, idempotencyKey, claim: async () => void (await claim("http")), claimSend });
      const previous = workflowId ? await previousValue(deps.db, { workflowId, stepId: step.id, runId }) : null;
      return { output: { ...page, previous, changed: previous !== null && previous !== page.value } };
    }
    case "discord":
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
      if (step.type === "discord") {
        const content = checkDiscordContent((input as SlackInput).text);
        if (!content.ok) throw new StepError(content.error, false);
        (input as SlackInput).text = content.value;
      }
      // T9: a reply goes only to the chat the run's Telegram message came from, so run data cannot point the bot elsewhere.
      const chatId = step.type === "telegram" ? (input as SlackInput).chatId : undefined;
      if (chatId !== undefined && (!/^-?\d{1,20}$/.test(chatId) || chatId !== (ctx.trigger as { chatId?: unknown } | null)?.chatId)) {
        throw new StepError("A Telegram reply can only go to the chat the message came from. Use {{trigger.chatId}}.", false);
      }
      const payload =
        step.type === "sheets"
          ? { row: [reference, new Date().toISOString(), ...(input as SheetsInput).columns] }
          : step.type === "outlook"
            ? { ...(input as EmailInput), to: checkRecipients((input as EmailInput).to).join(",") }
            : step.type === "airtable" || step.type === "notion" || step.type === "trello"
              ? (input as RecordInput)
              : { text: (input as SlackInput).text, ...(chatId === undefined ? {} : { chatId }) };
      if (mock) return { output: { mocked: true, reference, ...payload } };
      if (step.type === "outlook") {
        const n = (payload as { to: string }).to.split(",").length;
        await claim("email", n);
        await claim("mailbox", n);
      }
      // Queued, not sent: the worker delivers it apart from the run, so one provider's trouble never holds up the other
      // (decision 0021). A re-run of this step gets the first delivery back, with its original payload.
      const provider: Provider = step.type === "sheets" ? "google_sheets" : step.type;
      if (step.type === "telegram" && chatId !== undefined && UUID.test(runId)) {
        const [linked] = await deps.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, runId));
        const convo = await runConversation(deps.db, linked?.conversationId);
        if (convo && convo.channel === "telegram" && convo.externalId === chatId) {
          const d = await deps.db.transaction(async (tx) => {
            const [queued] = await tx.select().from(deliveries).where(and(eq(deliveries.runId, runId), eq(deliveries.stepId, step.id)));
            if (queued) return queued;
            await recordOutboundReply(tx, { conversationId: convo.id, runId, text: (payload as { text: string }).text });
            return queueDelivery(tx, { userId, runId, stepId: step.id, provider, reference, payload });
          });
          return { output: { deliveryId: d.id, reference, state: d.state } };
        }
      }
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
      // A run a guest message started checks its conversation first (decision 0115): staff took over, or Meta's window
      // (24 hours from the guest's last message, not this run's) has closed. Each takes its edge, so a template can
      // fall back to SMS or email.
      const [runRow] = UUID.test(runId)
        ? await deps.db.select({ conversationId: runs.conversationId, createdAt: runs.createdAt }).from(runs).where(eq(runs.id, runId))
        : [];
      const convo = await runConversation(deps.db, runRow?.conversationId);
      const initialStatus = (trig.conversation as { status?: string } | undefined)?.status;
      const hasHandoff = Object.values((ctx.steps ?? {}) as Record<string, { output?: Record<string, unknown> }>).some((s) => s?.output?.needsHuman === true);
      let handoffReply = false;
      if (convo && isPaused(convo) && hasHandoff && initialStatus !== "staff" && convo.staffUntil === null && runRow) {
        const [staffReply] = await deps.db
          .select({ id: conversationMessages.id })
          .from(conversationMessages)
          .where(and(eq(conversationMessages.conversationId, convo.id), eq(conversationMessages.direction, "staff"), gt(conversationMessages.createdAt, runRow.createdAt)))
          .limit(1);
        const [alreadySent] = await deps.db
          .select({ id: deliveries.id })
          .from(deliveries)
          .where(and(eq(deliveries.runId, runId), eq(deliveries.provider, "meta_messenger"), ne(deliveries.stepId, step.id)))
          .limit(1);
        handoffReply = !staffReply && !alreadySent;
      }
      if (convo && isPaused(convo) && !handoffReply) return { branch: "paused", output: { skipped: "A staff member replied from the inbox, so the bot did not reply." } };
      if (convo && !windowOpen(convo.lastInboundAt)) return { branch: "outside_window", output: { skipped: PAST_WINDOW } };
      const ref = trig.reference ?? trig.messageId;
      const reference = typeof ref === "string" ? ref : runId;
      const inboundTimestamp = convo?.lastInboundAt?.toISOString() ?? (typeof trig.timestamp === "string" && trig.timestamp.trim() ? trig.timestamp.trim() : undefined);
      const receivingPageId = typeof trig.pageId === "string" && trig.pageId.trim() ? trig.pageId.trim() : undefined;
      const receivingInstagramAccountId = typeof trig.instagramAccountId === "string" && trig.instagramAccountId.trim() ? trig.instagramAccountId.trim() : undefined;
      const d = await deps.db.transaction(async (tx) => {
        // A step that runs again gets its first delivery back, without a second history row or notice.
        const [queued] = await tx.select().from(deliveries).where(and(eq(deliveries.runId, runId), eq(deliveries.stepId, step.id)));
        if (queued) return queued;
        const sent = convo ? await prepareReply(tx, { id: convo.id, userId, runId, text: body, max: 2000 }) : body;
        return queueDelivery(tx, {
          userId,
          runId,
          stepId: step.id,
          provider: "meta_messenger",
          reference,
          payload: {
            recipientId,
            ...(channel ? { channel } : {}),
            text: sent,
            ...(cfg.quickReplies ? { quickReplies: cfg.quickReplies } : {}),
            ...(inboundTimestamp ? { inboundTimestamp } : {}),
            ...(receivingPageId ? { receivingPageId } : {}),
            ...(receivingInstagramAccountId ? { receivingInstagramAccountId } : {}),
          },
        });
      });
      return { output: { deliveryId: d.id, reference, state: d.state, recipientId } };
    }
    case "conversation_update": {
      const cfg = input as { fields: Record<string, string> };
      if (mock) return { output: { mocked: true, fields: cfg.fields } };
      const [linked] = await deps.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, runId));
      if (!linked?.conversationId) throw new StepError("This step saves details on a customer's conversation, and this run was not started by a Messenger, Instagram or email message.", false);
      return { output: { fields: (await saveConversationFields(deps.db, linked.conversationId, cfg.fields)) ?? {} } };
    }
    case "stay_quote": {
      // Read-only, so a test run quotes for real. The prices are the published version's; the run only picks the room and counts.
      const cfg = input as { room: string; checkIn: string; nights: string; guests: string };
      const published = await readKnowledge(deps.db, userId);
      if (!published) throw new StepError("Publish the knowledge sheet (Business, Knowledge) before quoting a stay.", false);
      const wanted = cfg.room.toLowerCase();
      const entry = published.entries.find((e) => e.id === cfg.room) ?? published.entries.find((e) => e.title.toLowerCase() === wanted);
      if (!entry) throw new StepError(`No entry "${cfg.room.slice(0, 100)}" in knowledge version ${published.version}.`, false);
      const count = (s: string) => (/^\d{1,4}$/.test(s) ? Number(s) : NaN);
      try {
        return { output: { ...quoteStay(entry, { checkIn: cfg.checkIn, nights: count(cfg.nights), guests: count(cfg.guests) }), knowledgeVersion: published.version } };
      } catch (err) {
        if (err instanceof QuoteError) throw new StepError(err.message, false);
        throw err;
      }
    }
    case "assistant_read": {
      const cfg = input as { what: string; timezone?: string };
      const scope = parseAssistantScope(cfg.what);
      if (!scope) {
        throw new StepError(`assistant_read "what" must be all, calendar, bookings, payments or runs, but got ${JSON.stringify(cfg.what)}.`, false);
      }
      if (mock) return { output: mockAssistantSnapshot(scope, cfg.timezone) };
      return { output: await readAssistantSnapshot({ db: deps.db, secretsKey: deps.secretsKey, urls: deps.urls, userId, what: scope, timezone: cfg.timezone }) };
    }
    case "shopify_create_product":
    case "shopify_update_product": {
      // Queued like the other apps (decision 0105): pinned to the store connected now, retried and reviewed on its own.
      const payload = shopifyPayload(step.type, input as ShopifyCreateInput | ShopifyUpdateInput);
      const ref = (ctx.trigger as { reference?: unknown } | null)?.reference;
      const reference = typeof ref === "string" ? ref : runId;
      if (mock) return { output: { mocked: true, reference, ...payload } };
      const d = await queueDelivery(deps.db, { userId, runId, stepId: step.id, provider: "shopify", reference, payload });
      return { output: { deliveryId: d.id, reference, state: d.state } };
    }
    case "payment_status": {
      const cfg = input as { link: string };
      if (mock) return { output: { mocked: true, status: "pending", paid: false } };
      // A payment_due step: its own state, whichever path paid it (decision 0088).
      const due = await dueForStep(deps.db, runId, cfg.link);
      if (due) return { output: { status: due.status, paid: due.status === "confirmed", reference: due.reference, amount: due.amountCentavos, amountPesos: centavosToPesos(due.amountCentavos), confirmedSource: due.confirmedSource } };
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
    case "payment_due": {
      const cfg = input as DueInput;
      const cents = (label: string, value: string) => {
        try {
          return pesosToCentavos(value);
        } catch (err) {
          throw new StepError(`${label}: ${(err as Error).message}`, false);
        }
      };
      const amountCentavos = cents("amount", cfg.amount);
      const totalCentavos = cfg.total === undefined ? null : cents("total", cfg.total);
      if (totalCentavos !== null && totalCentavos < amountCentavos) throw new StepError("The total is less than the amount asked for now.", false);
      if (!cfg.reference || cfg.reference.length > 200) throw new StepError("The order reference is empty or longer than 200 characters.", false);
      let replyTo = cfg.to ?? null;
      if (cfg.channel === "sms") {
        const phone = normalizePhMobile(cfg.to ?? "");
        if (!phone.ok) throw new StepError(phone.error, false);
        replyTo = phone.value;
      }
      if (cfg.confirmedMessage && cfg.channel === "sms" && cfg.confirmedMessage.length > SMS_MAX_CHARS) throw new StepError(`The confirmation message is above the ${SMS_MAX_CHARS}-character SMS limit.`, false);
      if (mock) return { output: { mocked: true, reference: cfg.reference, kind: cfg.kind, amount: amountCentavos, amountPesos: centavosToPesos(amountCentavos), status: "pending", payUrl: "", checkoutUrl: "" } };
      const reviewer = cfg.reviewer ? await findReviewer(deps.db, userId, cfg.reviewer) : null;
      if (cfg.reviewer && !reviewer) throw new StepError(`${cfg.reviewer} is not an owner or operator of this workspace, so they cannot review payments.`, false);
      const booked = cfg.booking ? await bookingOfStep(deps.db, runId, cfg.booking) : undefined;
      const [linked] = UUID.test(runId) ? await deps.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, runId)) : [];
      let due;
      try {
        due = await createDue(deps.db, { userId, test: test === true, workflowId: workflowId ?? null, runId, stepId: step.id, reference: cfg.reference, kind: cfg.kind, amountCentavos, totalCentavos, bookingId: booked?.id ?? null, reviewerId: reviewer?.id ?? null, replyChannel: cfg.channel ?? null, replyTo, replyText: cfg.confirmedMessage || null, conversationId: linked?.conversationId ?? null });
      } catch (err) {
        throw err instanceof DueTakenError ? new StepError(err.message, false) : err;
      }
      const checkout = cfg.checkout ? await paymongoLink(deps.db, deps.secretsKey, { userId, workflowId: workflowId!, runId, stepId: step.id, idempotencyKey }, { amount: centavosToPesos(due.amountCentavos), description: `${due.kind === "deposit" ? "Deposit" : due.kind === "balance" ? "Balance" : "Payment"} for ${due.reference}`, reference: due.reference }, () => claim("http"), due.id) : undefined;
      return { output: { dueId: due.id, reference: due.reference, kind: due.kind, amount: due.amountCentavos, amountPesos: centavosToPesos(due.amountCentavos), status: due.status, payUrl: `${deps.publicUrl}/pay/${due.token}`, checkoutUrl: checkout?.url ?? "" } };
    }
    case "payment_expire": {
      const cfg = input as { due: string };
      if (mock) return { branch: "expired", output: { mocked: true, reason: "Test run: nothing was cancelled." } };
      const due = await dueForStep(deps.db, runId, cfg.due);
      if (!due) throw new StepError(`Step ${cfg.due} asked for no payment in this run.`, false);
      // PayMongo first, outside the lock: a checkout being paid right now keeps the order, and its webhook settles it.
      const open = due.status === "pending" ? await pendingCheckout(deps.db, due.id) : undefined;
      if (open && (await expireCheckout(deps.db, deps.secretsKey, userId, open.providerSessionId)) === "in_progress") {
        return { branch: "kept", output: { status: due.status, reference: due.reference, reason: "PayMongo is taking a payment for this checkout, so the order was kept." } };
      }
      const r = await expireDue(deps.db, { userId, runId, stepId: step.id, dueStepId: cfg.due });
      if (r.result === "not_found") throw new StepError(`Step ${cfg.due} asked for no payment in this run.`, false);
      let released = false;
      let cancelledBooking: StepBookingResult | undefined;
      if (r.result === "expired" && due.bookingId) {
        const reference = await bookingReference(deps.db, due.bookingId);
        cancelledBooking = reference ? await bookFromStep(deps.db, { workspaceId: userId, test: due.test, runId, stepId: step.id, workflowId: workflowId! }, { action: "cancel", reference }) : undefined;
        released = cancelledBooking?.branch === "done";
      }
      if (!due.test && r.result === "expired" && r.due) {
        const convoId = await dueConversationId(deps.db, r.due.bookingId);
        const callChain = await runCallChain(deps.db, runId, workflowId);
        const { runIds } = await dispatchInternalTrigger(deps.db, {
          callChain,
          workspaceId: userId,
          type: "payment_event",
          event: "expired",
          eventKey: `payment_due:${r.due.id}:expired`,
          payload: paymentEventPayload("expired", r.due, convoId),
        });
        await enqueueAll(deps.enqueue, runIds);
        if (cancelledBooking?.branch === "done") {
          await notifyBookingStepEvent(deps, userId, "cancelled", cancelledBooking.output, callChain);
        }
      }
      return { branch: r.result, output: { status: r.due!.status, reference: due.reference, bookingReleased: released } };
    }
    case "call_workflow": {
      const cfg = input as CallWorkflowInput;
      if (mock) return { output: { mocked: true, simulated: true, workflowSlug: cfg.workflowSlug, payload: cfg.payload } };
      const callChain = await runCallChain(deps.db, runId, workflowId);
      let res;
      try {
        res = await startSubWorkflow(deps.db, {
          workspaceId: userId,
          workflowSlug: cfg.workflowSlug,
          eventKey: `sub:${runId}:${step.id}`,
          payload: cfg.payload,
          callChain,
        });
      } catch (err) {
        throw new StepError(err instanceof Error ? err.message : String(err), false);
      }
      if (!res.duplicate) await enqueueAll(deps.enqueue, [res.runId]);
      return { output: { runId: res.runId, workflowId: res.workflowId, workflowSlug: res.workflowSlug, duplicate: res.duplicate } };
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
    urls: deps.urls ?? providerUrls(),
    browser: deps.browser === undefined ? browserService() : deps.browser,
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
