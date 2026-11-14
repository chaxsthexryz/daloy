import { randomUUID } from "node:crypto";
import { aiConnection, checkRecipients, claimTimeout, createApproval, findApprover, queueDelivery, readSecrets, redactSecrets, secretForms, sendAs, type Db, type MailDeps, type Provider } from "@daloy/db";
import { conditionBranch, declaresJson, isRetryable, mockAiOutput, parseJsonTemplate, resolveJsonTemplate, resolveTemplate, StepError, usesSecrets, type ExpressionContext, type Step } from "@daloy/engine";
import type { StepExecutor, StepResult } from "../advance";
import { runAi } from "./ai";
import { httpRequest } from "./http";
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

type HttpInput = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers: Record<string, string>; body?: string };
type EmailInput = { to: string; subject: string; text: string };
type AiInput = { input: string };
type ApprovalInput = { to?: string; approver?: string; subject: string; message: string; timeoutSeconds: number };
type SheetsInput = { columns: string[] };
type SlackInput = { text: string };

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
    case "delay":
      return { seconds: step.config.seconds };
    case "http": {
      const { method, url, headers } = step.config;
      const input: HttpInput = { method, url: text(url, ctx), headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, text(v, ctx)])) };
      if (step.config.body !== undefined) input.body = body(step.config.body, headers, ctx);
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
    case "slack":
    case "teams":
      return { text: text(step.config.text, ctx) } satisfies SlackInput;
  }
}

type Attempt = { runId: string; idempotencyKey: string; attempt: number; stepRunId: string; userId: string; mock: boolean };

async function runStep(deps: FullDeps, step: Step, input: unknown, ctx: ExpressionContext, { runId, idempotencyKey, attempt, stepRunId, userId, mock }: Attempt): Promise<StepResult> {
  switch (step.type) {
    case "condition":
      return { branch: conditionBranch(step.config.condition, ctx) };
    case "delay": {
      // A mocked test run waits at most one second, so the builder shows the result straight away.
      const seconds = mock ? Math.min(step.config.seconds, 1) : step.config.seconds;
      const waitUntil = new Date(Date.now() + seconds * 1000);
      return { output: { resumeAt: waitUntil.toISOString() }, waitUntil };
    }
    case "http": {
      const cfg = input as HttpInput;
      // Same shape as a real response, so later steps that read {{steps.x.output.body}} still resolve.
      if (mock) return { output: { mocked: true, status: 200, headers: {}, body: null, request: { method: cfg.method, url: cfg.url } } };
      return { output: await httpRequest(cfg, idempotencyKey, { guard: deps.guard }) };
    }
    case "email": {
      const mail = input as EmailInput;
      if (mock) return { output: { mocked: true, to: mail.to, subject: mail.subject } };
      const sent = await sendAs(deps.db, deps.secretsKey, deps.mail, userId, mail, idempotencyKey);
      return { output: { messageId: sent.messageId, to: sent.to, from: sent.from } };
    }
    case "ai": {
      if (mock) return { output: mockAiOutput(step.config) };
      // The model the workflow owner picked in the console, or the env vars if they picked none.
      const { model, ...connection } = await aiConnection(deps.db, deps.secretsKey, userId);
      return runAi(step.config, (input as AiInput).input, { connection, model, attempt });
    }
    case "approval": {
      // A mocked test run approves straight away, so the builder shows the approved path without an email.
      if (mock) return { output: { mocked: true, decision: "approved" }, branch: "approved" };
      const cfg = input as ApprovalInput;
      // A named approver must still be a member who may approve; the API checks again when they answer (decision 0022).
      const approver = cfg.approver ? await findApprover(deps.db, userId, cfg.approver) : null;
      if (cfg.approver && !approver) throw new StepError(`The approver ${cfg.approver} is not a member of this workspace who can approve.`, false);
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
      const who = approver ? `To answer, sign in as ${approver.email}. ` : "";
      const body = `${cfg.message}\n\nApprove or reject here:\n${link}\n\n${who}The link works once and expires at ${expiresAt.toISOString()}.`;
      // A retry or re-run sends a new link (earlier ones still work), so it needs its own Message-ID, or a mail server
      // could drop it as a duplicate of the earlier message.
      await sendAs(deps.db, deps.secretsKey, deps.mail, userId, { to: approver?.email ?? cfg.to!, subject: cfg.subject, text: body }, `${idempotencyKey}:${randomUUID().slice(0, 8)}`);
      // The run waits until the timeout; recording a decision wakes it earlier (decision 0009).
      return { output: { expiresAt: expiresAt.toISOString() }, waitUntil: expiresAt };
    }
    case "sheets":
    case "slack":
    case "outlook":
    case "teams": {
      // The request reference when the run came from a guided form, else the run id, so every row and message can be traced.
      const ref = (ctx.trigger as { reference?: unknown } | null)?.reference;
      const reference = typeof ref === "string" ? ref : runId;
      const payload =
        step.type === "sheets"
          ? { row: [reference, new Date().toISOString(), ...(input as SheetsInput).columns] }
          : step.type === "outlook"
            ? { ...(input as EmailInput), to: checkRecipients((input as EmailInput).to).join(",") }
            : { text: (input as SlackInput).text };
      if (mock) return { output: { mocked: true, reference, ...payload } };
      // Queued, not sent: the worker delivers it apart from the run, so one provider's trouble never holds up the other
      // (decision 0021). A re-run of this step gets the first delivery back, with its original payload.
      const provider: Provider = step.type === "sheets" ? "google_sheets" : step.type;
      const d = await queueDelivery(deps.db, { userId, runId, stepId: step.id, provider, reference, payload });
      return { output: { deliveryId: d.id, reference, state: d.state } };
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
    async execute({ runId, step, userId, idempotencyKey, attempt, stepRunId, ctx, mock = false }) {
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
        const result = await runStep(full, step, input, real, { runId, idempotencyKey, attempt, stepRunId, userId, mock });
        return { ...result, input: preview, output: redactSecrets(result.output, forms) };
      } catch (err) {
        const message = redactSecrets(err instanceof Error ? err.message : String(err), forms) as string;
        throw new StepError(message, isRetryable(err), { input: preview, usage: err instanceof StepError ? err.usage : undefined });
      }
    },
  };
}
