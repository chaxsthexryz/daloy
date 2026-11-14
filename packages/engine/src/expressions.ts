import type { Condition } from "./definition";

/** secrets holds decrypted values by name. Only the worker fills it, right before a step runs. */
export type ExpressionContext = { trigger: unknown; steps: Record<string, { output: unknown }>; secrets?: Record<string, string> };

export const EXPRESSION_LIMITS = { maxTemplateLength: 10_000, maxPlaceholders: 50, maxPathDepth: 32, maxOutputLength: 100_000 };
export type ExpressionLimits = typeof EXPRESSION_LIMITS;

export class ExpressionError extends Error {
  override name = "ExpressionError";
}

// No nested braces inside a placeholder, so matching is linear in the template length.
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function parsePath(raw: string, limits: ExpressionLimits): string[] {
  const expr = raw.trim();
  const segs = expr.split(".");
  if (segs.length > limits.maxPathDepth) throw new ExpressionError(`Expression path is too deep: ${expr.slice(0, 80)}`);
  const valid =
    segs.every((s) => SEGMENT.test(s) && !FORBIDDEN.has(s)) &&
    (segs[0] === "trigger" || (segs[0] === "steps" && segs.length >= 3 && segs[2] === "output") || (segs[0] === "secrets" && segs.length === 2));
  if (!valid) throw new ExpressionError(`Invalid expression: ${expr.slice(0, 80)}`);
  return segs;
}

// Own properties only, so nothing on Object.prototype or Array.prototype is reachable.
function lookup(ctx: ExpressionContext, segs: string[]): unknown {
  let cur: unknown = ctx;
  for (const seg of segs) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, seg)) return undefined;
    // Read only, own keys only, and parsePath rejects __proto__, prototype and constructor.
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const stringify = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);

/**
 * Resolves {{trigger.<path>}}, {{steps.<id>.output.<path>}} and {{secrets.<name>}} in one pass, so a value
 * that itself contains "{{...}}" (for example from trigger data) is inserted as text and never resolved.
 * A template that is exactly one placeholder returns the raw value (number, object, ...); otherwise values are interpolated into text.
 */
export function resolveTemplate(template: string, ctx: ExpressionContext, limits: ExpressionLimits = EXPRESSION_LIMITS): unknown {
  if (template.length > limits.maxTemplateLength) throw new ExpressionError("Template is too long");
  const matches = [...template.matchAll(PLACEHOLDER)];
  if (matches.length > limits.maxPlaceholders) throw new ExpressionError("Template has too many placeholders");
  if (matches.length === 0) return template;

  const tooBig = () => new ExpressionError(`Expression output is larger than ${limits.maxOutputLength} characters`);

  if (matches.length === 1 && matches[0]![0] === template) {
    const value = lookup(ctx, parsePath(matches[0]![1]!, limits));
    if (stringify(value).length > limits.maxOutputLength) throw tooBig();
    return value;
  }

  let out = "";
  let last = 0;
  for (const m of matches) {
    out += template.slice(last, m.index) + stringify(lookup(ctx, parsePath(m[1]!, limits)));
    last = m.index + m[0].length;
    if (out.length > limits.maxOutputLength) throw tooBig();
  }
  out += template.slice(last);
  if (out.length > limits.maxOutputLength) throw tooBig();
  return out;
}

// Form fields arrive as strings, so "5" and 5 compare as numbers.
const toNumber = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "number" && typeof b !== "number") return false;
  const [x, y] = [toNumber(a), toNumber(b)];
  return !Number.isNaN(x) && x === y;
}

/** True or false; a comparison on a missing or non-number value counts as false here. */
export function evaluateCondition(cond: Condition, ctx: ExpressionContext): boolean {
  return conditionBranch(cond, ctx) === "true";
}

/**
 * The branch a condition step takes. gt, gte, lt and lte need a number on both sides; when a side is missing or not a
 * number the branch is "invalid", so bad data is never quietly sent down "false" (decision 0027).
 */
export function conditionBranch(cond: Condition, ctx: ExpressionContext): "true" | "false" | "invalid" {
  const result = compare(cond, ctx);
  return result === null ? "invalid" : result ? "true" : "false";
}

function compare(cond: Condition, ctx: ExpressionContext): boolean | null {
  const left = resolveTemplate(cond.left, ctx);
  const right = typeof cond.right === "string" ? resolveTemplate(cond.right, ctx) : cond.right;

  switch (cond.op) {
    case "exists":
      return left !== undefined && left !== null && left !== "";
    case "eq":
      return looseEqual(left, right);
    case "neq":
      return !looseEqual(left, right);
    case "contains":
      if (typeof left === "string") return (typeof right === "string" || typeof right === "number") && left.includes(String(right));
      return Array.isArray(left) && left.some((item) => looseEqual(item, right));
    default: {
      const [a, b] = [toNumber(left), toNumber(right)];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return cond.op === "gt" ? a > b : cond.op === "gte" ? a >= b : cond.op === "lt" ? a < b : a <= b;
    }
  }
}
