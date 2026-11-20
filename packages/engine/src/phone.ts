/** Maximum rendered SMS length accepted by Daloy (4 concatenated GSM-7 / standard SMS segments). */
export const SMS_MAX_CHARS = 670;

/** UniSMS Sender ID: up to 11 ASCII letters, digits, spaces, hyphens or underscores, starting with a letter or digit. */
export const SENDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,10}$/;

const PH_MOBILE_RAW = /^[+\d][\d\s-]*\d$/;
const PH_MOBILE_CANON = /^(?:\+63|63|0)(9\d{9})$/;

/**
 * Normalizes a Philippine mobile number (+639XXXXXXXXX, 639XXXXXXXXX or 09XXXXXXXXX, with optional spaces or hyphens)
 * to E.164 format (+639XXXXXXXXX). Rejects non-Philippine, landline and malformed numbers.
 */
export function normalizePhMobile(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed || !PH_MOBILE_RAW.test(trimmed)) {
    return { ok: false, error: "Enter a Philippine mobile number such as +639171234567, 639171234567 or 09171234567." };
  }
  const compact = trimmed.replace(/[\s-]+/g, "");
  const match = PH_MOBILE_CANON.exec(compact);
  if (!match) {
    return { ok: false, error: "Enter a Philippine mobile number such as +639171234567, 639171234567 or 09171234567." };
  }
  return { ok: true, value: `+63${match[1]!}` };
}
