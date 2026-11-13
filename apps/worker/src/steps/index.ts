import { randomUUID } from "node:crypto";
import { aiConnection, createApproval, readSecrets, sendAs, type Db, type MailDeps } from "@daloy/db";
import { evaluateCondition, isRetryable, mockAiOutput, resolveTemplate, StepError, type ExpressionContext, type Step } from "@daloy/engine";
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

/** Replaces every secret value in strings (keys too) with [secret]. Longest first, so a secret that contains another is fully hidden. */
function redact(value: unknown, values: string[]): unknown {
  if (typeof value === "string") return values.reduce((s, v) => s.replaceAll(v, "[secret]"), value);
  if (Array.isArray(value)) return value.map((v) => redact(v, values));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, values), redact(v, values)]));
  }
  return value;
}

type HttpInput = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers: Record<string, string>; body?: string };
type EmailInput = { to: string; subject: string; text: string };
type AiInput = { input: string };
type ApprovalInput = { to: string; subject: string; message: string; timeoutSeconds: number };

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
      const { method, url, headers, body } = step.config;
      const input: HttpInput = { method, url: text(url, ctx), headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, text(v, ctx)])) };
      if (body !== undefined) input.body = text(body, ctx);
      return input;
    }
    case "email": {
      const { to, subject, text: body } = step.config;
      return { to: text(to, ctx), subject: text(subject, ctx), text: text(body, ctx) } satisfies EmailInput;
    }
    case "ai":
      // Only input is a template; labels, fields and instructions are literals (decision 0010).
      return { ...step.config, input: text(step.config.input, ctx) };
    case "approval": {
      const { to, subject, message, timeoutSeconds } = step.config;
      // The link is not part of the input, so the token never reaches the database or run history.
      return { to: text(to, ctx), subject: text(subject, ctx), message: text(message, ctx), timeoutSeconds } satisfies ApprovalInput;
    }
  }
}

type Attempt = { idempotencyKey: string; attempt: number; stepRunId: string; userId: string; mock: boolean };

async function runStep(deps: FullDeps, step: Step, input: unknown, ctx: ExpressionContext, { idempotencyKey, attempt, stepRunId, userId, mock }: Attempt): Promise<StepResult> {
  switch (step.type) {
    case "condition":
      return { branch: String(evaluateCondition(step.config.condition, ctx)) };
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
      const expiresAt = new Date(Date.now() + cfg.timeoutSeconds * 1000);
      const token = await createApproval(deps.db, stepRunId, expiresAt);
      const link = `${deps.publicUrl}/approvals/${token}`;
      const body = `${cfg.message}\n\nApprove or reject here:\n${link}\n\nThe link works once and expires at ${expiresAt.toISOString()}.`;
      // A re-run of this attempt after a crash sends a new link (the old one is deleted), so it needs its own Message-ID,
      // or a mail server could drop it as a duplicate of the dead one.
      await sendAs(deps.db, deps.secretsKey, deps.mail, userId, { to: cfg.to, subject: cfg.subject, text: body }, `${idempotencyKey}:${randomUUID().slice(0, 8)}`);
      // The run waits until the timeout; recording a decision wakes it earlier (decision 0009).
      return { output: { expiresAt: expiresAt.toISOString() }, waitUntil: expiresAt };
    }
  }
}

/**
 * Runs real steps. The owner's secrets are decrypted for this attempt only, and their values are
 * replaced with [secret] in the output and error text before anything is written to the database.
 */
export function createExecutor(deps: ExecutorDeps): StepExecutor {
  const full: FullDeps = {
    ...deps,
    guard: deps.guard ?? defaultGuard(),
    publicUrl: (deps.publicUrl ?? "http://localhost:3000").replace(/\/+$/, ""),
  };
  return {
    async execute({ step, userId, idempotencyKey, attempt, stepRunId, ctx, mock = false }) {
      const secrets = await readSecrets(deps.db, deps.secretsKey, userId);
      const values = Object.values(secrets)
        .filter((v) => v.length > 0)
        .sort((a, b) => b.length - a.length);
      const withSecrets = { ...ctx, secrets };
      let input: unknown = null;
      try {
        input = resolveInput(step, withSecrets);
        const result = await runStep(full, step, input, withSecrets, { idempotencyKey, attempt, stepRunId, userId, mock });
        return { ...result, input: redact(input, values), output: redact(result.output, values) };
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err), values) as string;
        throw new StepError(message, isRetryable(err), { input: redact(input, values), usage: err instanceof StepError ? err.usage : undefined });
      }
    },
  };
}
