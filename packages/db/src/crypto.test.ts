import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

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
