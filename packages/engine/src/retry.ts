export type RetryPolicy = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5 * 60_000 };

/** Thrown by steps. Only errors with retryable: true are retried. */
export class StepError extends Error {
  override name = "StepError";
  /** The resolved config the failed attempt ran with, already redacted, so run history can show it. */
  readonly input: unknown;
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown; input?: unknown },
  ) {
    super(message, options);
    this.input = options?.input ?? null;
  }
}

// Duck-typed so errors from other packages (LlmError) count without importing them.
export const isRetryable = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { retryable?: unknown }).retryable === true;

/** Full jitter: a random delay between 0 and min(maxDelay, base * 2^(attempt - 1)). `attempt` is the one that just failed (1-based). */
export function backoffDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export type RetryDecision =
  | { kind: "retry"; nextAttempt: number; delayMs: number }
  | { kind: "dead_letter" }
  | { kind: "fail" };

export function decideRetry(
  err: unknown,
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random = Math.random,
): RetryDecision {
  if (!isRetryable(err)) return { kind: "fail" };
  if (attempt >= policy.maxAttempts) return { kind: "dead_letter" };
  return { kind: "retry", nextAttempt: attempt + 1, delayMs: backoffDelayMs(attempt, policy, random) };
}

/** One key per step attempt. External calls send it so a repeated delivery after a crash can be deduplicated. */
export const idempotencyKey = (runId: string, stepId: string, attempt: number) => `${runId}:${stepId}:${attempt}`;
