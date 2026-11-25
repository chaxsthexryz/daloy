import { describe, expect, it } from "vitest";
import { aiFailure, chatPayload, chatReply, isChatTrigger, type ChatRun, type ChatTrigger } from "./chat-test";
import type { Draft } from "./graph";

const dm: ChatTrigger = { type: "meta_dm", config: { channel: "both", requireImage: false } };
const draft: Draft = {
  trigger: dm,
  steps: [
    { id: "answer", type: "ai", config: { task: "answer", input: "{{trigger.text}}" } },
    { id: "check", type: "condition", config: { condition: { left: "{{steps.answer.output.needsHuman}}", op: "eq", right: true } } },
    { id: "reply", type: "meta_reply", config: { recipientId: "{{trigger.senderId}}", channel: "{{trigger.channel}}", text: "{{steps.answer.output.reply}}" } },
  ],
  edges: [
    { from: "answer", to: "check" },
    { from: "check", to: "reply", on: "false" },
  ],
};
const row = (stepId: string, state: string, extra: Partial<ChatRun["steps"][number]> = {}) => ({ stepId, state, branch: null, input: null, output: null, error: null, createdAt: "2026-11-25T00:00:00Z", ...extra });
const run = (state: string, steps: ChatRun["steps"]): ChatRun => ({ state, needsReview: false, error: null, steps });

describe("chat as your customer", () => {
  it("knows the chat triggers", () => {
    expect(isChatTrigger(dm)).toBe(true);
    expect(isChatTrigger({ type: "telegram_message", config: { from: "anyone", requireFile: false } })).toBe(true);
    expect(isChatTrigger({ type: "manual", config: {} })).toBe(false);
  });

  it("builds a Messenger payload like the webhook's, with the chat so far as conversation history", () => {
    const p = chatPayload(dm, "Magkano day tour?", [{ direction: "in", text: "Hi" }, { direction: "out", text: "Hello!" }], 3, "2026-11-25T01:00:00.000Z");
    expect(p).toEqual({
      channel: "messenger",
      senderId: "test-customer",
      messageId: "test-3",
      text: "Magkano day tour?",
      timestamp: "2026-11-25T01:00:00.000Z",
      image: [],
      conversation: {
        id: "test",
        status: "bot",
        fields: {},
        openDueId: null,
        history: [
          { direction: "in", text: "Hi", at: "2026-11-25T01:00:00.000Z" },
          { direction: "out", text: "Hello!", at: "2026-11-25T01:00:00.000Z" },
          { direction: "in", text: "Magkano day tour?", at: "2026-11-25T01:00:00.000Z" },
        ],
      },
    });
    expect(chatPayload({ type: "meta_dm", config: { channel: "instagram", requireImage: false } }, "hi", [], 1)).toMatchObject({ channel: "instagram" });
  });

  it("builds WhatsApp and Telegram payloads with their own sender fields", () => {
    const wa = chatPayload({ type: "whatsapp_message", config: { requireImage: false } }, "hi", [], 1);
    expect(wa).toMatchObject({ channel: "whatsapp", senderId: "test-customer", text: "hi", image: [] });
    const tg = chatPayload({ type: "telegram_message", config: { from: "anyone", requireFile: false } }, "hi", [], 2);
    expect(tg).toMatchObject({ chatId: "test-customer", fromId: "test-customer", chatType: "private", messageId: 2, text: "hi", fileRefused: false });
    expect(tg.conversation.history).toHaveLength(1);
  });

  it("reads the reply step's resolved text from a finished run", () => {
    const r = run("succeeded", [row("answer", "succeeded"), row("check", "succeeded", { branch: "false" }), row("reply", "succeeded", { output: { mocked: true, text: "Day tour is 350 pesos." } })]);
    expect(chatReply(draft, r)).toEqual({ kind: "reply", text: "Day tour is 350 pesos." });
  });

  it("reads a Telegram step and a WhatsApp template as replies too", () => {
    const tg: Draft = { trigger: { type: "telegram_message", config: { from: "anyone", requireFile: false } }, steps: [{ id: "send", type: "telegram", config: { text: "{{trigger.text}}", chatId: "{{trigger.chatId}}" } }], edges: [] };
    expect(chatReply(tg, run("succeeded", [row("send", "succeeded", { input: { text: "Got it" }, output: { mocked: true } })]))).toEqual({ kind: "reply", text: "Got it" });
    const wa: Draft = { trigger: { type: "whatsapp_message", config: { requireImage: false } }, steps: [{ id: "tpl", type: "whatsapp_reply", config: { mode: "template", to: "{{trigger.senderId}}", templateName: "order_ready", templateLanguage: "en" } }], edges: [] };
    expect(chatReply(wa, run("succeeded", [row("tpl", "succeeded", { output: { mocked: true, mode: "template", templateName: "order_ready" } })]))).toEqual({ kind: "reply", text: "[order_ready]" });
  });

  it("says which path a run took when no reply step ran", () => {
    const r = run("succeeded", [row("answer", "succeeded"), row("check", "succeeded", { branch: "true", createdAt: "2026-11-25T00:00:01Z" })]);
    expect(chatReply(draft, r)).toEqual({ kind: "path", steps: ["answer", "check (true)"], error: null });
    const failed = { ...run("failed", [row("answer", "failed", { error: "model down" })]), error: "step answer: model down" };
    expect(chatReply(draft, failed)).toEqual({ kind: "path", steps: ["answer (failed)"], error: "step answer: model down" });
  });

  it("waits while the run is still going, and stops at a run that waits for a person", () => {
    expect(chatReply(draft, run("running", [row("answer", "succeeded")]))).toEqual({ kind: "pending" });
    expect(chatReply(draft, null)).toEqual({ kind: "pending" });
    expect(chatReply(draft, run("waiting", [row("answer", "succeeded")])).kind).toBe("path");
  });

  it("finds a failed AI step, so the chat can fall back to a mocked run", () => {
    expect(aiFailure(draft, run("pending", [row("answer", "failed", { error: "connect ECONNREFUSED" })]))).toBe("connect ECONNREFUSED");
    expect(aiFailure(draft, run("succeeded", [row("answer", "succeeded")]))).toBeNull();
    expect(aiFailure(draft, null)).toBeNull();
  });
});
