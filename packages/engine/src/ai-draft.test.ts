import { describe, expect, it } from "vitest";
import { draftPrompt, extractJson, parseDraftReply } from "./ai-draft";
import { TEMPLATES } from "./templates";

const triage = TEMPLATES[0]!.definition;
const reply = (o: unknown) => JSON.stringify(o);

describe("draftPrompt", () => {
  it("describes every step type and keeps the request out of the system prompt", () => {
    const { system, messages } = draftPrompt({ request: "Thank people who fill my contact form" });
    for (const type of ["http", "email", "condition", "delay", "ai", "approval"]) expect(system).toContain(`"${type}"`);
    expect(system).toContain("{{trigger.");
    expect(system).toContain('"idempotent": true');
    expect(system).not.toContain("contact form");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain("Thank people who fill my contact form");
  });

  it("sends the current draft along when asked to change it", () => {
    const { messages } = draftPrompt({ request: "Wait a day first", current: triage });
    expect(messages[0]!.content).toContain('"classify"');
    expect(messages[0]!.content).toContain("Wait a day first");
  });

  it("asks for an edge on every approval branch and classify label", () => {
    expect(draftPrompt({ request: "x" }).system).toMatch(/"approved", "rejected" and "timeout".*every label of a classify step/);
  });
  it("does not tell the model about the ai step's files setting, which only the owner adds", () => {
    expect(draftPrompt({ request: "x" }).system).not.toContain('"files"');
  });
  it("lists file fields and the drive step, and says the owner ticks the box that lets the AI read a file", () => {
    const { system } = draftPrompt({ request: "x" });
    expect(system).toMatch(/field types: [^)]*\bfile\b/);
    expect(system).toContain('"drive"');
    expect(system).toContain("Let the AI read these files");
    expect(system).not.toContain('"sms"');
  });
  it("stays small enough for a local model's default context", () => {
    const { system, messages } = draftPrompt({ request: "x", current: triage });
    // About 4 characters a token; Ollama's default context is 4,096 tokens and the reply needs room too.
    expect((system.length + messages[0]!.content.length) / 4).toBeLessThan(3100);
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
      definition: { trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "fax", config: {} }, { id: "b", type: "delay", config: { seconds: 5 } }], edges: [{ from: "b", to: "zzz" }] },
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

// Found by the AI stress test (decision 0106): a hosted model given only the short prompt built http and telegram steps
// for SMS, Messenger and Shopify requests, and replies with one "}" too many were thrown away.
describe("full prompt for hosted models", () => {
  it("adds the triggers and steps the short prompt leaves out", () => {
    const short = draftPrompt({ request: "x" }).system;
    const full = draftPrompt({ request: "x" }, true).system;
    for (const type of ["sms", "meta_reply", "discord", "shopify_create_product"]) {
      expect(short).not.toContain(`"${type}":{`);
      expect(full).toContain(`"${type}":{`);
    }
    for (const trigger of ["meta_dm", "payment", "shopify_order"]) expect(full).toContain(`{"type":"${trigger}"`);
    expect(full).toMatch(/Use telegram only when the person says Telegram/);
  });
});

describe("extractJson", () => {
  it("accepts a reply that closes the object once too often", () => {
    expect(extractJson('{"a":{"b":[1]}}}')).toEqual({ a: { b: [1] } });
    expect(extractJson('Here: {"a":1}} and }')).toEqual({ a: 1 });
  });

  it("still refuses text that holds no object", () => {
    expect(extractJson("no json here }")).toBeUndefined();
    expect(extractJson('{"a":')).toBeUndefined();
  });
});
