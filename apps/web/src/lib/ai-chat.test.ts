import { describe, expect, it } from "vitest";
import { approvalWanted, askedCount, chatStep, connectedApps, MAX_MESSAGES, wire, type ChatState, type Draft, type Turn } from "./ai-chat";

const turn = (role: "user" | "assistant", text: string): Turn => ({ role, text });

describe("wire", () => {
  it("sends the words as roles and content, in order", () => {
    expect(wire([turn("user", "Thanks people"), turn("assistant", "What starts it?")])).toEqual([
      { role: "user", content: "Thanks people" },
      { role: "assistant", content: "What starts it?" },
    ]);
  });

  it("keeps the last twenty messages, because the route refuses more", () => {
    const many = Array.from({ length: 25 }, (_, i) => turn("user", `m${i}`));
    const sent = wire(many);
    expect(sent).toHaveLength(MAX_MESSAGES);
    expect(sent[0]!.content).toBe("m5");
    expect(sent.at(-1)!.content).toBe("m24");
  });

  it("never sends the choices, and keeps the text", () => {
    expect(wire([{ role: "assistant", text: "What starts it?", choices: ["A form"] }])).toEqual([{ role: "assistant", content: "What starts it?" }]);
  });
});

describe("askedCount and connectedApps", () => {
  it("counts the answers already given", () => {
    expect(askedCount([turn("user", "a"), turn("assistant", "q1"), turn("user", "b"), turn("assistant", "q2")])).toBe(2);
  });

  it("names only the apps the workspace connected, in a fixed order", () => {
    expect(connectedApps(new Set(["teams", "google_sheets"]))).toEqual(["google_sheets", "teams"]);
    expect(connectedApps(new Set(["dropbox"]))).toEqual([]);
  });
});

describe("approvalWanted", () => {
  it("spots a request that asks for approval, in the person's own words", () => {
    expect(approvalWanted([turn("user", "Ask me before it sends")])).toBe(false);
    expect(approvalWanted([turn("user", "My boss needs to approve it first")])).toBe(true);
    expect(approvalWanted([turn("user", "I sign off on every purchase")])).toBe(true);
    // Only the person's words count, not the model's question.
    expect(approvalWanted([turn("assistant", "Does someone approve this?")])).toBe(false);
  });
});

describe("chatStep", () => {
  const draft = { name: "Thank-you", summary: "Emails a thank-you.", definition: { steps: [] }, warnings: [] } as unknown as Draft;
  const start: ChatState = { phase: "idle", turns: [], draft: null, error: "" };
  const drafted = (warnings: string[] = []) => chatStep(chatStep(start, { type: "send", text: "thank people" }), { type: "reply", reply: { kind: "draft", ...draft, warnings } });

  it("a draft with zero warnings still stops at the summary, never turning on", () => {
    const s = drafted([]);
    expect(s.phase).toBe("summary");
    expect(s.draft).toEqual(draft);
    expect(s.turns.at(-1)!.role).toBe("assistant");
  });

  it("only turnOn reaches turning-on, and only from the summary", () => {
    expect(chatStep(drafted(), { type: "turnOn" }).phase).toBe("turning-on");
    const asking = chatStep(chatStep(start, { type: "send", text: "x" }), { type: "reply", reply: { kind: "question", text: "When?", choices: ["A"] } });
    for (const s of [start, chatStep(start, { type: "send", text: "x" }), asking]) expect(chatStep(s, { type: "turnOn" })).toBe(s);
    expect(chatStep(drafted(), { type: "turnedOn" }).phase).toBe("summary");
    expect(chatStep(chatStep(drafted(), { type: "turnOn" }), { type: "turnedOn" }).phase).toBe("on");
  });

  it("goes asking, send, thinking, draft, summary", () => {
    const asking = chatStep(chatStep(start, { type: "send", text: "x" }), { type: "reply", reply: { kind: "question", text: "When?", choices: ["A form"] } });
    expect(asking.phase).toBe("asking");
    expect(asking.turns.at(-1)).toEqual({ role: "assistant", text: "When?", choices: ["A form"] });
    const thinking = chatStep(asking, { type: "send", text: "A form" });
    expect(thinking.phase).toBe("thinking");
    expect(chatStep(thinking, { type: "reply", reply: { kind: "draft", ...draft } }).phase).toBe("summary");
  });

  it("a failed turn-on goes back to the summary with the draft and the error", () => {
    const s = chatStep(chatStep(drafted(), { type: "turnOn" }), { type: "failed", message: "Slack is not connected" });
    expect(s).toMatchObject({ phase: "summary", error: "Slack is not connected" });
    expect(s.draft).toEqual(draft);
    expect(chatStep(chatStep(start, { type: "send", text: "x" }), { type: "failed", message: "down" }).phase).toBe("error");
    expect(chatStep(s, { type: "reset" })).toEqual(start);
  });

  it("restores failed logs in error phase and replaces a turn-1 failure on retry", () => {
    const restored = chatStep(start, { type: "restore", turns: [turn("user", "Resort concierge")], draft: null, status: "failed", error: "Service unavailable" });
    expect(restored).toEqual({ phase: "error", turns: [turn("user", "Resort concierge")], draft: null, error: "Service unavailable" });
    const retried = chatStep(restored, { type: "send", text: "New prompt" });
    expect(retried).toEqual({ phase: "thinking", turns: [turn("user", "New prompt")], draft: null, error: "" });
  });
});
