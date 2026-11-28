import { createHmac, timingSafeEqual } from "node:crypto";

/** RFC 6238 TOTP with the parameters every authenticator app defaults to: SHA-1, 30-second steps, 6 digits (decision 0158). */
export const TOTP_STEP_S = 30;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4226 HOTP: HMAC-SHA-1 of the 8-byte counter, dynamically truncated to `digits` digits. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_STEP_S);
export const totpAt = (key: Buffer, nowMs: number) => hotp(key, totpStep(nowMs));

/**
 * The step a 6-digit code matches within one step either side of now, or null. A step at or before `lastStep` is
 * refused, so a code works once. Every candidate is compared in constant time, and all three are always checked.
 */
export function verifyTotp(key: Buffer, code: string, nowMs: number, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const now = totpStep(nowMs);
  let matched: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    if (timingSafeEqual(Buffer.from(hotp(key, step)), given) && (lastStep === null || step > lastStep)) matched = step;
  }
  return matched;
}

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Reads base32 as people type it: any case, spaces and dashes ignored. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The Key URI Format authenticator apps scan or accept as text. */
export function otpauthUri(key: Buffer, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(key)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_S}`;
}
