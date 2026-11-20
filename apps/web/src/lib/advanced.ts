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

/** "12 Nov 2026". The locale and zone are only passed by tests. */
export const shortDate = (iso: string, opts: { locale?: string; timeZone?: string } = {}) =>
  new Date(iso).toLocaleDateString(opts.locale, { day: "numeric", month: "short", year: "numeric", timeZone: opts.timeZone });

/** True when `iso` falls on the same local calendar day as `now`. */
export const isToday = (iso: string, now = new Date()) => new Date(iso).toDateString() === now.toDateString();
