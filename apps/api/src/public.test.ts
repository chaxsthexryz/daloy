import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validSignature } from "./public";

describe("webhook signature", () => {
  const body = Buffer.from('{"a":1}');
  const sign = (k: string) => `sha256=${createHmac("sha256", k).update(body).digest("hex")}`;

  it("accepts the HMAC of the exact body", () => {
    expect(validSignature(body, sign("k"), "k")).toBe(true);
  });

  it("rejects a missing, malformed or wrong signature", () => {
    expect(validSignature(body, undefined, "k")).toBe(false);
    expect(validSignature(body, "sha256=short", "k")).toBe(false);
    expect(validSignature(body, sign("other"), "k")).toBe(false);
    expect(validSignature(Buffer.from('{"a":2}'), sign("k"), "k")).toBe(false);
  });
});
