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

async function runStep(deps: ExecutorDeps & { guard: SsrfGuard }, step: Step, ctx: ExpressionContext, idempotencyKey: string): Promise<StepResult> {
  switch (step.type) {
    case "condition":
      return { branch: String(evaluateCondition(step.config.condition, ctx)) };
    case "delay": {
      const waitUntil = new Date(Date.now() + step.config.seconds * 1000);
      return { output: { resumeAt: waitUntil.toISOString() }, waitUntil };
    }
    case "http": {
      const { method, url, headers, body } = step.config;
      const cfg = {
        method,
        url: text(url, ctx),
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, text(v, ctx)])),
        body: body === undefined ? undefined : text(body, ctx),
      };
      return { output: await httpRequest(cfg, idempotencyKey, { guard: deps.guard }) };
    }
    case "email": {
      const { to, subject, text: body } = step.config;
      const sent = await sendEmail(deps.mailer, { to: text(to, ctx), subject: text(subject, ctx), text: text(body, ctx) }, idempotencyKey);
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
    async execute({ step, userId, idempotencyKey, ctx }) {
      const secrets = await readSecrets(deps.db, deps.secretsKey, userId);
      const values = Object.values(secrets)
        .filter((v) => v.length > 0)
        .sort((a, b) => b.length - a.length);
      try {
        const result = await runStep(full, step, { ...ctx, secrets }, idempotencyKey);
        return { ...result, output: redact(result.output, values) };
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err), values) as string;
        throw new StepError(message, isRetryable(err));
      }
    },
  };
}
