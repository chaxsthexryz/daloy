import { describe, expect, it } from "vitest";
import { chatPrompt, MAX_QUESTIONS, parseChatReply, type ChatMessage } from "./ai-chat";
import { TEMPLATES } from "./templates";

const triage = TEMPLATES[0]!.definition;
const reply = (o: unknown) => JSON.stringify(o);
const said = (...texts: string[]): ChatMessage[] => texts.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));

describe("chatPrompt", () => {
  it("offers exactly two shapes and describes workflows in the same words as a draft", () => {
    const { system } = chatPrompt({ messages: [{ role: "user", content: "Thank people who fill my form" }] });
    expect(system).toContain('"kind":"question"');
    expect(system).toContain('"kind":"draft"');
    expect(system).toContain("{{trigger.");
    expect(system).toContain('"invalid"');
    // The person's words stay out of the system prompt.
    expect(system).not.toContain("Thank people who fill my form");
  });

  it("keeps questions bounded and forbids asking for private data", () => {
    const { system } = chatPrompt({ messages: [{ role: "user", content: "x" }] });
    expect(system).toMatch(/at most six in the whole conversation/);
    expect(system).toMatch(/never ask for a password, API key, card number/);
  });

  it("names the apps the workspace connected, and only those names", () => {
    expect(chatPrompt({ messages: [{ role: "user", content: "x" }], apps: ["google_sheets", "slack"] }).system).toContain("Apps connected: google_sheets, slack.");
    expect(chatPrompt({ messages: [{ role: "user", content: "x" }] }).system).toContain("Apps connected: none.");
  });

  it("sends the draft being changed apart from the conversation", () => {
    const { messages } = chatPrompt({ messages: said("Make a triage", "Which labels?"), current: triage });
    expect(messages).toHaveLength(3);
    expect(messages.at(-1)!.content).toContain("The current draft is:");
    expect(messages.at(-1)!.content).toContain('"classify"');
  });

  it("tells the model to draft after six questions", () => {
    const six = said("a", "q1", "b", "q2", "c", "q3", "d", "q4", "e", "q5", "f", "q6");
    expect(chatPrompt({ messages: six }).messages.at(-1)!.content).toMatch(/Ask no more questions/);
    const five = said("a", "q1", "b", "q2", "c", "q3", "d", "q4", "e", "q5");
    expect(chatPrompt({ messages: five }).messages.at(-1)!.content).toBe("q5");
    expect(MAX_QUESTIONS).toBe(6);
  });

  it("stays small enough for a local model's default context", () => {
    const { system, messages } = chatPrompt({ messages: said("x", "y"), current: triage });
    const size = system.length + messages.reduce((n, m) => n + m.content.length, 0);
    expect(size / 4).toBeLessThan(3400);
  });
});

describe("parseChatReply", () => {
  it("reads a question with choices", () => {
    expect(parseChatReply(reply({ kind: "question", text: "What starts it?", choices: ["Someone fills a form", "On a schedule"] }))).toEqual({
      ok: true,
      kind: "question",
      text: "What starts it?",
      choices: ["Someone fills a form", "On a schedule"],
    });
  });

  it("reads a question without choices as an open one", () => {
    expect(parseChatReply(reply({ kind: "question", text: "Who should be told?" }))).toMatchObject({ ok: true, kind: "question", choices: [] });
  });

  it("caps choices at six and refuses an empty question", () => {
    expect(parseChatReply(reply({ kind: "question", text: "Pick", choices: Array.from({ length: 7 }, (_, i) => `c${i}`) })).ok).toBe(false);
    expect(parseChatReply(reply({ kind: "question", text: "   " })).ok).toBe(false);
  });

  it("reads a draft, also inside a code fence with text around it", () => {
    const r = parseChatReply("Here:\n```json\n" + reply({ kind: "draft", name: "Triage", summary: "Sorts inquiries.", definition: triage }) + "\n```\nDone.");
    expect(r).toMatchObject({ ok: true, kind: "draft", name: "Triage", summary: "Sorts inquiries." });
  });

  it("explains a reply that is neither shape", () => {
    expect(parseChatReply("Sure! First you add a form...")).toEqual({ ok: false, errors: ["The reply was not a JSON object."] });
    expect(parseChatReply(reply({ kind: "note", text: "hi" })).ok).toBe(false);
  });

  it("lists readable errors for an invalid definition", () => {
    const bad = { kind: "draft", name: "Bad", summary: "x", definition: { trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "fax", config: {} }], edges: [] } };
    const r = parseChatReply(reply(bad));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(/steps\.0\.type/);
  });

  it("catches graph errors such as a missing branch label", () => {
    const def = {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "c", type: "condition", config: { condition: { left: "1", op: "eq", right: "1" } } },
        { id: "d", type: "delay", config: { seconds: 1 } },
      ],
      edges: [{ from: "c", to: "d" }],
    };
    expect(parseChatReply(reply({ kind: "draft", name: "G", summary: "s", definition: def }))).toEqual({ ok: false, errors: [expect.stringContaining("needs a branch label")] });
  });
});
