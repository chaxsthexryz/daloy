/** Counts and status labels for the Advanced pages (Doop rows W7 and W8). */
export type TokenStatus = "active" | "expired" | "revoked";

/** Revoked wins over expired: a revoked token stays revoked after its date passes. */
export function tokenStatus(token: { revokedAt: string | null; expiresAt: string | null }, now = new Date()): TokenStatus {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && new Date(token.expiresAt) < now) return "expired";
  return "active";
}

export const countActiveTokens = (tokens: { revokedAt: string | null; expiresAt: string | null }[], now = new Date()) => tokens.filter((x) => tokenStatus(x, now) === "active").length;

export const countResources = (list: { active: boolean }[]) => {
  const active = list.filter((r) => r.active).length;
  return { active, archived: list.length - active };
};
