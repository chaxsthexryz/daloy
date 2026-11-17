import { takingLonger } from "./poll";
import type { Language } from "./locale";

/** What GET /workflows reports about a workflow's newest real (non-test) run. */
export type LastRun = {
  runId: string;
  state: string;
  createdAt: string;
  needsReview: boolean;
  deliveryFailed: boolean;
  superseded: boolean;
  /** The reference of the request that started it, for guided automations. */
  reference: string | null;
};

export type PlainState = { key: "done" | "waiting" | "needs_you" | "problem" | "working"; label: string; note?: string };

type RunLike = { state: string; createdAt: string; needsReview: boolean; deliveryFailed?: boolean; superseded?: boolean };

/**
 * The four owner-facing states (plus Working) for a run, from its raw state and its delivery and booking flags.
 * Order matters: a person who must act comes first, then a problem, then a booking change, then the wait.
 */
export function plainState(r: RunLike, now = Date.now()): PlainState {
  if (r.needsReview || r.state === "needs_review") return { key: "needs_you", label: "Needs you" };
  if (r.state === "failed" || r.deliveryFailed) return { key: "problem", label: "Problem" };
  if (r.superseded) return { key: "done", label: "Done", note: "Closed: its booking changed" };
  if (r.state === "waiting") return { key: "waiting", label: "Waiting", note: "Waiting for a time or an approval" };
  if (r.state === "succeeded") return { key: "done", label: "Done" };
  if (r.state === "cancelled") return { key: "done", label: "Done", note: "Closed" };
  return { key: "working", label: "Working", note: takingLonger(r.createdAt, now) ? "Taking longer than usual" : undefined };
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago", "2 months ago". */
export function ago(iso: string, now = Date.now(), language: Language = "en"): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const unit = (n: number, word: string) => language === "tl" ? `${n} ${({ minute: "minuto", hour: "oras", day: "araw", month: "buwan" } as Record<string, string>)[word]} ang nakalipas` : `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return language === "tl" ? "kakaunti pa lang" : "just now";
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86400) return unit(Math.floor(s / 3600), "hour");
  if (s < 30 * 86400) return unit(Math.floor(s / 86400), "day");
  return unit(Math.floor(s / (30 * 86400)), "month");
}

/** The last thing that happened, in a sentence. */
export const lastEvent = (last: LastRun | null, now = Date.now(), language: Language = "en") =>
  !last ? (language === "tl" ? "Wala pang aktibidad" : "No activity yet") : language === "tl"
    ? last.reference ? `Natanggap ang request ${last.reference} ${ago(last.createdAt, now, language)}` : `Huling tumakbo ${ago(last.createdAt, now, language)}`
    : last.reference ? `Request ${last.reference} received ${ago(last.createdAt, now)}` : `Last ran ${ago(last.createdAt, now)}`;

/** Owner wording for a run's kind. The old labels ("test run, mocked calls") stay in the technician block. */
export const runKind = (r: { test: boolean; live: boolean; aiLive?: boolean }) =>
  r.test ? (r.live ? "Preview with real calls" : r.aiLive ? "Preview with real AI, other calls mocked" : "Preview (nothing sent)") : "Real run";

/** A run error as the owner sees it: the worker's "step <id>: " prefix stays in the technician details. */
export const ownerError = (error: string) => error.replace(/^step [^:]+: /, "");

/** The page that fixes a failed run, read from the error text the steps and providers write (null when it cannot tell). */
export function fixFor(error: string): { href: string; label: string } | null {
  if (/gmail|mail server/i.test(error)) return { href: "#/apps", label: "Connect Gmail" };
  if (/google sheets|service account|slack|outlook|teams|telegram|microsoft/i.test(error)) return { href: "#/apps", label: "Check the connection" };
  if (/api key|ai model/i.test(error)) return { href: "#/settings/ai", label: "Check the AI model" };
  return null;
}
