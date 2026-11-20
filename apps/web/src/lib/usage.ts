import type { Meter, Usage } from "../api";
import { translate } from "./locale";

type Translator = (source: string, values?: Record<string, string | number>) => string;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-12-17" as "17 December". Read as text so the device's time zone cannot move the day. */
export const day = (iso: string, t: Translator = (source, values) => translate("en", source, values)) => {
  const [, m = 1, d = 1] = iso.split("-").map(Number);
  return `${d} ${t(MONTHS[m - 1] ?? "")}`;
};
/** "2026-12-01" as "1 Dec 2026", or "1 Dec" without the year (the Settings frames). */
export const shortDay = (iso: string, withYear = true) => {
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]?.slice(0, 3) ?? ""}${withYear ? ` ${y}` : ""}`;
};

const METERS = [
  { key: "ai", what: "AI actions", period: "", stopped: "Steps that need AI stop" },
  { key: "sms", what: "SMS messages", period: "", stopped: "Steps that send SMS stop" },
  { key: "email", what: "emails", period: " today", stopped: "Steps that send email stop" },
  { key: "http", what: "web requests", period: " today", stopped: "Steps that call a website stop" },
] as const;

const meterLine = (m: Meter | undefined, what: string, period: string, stopped: string, t: Translator) => {
  if (!m || m.limit === null || m.limit === 0 || m.used < m.limit * 0.8) return null;
  const subject = what.charAt(0).toUpperCase() + what.slice(1);
  return m.used >= m.limit
    ? t("{subject} are used up until {day}. {stopped}, and you can press Retry on those runs then.", { subject: t(subject), day: day(m.resetsOn, t), stopped: t(stopped) })
    : t("You have used {used} of {limit} {what}{period}. They come back on {day}.", { used: m.used, limit: m.limit, what: t(what), period: t(period), day: day(m.resetsOn, t) });
};

/** The notices to show: nothing below 80% of a limit, a quiet line from 80%, and what has stopped at 100%. */
export function usageLines(u: Usage, t: Translator = (source, values) => translate("en", source, values)): string[] {
  const lines = METERS.map(({ key, what, period, stopped }) => meterLine(u[key], what, period, stopped, t));
  const { live, limit } = u.automations;
  if (limit !== null && live >= limit * 0.8) {
    lines.push(t(live >= limit ? "You have {live} of {limit} live automations. Publishing another needs a larger plan." : "You have {live} of {limit} live automations.", { live, limit }));
  }
  return lines.filter((l): l is string => l !== null);
}
