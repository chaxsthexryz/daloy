import { describe, expect, it } from "vitest";
import { approvalWanted, askedCount, connectedApps, MAX_MESSAGES, wire, type Turn } from "./ai-chat";

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
