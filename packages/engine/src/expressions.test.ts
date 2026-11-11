import { describe, expect, it } from "vitest";
import { evaluateCondition, ExpressionError, resolveTemplate, type ExpressionContext } from "./expressions";

const ctx: ExpressionContext = {
  trigger: { name: "Ana", amount: 120, tags: ["vip", "late"], nested: { deep: { value: true } }, count: "5" },
  steps: { classify: { output: { label: "billing", score: 0.9 } } },
};

describe("resolveTemplate", () => {
  it("returns plain strings unchanged", () => {
    expect(resolveTemplate("hello", ctx)).toBe("hello");
  });

  it("returns the raw value when the template is a single placeholder", () => {
    expect(resolveTemplate("{{trigger.amount}}", ctx)).toBe(120);
    expect(resolveTemplate("{{ trigger.tags }}", ctx)).toEqual(["vip", "late"]);
    expect(resolveTemplate("{{steps.classify.output}}", ctx)).toEqual({ label: "billing", score: 0.9 });
  });

  it("interpolates into strings", () => {
    expect(resolveTemplate("Hi {{trigger.name}}, label {{steps.classify.output.label}}", ctx)).toBe("Hi Ana, label billing");
    expect(resolveTemplate("tags: {{trigger.tags}}", ctx)).toBe('tags: ["vip","late"]');
  });

  it("reads array indexes and nested paths", () => {
    expect(resolveTemplate("{{trigger.tags.1}}", ctx)).toBe("late");
    expect(resolveTemplate("{{trigger.nested.deep.value}}", ctx)).toBe(true);
  });

  it("gives undefined for a missing path and an empty string inside text", () => {
    expect(resolveTemplate("{{trigger.missing.path}}", ctx)).toBeUndefined();
    expect(resolveTemplate("[{{trigger.missing}}]", ctx)).toBe("[]");
    expect(resolveTemplate("{{steps.unknown.output.x}}", ctx)).toBeUndefined();
  });

  it("does not reach inherited properties", () => {
    expect(resolveTemplate("{{trigger.toString}}", ctx)).toBeUndefined();
    expect(resolveTemplate("{{trigger.tags.map}}", ctx)).toBeUndefined();
  });

  it("rejects anything that is not a plain path", () => {
    for (const bad of [
      "{{trigger.constructor.constructor('return process')()}}",
      "{{trigger.__proto__}}",
      "{{trigger.constructor}}",
      "{{steps.classify.prototype}}",
      "{{process.env.SECRET}}",
      "{{steps.classify.input.x}}",
      "{{trigger.a+1}}",
      "{{trigger..a}}",
      "{{trigger['a']}}",
      "{{}}",
    ]) {
      expect(() => resolveTemplate(bad, ctx), bad).toThrow(ExpressionError);
    }
  });

  it("leaves unclosed braces as text", () => {
    expect(resolveTemplate("{{trigger.name", ctx)).toBe("{{trigger.name");
  });

  it("enforces size limits", () => {
    const limits = { maxTemplateLength: 50, maxPlaceholders: 2, maxPathDepth: 4, maxOutputLength: 20 };
    expect(() => resolveTemplate("x".repeat(51), ctx, limits)).toThrow(/too long/);
    expect(() => resolveTemplate("{{trigger.a}}{{trigger.a}}{{trigger.a}}", ctx, limits)).toThrow(/placeholders/);
    expect(() => resolveTemplate("{{trigger.a.b.c.d}}", ctx, limits)).toThrow(/deep/);
    expect(() => resolveTemplate("{{trigger.tags}} and more text", ctx, limits)).toThrow(/output/);
    expect(() => resolveTemplate("{{trigger}}", ctx, limits)).toThrow(/output/);
  });
});

describe("evaluateCondition", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["eq", "billing", true],
    ["eq", "support", false],
    ["neq", "support", true],
  ];
  it.each(cases)("label %s %s is %s", (op, right, expected) => {
    expect(evaluateCondition({ left: "{{steps.classify.output.label}}", op: op as "eq", right: right as string }, ctx)).toBe(expected);
  });

  it("compares numbers, including numeric strings from forms", () => {
    expect(evaluateCondition({ left: "{{trigger.amount}}", op: "gt", right: 100 }, ctx)).toBe(true);
    expect(evaluateCondition({ left: "{{trigger.amount}}", op: "lte", right: 100 }, ctx)).toBe(false);
    expect(evaluateCondition({ left: "{{trigger.count}}", op: "gte", right: 5 }, ctx)).toBe(true);
    expect(evaluateCondition({ left: "{{trigger.count}}", op: "eq", right: 5 }, ctx)).toBe(true);
    expect(evaluateCondition({ left: "{{trigger.name}}", op: "gt", right: 1 }, ctx)).toBe(false);
  });

  it("checks contains on strings and arrays", () => {
    expect(evaluateCondition({ left: "{{trigger.tags}}", op: "contains", right: "vip" }, ctx)).toBe(true);
    expect(evaluateCondition({ left: "{{trigger.name}}", op: "contains", right: "An" }, ctx)).toBe(true);
    expect(evaluateCondition({ left: "{{trigger.amount}}", op: "contains", right: "1" }, ctx)).toBe(false);
  });

  it("checks exists", () => {
    expect(evaluateCondition({ left: "{{trigger.name}}", op: "exists" }, ctx)).toBe(true);
    expect(evaluateCondition({ left: "{{trigger.missing}}", op: "exists" }, ctx)).toBe(false);
  });

  it("resolves templates on the right side", () => {
    expect(evaluateCondition({ left: "{{trigger.amount}}", op: "eq", right: "{{trigger.amount}}" }, ctx)).toBe(true);
  });
});
