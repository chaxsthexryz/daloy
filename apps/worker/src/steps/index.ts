import { readSecrets, type Db } from "@daloy/db";
import { evaluateCondition, isRetryable, resolveTemplate, StepError, type ExpressionContext, type Step } from "@daloy/engine";
import type { StepExecutor, StepResult } from "../advance";
import { sendEmail, type Mailer } from "./email";
import { httpRequest } from "./http";
import { defaultGuard, type SsrfGuard } from "./ssrf";

export type ExecutorDeps = { db: Db; secretsKey: Buffer; mailer: Mailer; guard?: SsrfGuard };

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
    default:
      return null;
  }
}

async function runStep(deps: ExecutorDeps & { guard: SsrfGuard }, step: Step, input: unknown, ctx: ExpressionContext, idempotencyKey: string, mock: boolean): Promise<StepResult> {
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
      const sent = await sendEmail(deps.mailer, mail, idempotencyKey);
      return { output: { messageId: sent.messageId, to: sent.to } };
    }
    default:
      throw new StepError(`step type "${step.type}" arrives in phase 7`, false);
  }
}

/**
 * Runs real steps. The owner's secrets are decrypted for this attempt only, and their values are
 * replaced with [secret] in the output and error text before anything is written to the database.
 */
export function createExecutor(deps: ExecutorDeps): StepExecutor {
  const full = { ...deps, guard: deps.guard ?? defaultGuard() };
  return {
    async execute({ step, userId, idempotencyKey, ctx, mock = false }) {
      const secrets = await readSecrets(deps.db, deps.secretsKey, userId);
      const values = Object.values(secrets)
        .filter((v) => v.length > 0)
        .sort((a, b) => b.length - a.length);
      const withSecrets = { ...ctx, secrets };
      let input: unknown = null;
      try {
        input = resolveInput(step, withSecrets);
        const result = await runStep(full, step, input, withSecrets, idempotencyKey, mock);
        return { ...result, input: redact(input, values), output: redact(result.output, values) };
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err), values) as string;
        throw new StepError(message, isRetryable(err), { input: redact(input, values) });
      }
    },
  };
}
