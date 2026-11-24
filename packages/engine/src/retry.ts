export type RetryPolicy = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5 * 60_000 };

/**
 * What a failed outside call may have done (decision 0030). not_sent: provably nothing reached the receiver.
 * rejected: the receiver refused it. throttled: the receiver asked to wait. unknown: it may have gone through.
 */
export type Outcome = "not_sent" | "rejected" | "throttled" | "unknown";

/** The longest Retry-After a step waits for. A longer one dead-letters instead of retrying early. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** Thrown by steps. Only errors with retryable: true are retried; a non-retryable unknown outcome goes to review. */
export class StepError extends Error {
  override name = "StepError";
  /** The resolved config the failed attempt ran with, already redacted, so run history can show it. */
  readonly input: unknown;
  /** Tokens a failed AI attempt still spent, so the step run records them. */
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly outcome?: Outcome;
  /** A person decides before anything more is sent, even though nothing was (a daily send cap, N11b). */
  readonly review?: boolean;
  /** From the receiver's Retry-After: the earliest the next attempt may go. */
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown; input?: unknown; usage?: { inputTokens: number; outputTokens: number }; outcome?: Outcome; retryAfterMs?: number; review?: boolean },
  ) {
    super(message, options);
    this.input = options?.input ?? null;
    this.usage = options?.usage;
    this.outcome = options?.outcome;
    this.review = options?.review;
    this.retryAfterMs = options?.retryAfterMs;
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
  | { kind: "review" }
  | { kind: "fail" };

export function decideRetry(
  err: unknown,
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random = Math.random,
): RetryDecision {
  if (!isRetryable(err)) return err instanceof StepError && (err.outcome === "unknown" || err.review) ? { kind: "review" } : { kind: "fail" };
  const retryAfterMs = err instanceof StepError ? (err.retryAfterMs ?? 0) : 0;
  if (attempt >= policy.maxAttempts || retryAfterMs > MAX_RETRY_AFTER_MS) return { kind: "dead_letter" };
  return { kind: "retry", nextAttempt: attempt + 1, delayMs: Math.max(retryAfterMs, backoffDelayMs(attempt, policy, random)) };
}

/**
 * One key per step, the same on every attempt, sent as Idempotency-Key. A hint for receivers that deduplicate:
 * kymavo never relies on it, which is why an unknown outcome on a step that is not idempotent waits for review.
 */
export const idempotencyKey = (runId: string, stepId: string) => `${runId}:${stepId}`;

/**
 * Parses a Retry-After header value (positive delta seconds or HTTP-date) into milliseconds from `now`,
 * clamped to `maxDelayMs` when given. Returns undefined when absent, non-positive, or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, maxDelayMs?: number, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let ms: number | undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const s = Number(trimmed);
    if (Number.isFinite(s) && s > 0) ms = Math.round(s * 1000);
  } else {
    const at = Date.parse(trimmed);
    if (Number.isFinite(at) && at > now) ms = at - now;
  }
  if (ms === undefined || ms <= 0) return undefined;
  return maxDelayMs !== undefined ? Math.min(ms, maxDelayMs) : ms;
}
