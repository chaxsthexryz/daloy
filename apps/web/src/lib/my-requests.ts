export type RequestKind = "done" | "problem" | "working" | "idle";

const STATUS: Record<string, { label: string; kind: RequestKind }> = {
  pending: { label: "Received", kind: "idle" },
  running: { label: "In progress", kind: "working" },
  waiting: { label: "Waiting", kind: "working" },
  needs_review: { label: "Needs review", kind: "working" },
  succeeded: { label: "Succeeded", kind: "done" },
  failed: { label: "Failed", kind: "problem" },
  cancelled: { label: "Cancelled", kind: "idle" },
};

/** The words and pill colour for a run state on My requests. An unknown state shows as it came. */
export function requestStatus(state: string): { label: string; kind: RequestKind } {
  return STATUS[state] ?? { label: state, kind: "idle" };
}

/** "Nov 19, 2:41 PM": when a request was sent, without the year. */
export function sentOn(iso: string, language: "en" | "tl"): string {
  return new Date(iso).toLocaleString(language === "tl" ? "fil-PH" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
