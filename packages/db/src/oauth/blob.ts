import { ProviderError } from "../providers";

/**
 * The plaintext of an OAuth connection's credential. accessExpiresAt is epoch ms, null for a token that does not expire.
 * Plaintext tokens exist only in memory here; they never go into a log line, an error, a run, a payload or a prompt.
 */
export type TokenBlob = { v: 1; accessToken: string; accessExpiresAt: number | null; refreshToken?: string; prevRefreshToken?: string; scope: string };

/** Outlook connections made before decision 0058 store the bare refresh token: read as an expired blob, rewritten on refresh. */
export function readTokenBlob(credential: string, opts?: { allowBare?: boolean }): TokenBlob {
  try {
    const b = JSON.parse(credential) as Partial<TokenBlob> | null;
    if (b && typeof b === "object" && b.v === 1 && typeof b.accessToken === "string") return b as TokenBlob;
  } catch {
    // not JSON
  }
  if (opts?.allowBare) return { v: 1, accessToken: "", accessExpiresAt: 0, refreshToken: credential, scope: "" };
  throw new ProviderError("Stored OAuth credential is not a valid token blob.", "invalid");
}

/** Every token value in a credential, for the history hider. */
export const blobTokens = (credential: string, opts?: { allowBare?: boolean }) => {
  const b = readTokenBlob(credential, opts);
  return [b.accessToken, b.refreshToken, b.prevRefreshToken].filter((t): t is string => !!t);
};
