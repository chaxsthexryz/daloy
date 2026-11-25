import type { WorkflowDefinition } from "@daloy/engine";

/** One line in the Build with AI chat, as the page keeps it. The draft travels apart from these words. */
export type Turn = { role: "user" | "assistant"; text: string; choices?: string[] };
export type Draft = { name: string; summary: string; definition: WorkflowDefinition; warnings: string[] };

/** The app kinds the route accepts, so the page can name only those. */
export const CONNECTED_KINDS = ["google_sheets", "slack", "outlook", "teams"] as const;
/** The route takes at most 20 messages; older ones are dropped from the end of a long conversation. */
export const MAX_MESSAGES = 20;

export function wire(turns: Turn[]) {
  return turns.slice(-MAX_MESSAGES).map(({ role, text }) => ({ role, content: text }));
}

/** Questions already answered, which is what the route counts before it tells the model to stop asking. */
export function askedCount(turns: Turn[]) {
  return turns.filter((t) => t.role === "assistant").length;
}

export function connectedApps(connected: ReadonlySet<string>): string[] {
  return CONNECTED_KINDS.filter((kind) => connected.has(kind));
}

/** The one hint the ready-made fallback needs, read from what the person typed. */
export function approvalWanted(turns: Turn[]): boolean {
  return turns.some((turn) => turn.role === "user" && /approv|sign.?off/i.test(turn.text));
}

export type ChatPhase = "idle" | "thinking" | "asking" | "summary" | "turning-on" | "on" | "error";
export type ChatState = { phase: ChatPhase; turns: Turn[]; draft: Draft | null; error: string };
export type ChatReply = { kind: "question"; text: string; choices: string[] } | ({ kind: "draft" } & Draft);
export type ChatEvent =
  | { type: "send"; text: string }
  | { type: "reply"; reply: ChatReply }
  | { type: "turnOn" }
  | { type: "turnedOn" }
  | { type: "failed"; message: string }
  | { type: "reset" }
  | { type: "restore"; turns: Turn[]; draft: Draft | null; status?: "draft" | "saved" | "live" | "failed"; error?: string };

/** Nothing here turns an automation on by itself: a draft always lands in "summary", and only turnOn leaves it. */
export function chatStep(s: ChatState, e: ChatEvent): ChatState {
  const busy = s.phase === "thinking" || s.phase === "turning-on";
  switch (e.type) {
    case "send": {
      if (busy) return s;
      const freshError = s.phase === "error" && !s.draft && !s.turns.some((t) => t.role === "assistant");
      return {
        ...s,
        phase: "thinking",
        turns: freshError ? [{ role: "user", text: e.text }] : [...s.turns, { role: "user", text: e.text }],
        error: "",
      };
    }
    case "reply":
      if (s.phase !== "thinking") return s;
      if (e.reply.kind === "question") return { ...s, phase: "asking", turns: [...s.turns, { role: "assistant", text: e.reply.text, choices: e.reply.choices }] };
      return { ...s, phase: "summary", draft: { name: e.reply.name, summary: e.reply.summary, definition: e.reply.definition, warnings: e.reply.warnings }, turns: [...s.turns, { role: "assistant", text: e.reply.summary }] };
    case "turnOn":
      return s.phase === "summary" && s.draft ? { ...s, phase: "turning-on", error: "" } : s;
    case "turnedOn":
      return s.phase === "turning-on" ? { ...s, phase: "on" } : s;
    case "failed":
      if (s.phase === "turning-on") return { ...s, phase: "summary", error: e.message };
      return s.phase === "thinking" ? { ...s, phase: "error", error: e.message } : s;
    case "reset":
      return { phase: "idle", turns: [], draft: null, error: "" };
    case "restore":
      if (e.status === "failed" && !e.draft) {
        return { phase: "error", turns: e.turns, draft: null, error: e.error ?? "" };
      }
      return {
        phase: e.draft ? "summary" : e.turns.at(-1)?.role === "assistant" ? "asking" : "idle",
        turns: e.turns,
        draft: e.draft,
        error: "",
      };
  }
}
