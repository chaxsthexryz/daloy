import type { Meter, Usage } from "../api";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-12-17" as "17 December". Read as text so the device's time zone cannot move the day. */
export const day = (iso: string) => {
  const [, m = 1, d = 1] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1] ?? ""}`;
};

const METERS = [
  { key: "ai", what: "AI actions", period: "", stopped: "Steps that need AI stop" },
  { key: "email", what: "emails", period: " today", stopped: "Steps that send email stop" },
  { key: "http", what: "web requests", period: " today", stopped: "Steps that call a website stop" },
] as const;

const meterLine = (m: Meter, what: string, period: string, stopped: string) => {
  if (m.limit === null || m.used < m.limit * 0.8) return null;
  const subject = what.charAt(0).toUpperCase() + what.slice(1);
  return m.used >= m.limit
    ? `${subject} are used up until ${day(m.resetsOn)}. ${stopped}, and you can press Retry on those runs then.`
    : `You have used ${m.used} of ${m.limit} ${what}${period}. They come back on ${day(m.resetsOn)}.`;
};

/** The notices to show: nothing below 80% of a limit, a quiet line from 80%, and what has stopped at 100%. */
export function usageLines(u: Usage): string[] {
  const lines = METERS.map(({ key, what, period, stopped }) => meterLine(u[key], what, period, stopped));
  const { live, limit } = u.automations;
  if (limit !== null && live >= limit * 0.8) {
    lines.push(live >= limit ? `You have ${live} of ${limit} live automations. Publishing another needs a larger plan.` : `You have ${live} of ${limit} live automations.`);
  }
  return lines.filter((l): l is string => l !== null);
}
