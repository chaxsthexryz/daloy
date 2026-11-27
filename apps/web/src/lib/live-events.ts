import type { ToastPayload } from "../Toast";

/** One event from GET /events (decision 0155): a pointer to a run or conversation and a short title, never content. */
export type LiveEvent = { kind: "run_succeeded" | "run_failed" | "conversation_new" | "handoff_requested"; id: string; title: string; at: string };
export type Notice = LiveEvent & { key: string; unread: boolean };
type T = (source: string, values?: Record<string, string | number>) => string;

export const MAX_NOTICES = 20;
const KINDS = new Set<string>(["run_succeeded", "run_failed", "conversation_new", "handoff_requested"]);

export function parseEvent(raw: string): LiveEvent | null {
  try {
    const e = JSON.parse(raw) as Partial<LiveEvent>;
    return typeof e.id === "string" && typeof e.title === "string" && typeof e.at === "string" && typeof e.kind === "string" && KINDS.has(e.kind) ? (e as LiveEvent) : null;
  } catch {
    return null;
  }
}

export const addNotice = (list: Notice[], e: LiveEvent, key: string): Notice[] => [{ ...e, key, unread: true }, ...list].slice(0, MAX_NOTICES);
export const unreadCount = (list: Notice[]) => list.filter((n) => n.unread).length;

const isRun = (e: LiveEvent) => e.kind === "run_succeeded" || e.kind === "run_failed";
export const noticeHref = (e: LiveEvent) => (isRun(e) ? `#/runs/${e.id}` : `#/conversations?c=${e.id}`);

/** The title is the automation's name for a run and the channel's name for a chat; the sentence around it is translated here. */
export function noticeText(e: LiveEvent, t: T): { title: string } {
  switch (e.kind) {
    case "run_succeeded": return { title: t("{name} ran and succeeded", { name: e.title }) };
    case "run_failed": return { title: t("{name} failed", { name: e.title }) };
    case "conversation_new": return { title: t("New chat on {channel}", { channel: e.title }) };
    case "handoff_requested": return { title: t("A guest asked for a person on {channel}", { channel: e.title }) };
  }
}

/** Only a handoff and a failure interrupt with a toast; the rest wait in the bell. A run's toast id matches the run poller's, so one run shows one toast. */
export function noticeToast(e: LiveEvent, t: T): ToastPayload | null {
  if (e.kind === "run_failed") return { id: `live-run-${e.id}`, tone: "error", message: noticeText(e, t).title, actionHref: noticeHref(e), actionLabel: t("View log"), durationMs: 6500 };
  if (e.kind === "handoff_requested") return { id: `handoff-${e.id}`, tone: "warn", message: noticeText(e, t).title, actionHref: noticeHref(e), actionLabel: t("Open"), durationMs: 8000 };
  return null;
}

export function ageText(at: string, now: number, t: T): string {
  const s = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (s < 60) return t("Just now");
  if (s < 3600) return t("{n} min ago", { n: Math.floor(s / 60) });
  if (s < 86_400) return t("{n} hr ago", { n: Math.floor(s / 3600) });
  return t("{n} days ago", { n: Math.floor(s / 86_400) });
}
