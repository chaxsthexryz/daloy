/**
 * The plaintext of an OAuth connection's credential. accessExpiresAt is epoch ms, null for a token that does not expire.
 * Plaintext tokens exist only in memory here; they never go into a log line, an error, a run, a payload or a prompt.
 */
export type TokenBlob = { v: 1; accessToken: string; accessExpiresAt: number | null; refreshToken?: string; prevRefreshToken?: string; scope: string };

/** Outlook connections made before decision 0058 store the bare refresh token: read as an expired blob, rewritten on refresh. */
export function readTokenBlob(credential: string): TokenBlob {
  try {
    const b = JSON.parse(credential) as TokenBlob;
    if (b && b.v === 1) return b;
  } catch {
    // not JSON
  }
  return { v: 1, accessToken: "", accessExpiresAt: 0, refreshToken: credential, scope: "" };
}

/** Every token value in a credential, for the history hider. */
export const blobTokens = (credential: string) => {
  const b = readTokenBlob(credential);
  return [b.accessToken, b.refreshToken, b.prevRefreshToken].filter((t): t is string => !!t);
};
