import { describe, expect, it } from "vitest";
import { backoffDelayMs, decideRetry, DEFAULT_RETRY_POLICY, idempotencyKey, StepError } from "./retry";

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
  it("is runId:stepId:attempt", () => {
    expect(idempotencyKey("run_1", "send_email", 2)).toBe("run_1:send_email:2");
  });
});
