import type { Trigger } from "@daloy/engine";
import type { Draft } from "./graph";

/**
 * "Chat as your customer" (T8): the owner types as a customer, each message is an "ai" test run with a payload shaped
 * like the real webhook's, and the reply step's resolved text becomes the bot's bubble.
 */
const REPLY_STEP = { meta_dm: "meta_reply", whatsapp_message: "whatsapp_reply", telegram_message: "telegram" } as const;
export type ChatTrigger = Extract<Trigger, { type: keyof typeof REPLY_STEP }>;

export const isChatTrigger = (trigger: Trigger): trigger is ChatTrigger => Object.hasOwn(REPLY_STEP, trigger.type);

/** True when any enabled step in the draft requires a published Knowledge sheet. */
export function needsPublishedKnowledge(draft: Draft): boolean {
  return draft.steps.some((s) => !s.disabled && ((s.type === "ai" && s.config.task === "answer") || s.type === "stay_quote"));
}

/** Only pending or waiting runs can be cancelled without a 409 Conflict. */
export function canCancelChatRun(run: { state: string } | null): boolean {
  return run !== null && (run.state === "pending" || run.state === "waiting");
}

export type ChatTurn = { direction: "in" | "out"; text: string };
type Row = { stepId: string; state: string; branch: string | null; input: unknown; output: unknown; error: string | null; createdAt: string };
/** The part of a run the chat reads. */
export type ChatRun = { state: string; needsReview: boolean; error: string | null; steps: Row[] };

/**
 * The trigger data for one message, with the same fields the webhook sends (apps/api/src/public.ts) and a test
 * conversation whose history is the chat so far plus this message, as C1 records it, so an `answer` step sees it.
 */
export function chatPayload(trigger: ChatTrigger, text: string, earlier: ChatTurn[], n: number, now = new Date().toISOString()) {
  const conversation = { id: "test", status: "bot", fields: {}, openDueId: null, history: [...earlier, { direction: "in", text }].map((h) => ({ ...h, at: now })) };
  if (trigger.type === "telegram_message")
    return { chatId: "test-customer", chatType: "private", fromId: "test-customer", fromName: "Test customer", username: "test_customer", messageId: n, updateId: n, date: now, text, fileRefused: false, conversation };
  const channel = trigger.type === "whatsapp_message" ? "whatsapp" : trigger.config.channel === "instagram" ? "instagram" : "messenger";
  return { channel, senderId: "test-customer", ...(trigger.type === "whatsapp_message" ? { senderName: "Test customer" } : {}), messageId: `test-${n}`, text, timestamp: now, image: [], conversation };
}

const DONE = new Set(["succeeded", "failed", "cancelled", "waiting", "needs_review"]);
const textOf = (v: unknown) => {
  const o = (v ?? {}) as { text?: unknown; templateName?: unknown };
  return typeof o.text === "string" && o.text !== "" ? o.text : typeof o.templateName === "string" ? `[${o.templateName}]` : null;
};

/**
 * What the bot "said": the newest reply step that succeeded, or, when none did, the steps the run went through (each
 * once, with its branch) and its error. "pending" while the run still moves.
 */
export function chatReply(draft: Draft, run: ChatRun | null): { kind: "pending" } | { kind: "reply"; text: string } | { kind: "path"; steps: string[]; error: string | null } {
  if (!run || !(DONE.has(run.state) || run.needsReview)) return { kind: "pending" };
  const replyType = isChatTrigger(draft.trigger) ? REPLY_STEP[draft.trigger.type] : null;
  const rows = [...run.steps].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const replies = rows.filter((r) => r.state === "succeeded" && draft.steps.find((s) => s.id === r.stepId)?.type === replyType);
  const said = replies.map((r) => textOf(r.output) ?? textOf(r.input)).filter((t) => t !== null).at(-1);
  if (said !== undefined) return { kind: "reply", text: said };
  const latest = new Map<string, Row>();
  for (const r of rows) latest.set(r.stepId, r);
  const steps = [...latest.values()].map((r) => r.stepId + (r.state === "failed" ? " (failed)" : r.branch ? ` (${r.branch})` : ""));
  return { kind: "path", steps, error: run.error };
}

/** The error of an AI step that failed in this run (no model reachable, no key, the AI limit), or null. */
export function aiFailure(draft: Draft, run: ChatRun | null): string | null {
  const failed = run?.steps.find((r) => r.state === "failed" && draft.steps.find((s) => s.id === r.stepId)?.type === "ai");
  return failed ? (failed.error ?? "the AI step failed") : null;
}
