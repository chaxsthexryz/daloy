import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, otpauthUri, totpAt, TOTP_STEP_S, verifyTotp } from "./totp";

// RFC 6238 appendix B, SHA-1: the ASCII key "12345678901234567890" and 8-digit codes.
const RFC_KEY = Buffer.from("12345678901234567890", "ascii");
const VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP (RFC 6238)", () => {
  it.each(VECTORS)("matches the RFC test vector at %i seconds", (seconds, code) => {
    expect(hotp(RFC_KEY, Math.floor(seconds / TOTP_STEP_S), 8)).toBe(code);
    // Six digits are the last six of the same truncated value.
    expect(totpAt(RFC_KEY, seconds * 1000)).toBe(code.slice(2));
  });

  it("accepts the step before, now and after, and returns which step matched", () => {
    const now = 1111111111 * 1000;
    const step = Math.floor(1111111111 / 30);
    for (const d of [-1, 0, 1]) expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, step + d, 6), now, null)).toBe(step + d);
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, step + 2, 6), now, null)).toBeNull();
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, step - 2, 6), now, null)).toBeNull();
  });

  it("refuses a code from a step already used, or an earlier one", () => {
    const now = 1111111111 * 1000;
    const step = Math.floor(1111111111 / 30);
    const code = hotp(RFC_KEY, step, 6);
    expect(verifyTotp(RFC_KEY, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_KEY, code, now, step + 1)).toBeNull();
    expect(verifyTotp(RFC_KEY, code, now, step - 1)).toBe(step);
  });

  it("refuses anything that is not six digits", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", " 28708"]) expect(verifyTotp(RFC_KEY, bad, 59_000, null)).toBeNull();
  });

  it("round-trips base32 and writes an otpauth URI authenticator apps read", () => {
    expect(base32Encode(RFC_KEY)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv-gy3tqojqgezdgnbvgy3tqojq")).toEqual(RFC_KEY);
    expect(otpauthUri(RFC_KEY, "boss@daloy.test", "kymavo admin")).toBe(
      "otpauth://totp/kymavo%20admin:boss%40daloy.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=kymavo%20admin&algorithm=SHA1&digits=6&period=30",
    );
  });
});
