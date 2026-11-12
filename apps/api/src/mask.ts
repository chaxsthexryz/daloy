/** Key names whose values are never shown in run history. Matching is by substring, so "client_secret" and "X-Api-Key" count. */
const SECRET_KEY = /secret|token|passw(or)?d|authorization|api[-_]?key|cookie/i;

/**
 * Replaces the value under any secret-looking key with "[secret]", at any depth, and returns a copy.
 * The worker already removes known secret values by value before it writes; this second pass covers
 * trigger payloads and anything a step returned under a sensitive key. It errs on masking too much.
 */
export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && v !== null ? "[secret]" : maskSecrets(v)]));
  }
  return value;
}
