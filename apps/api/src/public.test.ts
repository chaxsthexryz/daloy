import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkSignature, validSignature } from "./public";

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

describe("webhook signature with a timestamp (N11b)", () => {
  const body = Buffer.from('{"a":1}');
  const now = 1_800_000_000;
  const v1 = (t: number | string, k = "k", b = body) => `sha256=${createHmac("sha256", k).update(`${t}.`).update(b).digest("hex")}`;
  const check = (over: Partial<Parameters<typeof checkSignature>[0]> = {}) => checkSignature({ body, signature: v1(now), timestamp: String(now), key: "k", requireTimestamp: false, nowSeconds: now, ...over });

  it("accepts the HMAC of the timestamp, a dot and the exact body, and returns the signature as the replay key", () => {
    const ok = check();
    expect(ok).toEqual({ ok: true, legacy: false, replayKey: v1(now).slice("sha256=".length) });
  });

  it("holds a 5 minute window in both directions, to the second", () => {
    expect(check({ nowSeconds: now + 300 }).ok).toBe(true);
    expect(check({ nowSeconds: now - 300 }).ok).toBe(true);
    expect(check({ nowSeconds: now + 301 })).toEqual({ ok: false, reason: "The timestamp is outside the 5 minute window. Check the clock of the sender." });
    expect(check({ nowSeconds: now - 301 })).toMatchObject({ ok: false, reason: expect.stringContaining("5 minute window") });
  });

  it("refuses a timestamp the signature does not cover, a wrong key, a changed body and a malformed timestamp", () => {
    expect(check({ timestamp: String(now + 1) })).toEqual({ ok: false, reason: "bad signature" });
    expect(check({ key: "other" })).toEqual({ ok: false, reason: "bad signature" });
    expect(check({ body: Buffer.from('{"a":2}') })).toEqual({ ok: false, reason: "bad signature" });
    expect(check({ timestamp: "12.5", signature: v1("12.5") })).toMatchObject({ ok: false });
    expect(check({ timestamp: "abc", signature: v1("abc") })).toMatchObject({ ok: false });
    expect(check({ timestamp: "", signature: v1("") })).toMatchObject({ ok: false });
    expect(check({ signature: undefined })).toEqual({ ok: false, reason: "bad signature" });
  });

  it("never reads a call that carries a timestamp as the old format", () => {
    const old = `sha256=${createHmac("sha256", "k").update(body).digest("hex")}`;
    expect(check({ signature: old })).toEqual({ ok: false, reason: "bad signature" });
  });

  it("accepts the old signature without a timestamp only while the trigger does not require one", () => {
    const old = `sha256=${createHmac("sha256", "k").update(body).digest("hex")}`;
    expect(check({ timestamp: undefined, signature: old })).toEqual({ ok: true, legacy: true, replayKey: undefined });
    expect(check({ timestamp: undefined, signature: old, requireTimestamp: true })).toEqual({ ok: false, reason: "This webhook requires the X-Daloy-Timestamp header. See how-it-works.md, webhook signatures." });
    expect(check({ timestamp: undefined, signature: "sha256=wrong" })).toEqual({ ok: false, reason: "bad signature" });
  });
});
