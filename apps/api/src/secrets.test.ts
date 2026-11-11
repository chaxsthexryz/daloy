import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validSignature } from "./public";
import { decryptSecret, encryptSecret } from "./secrets";

const key = randomBytes(32);

describe("secret encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret(key, "user-1", "api_key", "s3cret");
    const b = encryptSecret(key, "user-1", "api_key", "s3cret");
    expect(a.iv).not.toBe(b.iv);
    expect(decryptSecret(key, "user-1", "api_key", a)).toBe("s3cret");
  });

  it("refuses a tampered ciphertext", () => {
    const s = encryptSecret(key, "user-1", "api_key", "s3cret");
    const bytes = Buffer.from(s.ciphertext, "base64");
    bytes[0]! ^= 1;
    expect(() => decryptSecret(key, "user-1", "api_key", { ...s, ciphertext: bytes.toString("base64") })).toThrow();
  });

  it("refuses a ciphertext moved to another user or name", () => {
    const s = encryptSecret(key, "user-1", "api_key", "s3cret");
    expect(() => decryptSecret(key, "user-2", "api_key", s)).toThrow();
    expect(() => decryptSecret(key, "user-1", "other", s)).toThrow();
  });

  it("refuses the wrong key", () => {
    const s = encryptSecret(key, "user-1", "api_key", "s3cret");
    expect(() => decryptSecret(randomBytes(32), "user-1", "api_key", s)).toThrow();
  });
});

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
