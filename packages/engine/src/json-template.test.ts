import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { ExpressionError } from "./expressions";
import { JSON_TEMPLATE_MAX_OUTPUT_LENGTH, parseJsonTemplate, resolveJsonTemplate, saveProblems } from "./json-template";

const ctx = (trigger: unknown) => ({ trigger, steps: {} });
const resolve = (body: string, trigger: unknown) => {
  const parsed = parseJsonTemplate(body);
  if (!parsed.ok) throw new Error(parsed.error);
  return JSON.parse(resolveJsonTemplate(parsed, ctx(trigger))) as unknown;
};

describe("JSON body templates", () => {
  it("keeps quotes, newlines, backslashes and an injection attempt inside one string", () => {
    const note = 'He said "hi"\nC:\\files", "admin": true, "x": "';
    expect(resolve('{"content": "Lead: {{trigger.note}}"}', { note })).toEqual({ content: `Lead: ${note}` });
  });

  it("treats an unquoted placeholder as one typed value, so it cannot add keys", () => {
    expect(resolve('{"amount":{{trigger.amount}}}', { amount: 40 })).toEqual({ amount: 40 });
    expect(resolve('{"amount":{{trigger.amount}}}', { amount: '1,"admin":true' })).toEqual({ amount: '1,"admin":true' });
    expect(resolve('{"amount": {{ trigger.missing }} }', {})).toEqual({ amount: null });
    expect(resolve('{"items": [{{trigger.a}}, {{trigger.b}}]}', { a: 1, b: { c: true } })).toEqual({ items: [1, { c: true }] });
  });

  it("keeps the type of a quoted whole-value placeholder and reads saved bodies with line breaks in strings", () => {
    expect(resolve('{"amount": "{{trigger.amount}}"}', { amount: 7800 })).toEqual({ amount: 7800 });
    const discord = '{"content": "🚨 **URGENT LEAD**\nName: {{trigger.name}}\nBudget: ₱{{trigger.budget}}"}';
    expect(resolve(discord, { name: "Ana", budget: 40000 })).toEqual({ content: "🚨 **URGENT LEAD**\nName: Ana\nBudget: ₱40000" });
  });

  it("refuses templates that are not JSON with placeholders as values", () => {
    for (const bad of ['{"a": 1', '{{{trigger.x}}}', '{"a": {{trigger.x}} "b": 2}', "n={{trigger.x}}", '{"a": tru}']) {
      expect(parseJsonTemplate(bad).ok, bad).toBe(false);
    }
  });

  it("caps resolved JSON template output size (S4)", () => {
    const parsed = parseJsonTemplate('{"a":"{{trigger.a}}","b":"{{trigger.b}}"}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const chunk = "x".repeat(Math.floor(JSON_TEMPLATE_MAX_OUTPUT_LENGTH * 0.6));
    expect(() => resolveJsonTemplate(parsed, ctx({ a: chunk, b: chunk }))).toThrow(ExpressionError);
    expect(() => resolveJsonTemplate(parsed, ctx({ a: "ok", b: "ok" }))).not.toThrow();
  });
});

const def = (steps: unknown[]) =>
  definitionSchema.parse({ trigger: { type: "manual", config: {} }, steps, edges: steps.slice(1).map((s, i) => ({ from: (steps[i] as { id: string }).id, to: (s as { id: string }).id })) });
const http = (config: object) => ({ id: "call", type: "http", config: { method: "POST", headers: {}, ...config } });

describe("checks before a workflow is saved", () => {
  it("refuses a JSON body that will not parse when the request says it is JSON", () => {
    expect(saveProblems(def([http({ url: "https://a.example/x", headers: { "Content-Type": "application/json" }, body: '{"a": 1' })]))).toEqual([
      expect.stringContaining("steps.call.config.body"),
    ]);
    expect(saveProblems(def([http({ url: "https://a.example/x", headers: {}, body: "n={{trigger.x}}" })]))).toEqual([]);
  });

  it("keeps secrets to HTTP steps", () => {
    const email = { id: "mail", type: "email", config: { to: "me@example.com", subject: "s", text: "key {{ secrets.api_key }}" } };
    const ai = { id: "think", type: "ai", config: { task: "summarize", input: "{{secrets.api_key}}" } };
    expect(saveProblems(def([email, ai]))).toEqual([expect.stringContaining("steps.mail"), expect.stringContaining("steps.think")]);
  });

  it("refuses a request that sends a secret to an address built from trigger or step data", () => {
    const header = { Authorization: "Bearer {{secrets.api_key}}" };
    for (const url of ["https://{{trigger.host}}/x", "https://api.example.com{{trigger.path}}", "{{trigger.url}}", "https://api.example.com:{{trigger.port}}/x"]) {
      expect(saveProblems(def([http({ url, headers: header })])), url).toEqual([expect.stringContaining("fixed address")]);
    }
    for (const url of ["https://api.example.com/x/{{trigger.id}}", "https://api.example.com?id={{trigger.id}}", "{{secrets.webhook_url}}", "https://{{secrets.host}}/x"]) {
      expect(saveProblems(def([http({ url, headers: header })])), url).toEqual([]);
    }
    expect(saveProblems(def([http({ url: "https://{{trigger.host}}/x" })]))).toEqual([]);
  });
});
