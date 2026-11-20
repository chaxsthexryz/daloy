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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 Nov 2026" in the device's time zone. Fixed month names, so the text matches the frames in every browser locale. */
export const shortDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

/** "10:14 AM" in the device's time zone. */
export const shortTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
};

/** True when `iso` falls on the same local calendar day as `now`. */
export const isToday = (iso: string, now = new Date()) => new Date(iso).toDateString() === now.toDateString();

/** "3 Sep 2026, 10:14 AM". */
export const shortDateTime = (iso: string) => `${shortDate(iso)}, ${shortTime(iso)}`;
