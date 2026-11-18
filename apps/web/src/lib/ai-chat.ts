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
