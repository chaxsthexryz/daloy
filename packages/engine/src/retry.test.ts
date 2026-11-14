import { describe, expect, it } from "vitest";
import { backoffDelayMs, decideRetry, DEFAULT_RETRY_POLICY, idempotencyKey, MAX_RETRY_AFTER_MS, StepError } from "./retry";

const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 };
const half = () => 0.5;

describe("backoffDelayMs", () => {
  it("doubles the ceiling each attempt", () => {
    expect([1, 2, 3, 4].map((a) => backoffDelayMs(a, policy, half))).toEqual([500, 1000, 2000, 4000]);
  });

  it("caps the ceiling at maxDelayMs", () => {
    expect(backoffDelayMs(50, policy, half)).toBe(5000);
  });

  it("stays within [0, ceiling) for any random value", () => {
    for (let i = 0; i < 1000; i++) {
      const attempt = 1 + (i % 6);
      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const delay = backoffDelayMs(attempt, policy);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(ceiling);
    }
  });
});

describe("decideRetry", () => {
  const retryable = new StepError("HTTP 503", true);

  it("retries a retryable error with the next attempt number", () => {
    expect(decideRetry(retryable, 1, policy, half)).toEqual({ kind: "retry", nextAttempt: 2, delayMs: 500 });
  });

  it("dead-letters a retryable error once attempts run out", () => {
    expect(decideRetry(retryable, 3, policy)).toEqual({ kind: "dead_letter" });
  });

  it("fails at once on errors not marked retryable", () => {
    expect(decideRetry(new StepError("HTTP 400", false), 1, policy)).toEqual({ kind: "fail" });
    expect(decideRetry(new Error("bug"), 1, policy)).toEqual({ kind: "fail" });
    expect(decideRetry("string thrown", 1, policy)).toEqual({ kind: "fail" });
    expect(decideRetry(null, 1, policy)).toEqual({ kind: "fail" });
  });

  it("accepts any error with retryable: true, such as LlmError", () => {
    const llmError = Object.assign(new Error("timeout"), { retryable: true });
    expect(decideRetry(llmError, 1, policy).kind).toBe("retry");
  });

  it("defaults to 3 attempts", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
    expect(decideRetry(retryable, 2).kind).toBe("retry");
    expect(decideRetry(retryable, 3).kind).toBe("dead_letter");
  });

  it("dead-letters on the first failure when maxAttempts is 1", () => {
    expect(decideRetry(retryable, 1, { ...policy, maxAttempts: 1 })).toEqual({ kind: "dead_letter" });
  });
});

describe("idempotencyKey", () => {
  it("is runId:stepId, the same on every attempt", () => {
    expect(idempotencyKey("run_1", "send_email")).toBe("run_1:send_email");
  });
});

describe("decideRetry with outcomes (P5)", () => {
  it("sends an unknown outcome that is not safe to repeat to review, never to a retry", () => {
    expect(decideRetry(new StepError("HTTP 503", false, { outcome: "unknown" }), 1, policy)).toEqual({ kind: "review" });
    expect(decideRetry(new StepError("HTTP 503", false, { outcome: "unknown" }), 3, policy)).toEqual({ kind: "review" });
  });

  it("fails a rejected outcome at once", () => {
    expect(decideRetry(new StepError("HTTP 400", false, { outcome: "rejected" }), 1, policy)).toEqual({ kind: "fail" });
  });

  it("never retries earlier than Retry-After", () => {
    const throttled = new StepError("HTTP 429", true, { outcome: "throttled", retryAfterMs: 7000 });
    expect(decideRetry(throttled, 1, policy, half)).toEqual({ kind: "retry", nextAttempt: 2, delayMs: 7000 });
    // The backoff wins when it is longer.
    expect(decideRetry(new StepError("HTTP 429", true, { outcome: "throttled", retryAfterMs: 10 }), 1, policy, half)).toEqual({ kind: "retry", nextAttempt: 2, delayMs: 500 });
  });

  it("dead-letters instead of retrying early when Retry-After is longer than the wait limit", () => {
    const far = new StepError("HTTP 429", true, { outcome: "throttled", retryAfterMs: MAX_RETRY_AFTER_MS + 1 });
    expect(decideRetry(far, 1, policy)).toEqual({ kind: "dead_letter" });
  });
});
