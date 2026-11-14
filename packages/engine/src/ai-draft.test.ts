import { describe, expect, it } from "vitest";
import { draftPrompt, parseDraftReply } from "./ai-draft";
import { TEMPLATES } from "./templates";

const triage = TEMPLATES[0]!.definition;
const reply = (o: unknown) => JSON.stringify(o);

describe("draftPrompt", () => {
  it("describes every step type and keeps the request out of the system prompt", () => {
    const { system, messages } = draftPrompt({ request: "Thank people who fill my contact form" });
    for (const type of ["http", "email", "condition", "delay", "ai", "approval"]) expect(system).toContain(`"${type}"`);
    expect(system).toContain("{{trigger.");
    expect(system).not.toContain("contact form");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain("Thank people who fill my contact form");
  });

  it("sends the current draft along when asked to change it", () => {
    const { messages } = draftPrompt({ request: "Wait a day first", current: triage });
    expect(messages[0]!.content).toContain('"classify"');
    expect(messages[0]!.content).toContain("Wait a day first");
  });

  it("stays small enough for a local model's default context", () => {
    const { system, messages } = draftPrompt({ request: "x", current: triage });
    // About 4 characters a token; Ollama's default context is 4,096 tokens and the reply needs room too.
    expect((system.length + messages[0]!.content.length) / 4).toBeLessThan(3000);
  });
});

describe("parseDraftReply", () => {
  it("accepts a valid draft", () => {
    const r = parseDraftReply(reply({ name: "Inquiry triage", summary: "Sorts inquiries.", definition: triage }));
    expect(r).toMatchObject({ ok: true, name: "Inquiry triage", summary: "Sorts inquiries." });
  });

  it("accepts JSON inside a code fence with text around it", () => {
    const r = parseDraftReply("Here you go:\n```json\n" + reply({ name: "T", summary: "S", definition: triage }) + "\n```\nDone.");
    expect(r.ok).toBe(true);
  });

  it("tells the model about number limits and the invalid branch, and keeps them in a draft", () => {
    const { system } = draftPrompt({ request: "x" });
    expect(system).toContain('"min"');
    expect(system).toContain('"invalid"');
    expect(system).toContain('"eventKey"');
    const definition = {
      trigger: { type: "form", config: { fields: [{ name: "amount", label: "Amount", type: "number", required: true, min: 0.01, max: 100_000 }] } },
      steps: [
        { id: "big", type: "condition", config: { condition: { left: "{{trigger.amount}}", op: "gt", right: 5000 } } },
        { id: "a", type: "delay", config: { seconds: 1 } },
        { id: "b", type: "delay", config: { seconds: 1 } },
        { id: "c", type: "delay", config: { seconds: 1 } },
      ],
      edges: [
        { from: "big", to: "a", on: "true" },
        { from: "big", to: "b", on: "false" },
        { from: "big", to: "c", on: "invalid" },
      ],
    };
    const r = parseDraftReply(reply({ name: "Purchases", summary: "Routes purchases.", definition }));
    expect(r.ok && r.definition.trigger).toMatchObject({ config: { fields: [{ min: 0.01, max: 100_000 }] } });
    expect(r.ok && r.definition.edges.map((e) => e.on)).toEqual(["true", "false", "invalid"]);
  });

  it("explains a reply that is not JSON", () => {
    expect(parseDraftReply("Sure! First you add a form...")).toEqual({ ok: false, errors: ["The reply was not a JSON object."] });
  });

  it("lists readable errors for an invalid definition", () => {
    const bad = {
      name: "Bad",
      summary: "x",
      definition: { trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "sms", config: {} }, { id: "b", type: "delay", config: { seconds: 5 } }], edges: [{ from: "b", to: "zzz" }] },
    };
    const r = parseDraftReply(reply(bad));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(/steps\.0\.type/);
  });

  it("catches graph errors such as a missing branch label", () => {
    const def = { trigger: { type: "manual", config: {} }, steps: [{ id: "c", type: "condition", config: { condition: { left: "1", op: "eq", right: "1" } } }, { id: "d", type: "delay", config: { seconds: 1 } }], edges: [{ from: "c", to: "d" }] };
    const r = parseDraftReply(reply({ name: "G", summary: "s", definition: def }));
    expect(r).toEqual({ ok: false, errors: [expect.stringContaining("needs a branch label")] });
  });

  it("needs a name and a summary", () => {
    expect(parseDraftReply(reply({ definition: triage })).ok).toBe(false);
  });
});
