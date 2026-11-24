import type { WorkflowDefinition } from "./definition";
import { EXPRESSION_LIMITS, ExpressionError, resolveTemplate, type ExpressionContext } from "./expressions";

export const JSON_TEMPLATE_MAX_OUTPUT_LENGTH = EXPRESSION_LIMITS.maxOutputLength;

/*
 * HTTP bodies that are JSON (decision 0025). The template is parsed once, before any value is filled in, and the
 * result is serialised once, so form data can never change the structure: a quote, newline or `","admin":true` in a
 * value stays inside that value. A placeholder written without quotes is one typed value (a number stays a number,
 * text becomes one JSON string, missing becomes null). Raw line breaks typed inside strings are accepted, as people
 * write multi-line chat messages that way.
 */

export type JsonTemplate = { ok: true; value: unknown; slots: string[]; marker: string } | { ok: false; error: string };

const CONTROL: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

export function parseJsonTemplate(template: string): JsonTemplate {
  // A random marker, so no text in the template can pose as a typed slot.
  const marker = `\u0000${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("")}:`;
  const slots: string[] = [];
  let out = "";
  let inString = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    if (inString) {
      if (ch === "\\") {
        out += ch + (template[i + 1] ?? "");
        i++;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch < " ") {
        out += CONTROL[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      } else {
        out += ch;
      }
    } else if (ch === "{" && template[i + 1] === "{") {
      const end = template.indexOf("}}", i + 2);
      if (end < 0) return { ok: false, error: "a placeholder is missing its closing }}" };
      out += JSON.stringify(marker + slots.length);
      slots.push(template.slice(i, end + 2));
      i = end + 1;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  try {
    return { ok: true, value: JSON.parse(out), slots, marker };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Fills a parsed template: slots keep their type, placeholders inside strings resolve as text (a whole-string one keeps its type). */
export function resolveJsonTemplate(
  parsed: Extract<JsonTemplate, { ok: true }>,
  ctx: ExpressionContext,
  maxOutputLength = JSON_TEMPLATE_MAX_OUTPUT_LENGTH,
): string {
  let budget = 0;
  const charge = (n: number) => {
    budget += n;
    if (budget > maxOutputLength) throw new ExpressionError(`JSON body is larger than ${maxOutputLength} characters`);
  };
  const estimate = (v: unknown): number => {
    if (v === null || v === undefined) return 4;
    if (typeof v === "string") return v.length + 2;
    if (typeof v === "number" || typeof v === "boolean") return String(v).length;
    if (Array.isArray(v)) {
      let total = 2;
      for (const item of v) {
        total += estimate(item) + 1;
        if (budget + total > maxOutputLength) throw new ExpressionError(`JSON body is larger than ${maxOutputLength} characters`);
      }
      return total;
    }
    if (typeof v === "object") {
      let total = 2;
      for (const [k, val] of Object.entries(v)) {
        total += k.length + 4 + estimate(val);
        if (budget + total > maxOutputLength) throw new ExpressionError(`JSON body is larger than ${maxOutputLength} characters`);
      }
      return total;
    }
    return 4;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.startsWith(parsed.marker)) {
        const resolved = resolveTemplate(parsed.slots[Number(v.slice(parsed.marker.length))]!, ctx) ?? null;
        charge(estimate(resolved));
        return resolved;
      }
      const resolved = resolveTemplate(v, ctx) ?? "";
      charge(estimate(resolved));
      return resolved;
    }
    if (Array.isArray(v)) {
      charge(2 + v.length);
      return v.map(walk);
    }
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v);
      charge(2 + entries.length);
      return Object.fromEntries(
        entries.map(([k, x]) => {
          charge(k.length + 3);
          return [k, walk(x)];
        }),
      );
    }
    charge(String(v).length);
    return v;
  };
  const out = JSON.stringify(walk(parsed.value));
  if (out.length > maxOutputLength) throw new ExpressionError(`JSON body is larger than ${maxOutputLength} characters`);
  return out;
}

export const declaresJson = (headers: Record<string, string>) => Object.entries(headers).some(([k, v]) => k.toLowerCase() === "content-type" && /json/i.test(v));

const SECRET_REF = /\{\{\s*secrets\./;
/** True when any template in the value refers to {{secrets...}}. */
export const usesSecrets = (value: unknown) => SECRET_REF.test(JSON.stringify(value));
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/**
 * True when the request's destination could depend on trigger or step data: a placeholder that is not a secret before
 * the URL's path, query or fragment starts. A URL that starts with a secret is checked again when it runs.
 */
export function destinationFromData(url: string): boolean {
  let masked = "";
  let last = 0;
  for (const m of url.matchAll(PLACEHOLDER)) {
    masked += url.slice(last, m.index) + (SECRET_REF.test(m[0]) ? "S" : "\u0001").repeat(m[0].length);
    last = m.index + m[0].length;
  }
  masked += url.slice(last);
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(masked);
  if (!scheme) return masked.startsWith("\u0001");
  const rest = masked.slice(scheme[0].length);
  const end = rest.search(/[/?#]/);
  return (end < 0 ? rest : rest.slice(0, end)).includes("\u0001");
}

/**
 * Problems that stop a definition from being saved (decision 0025). Run on save only, so versions saved before these
 * rules still load; the worker applies the same rules when a step runs.
 */
export function saveProblems(def: WorkflowDefinition): string[] {
  const problems: string[] = [];
  for (const step of def.steps) {
    const at = `steps.${step.id}.config`;
    if (step.type !== "http") {
      if (usesSecrets(step.config)) problems.push(`${at}: secrets can only be used in HTTP steps, which send them to a fixed address`);
      continue;
    }
    const { url, headers, body } = step.config;
    if (body !== undefined && declaresJson(headers)) {
      const parsed = parseJsonTemplate(body);
      if (!parsed.ok) problems.push(`${at}.body: not valid JSON (${parsed.error}). Write placeholders as values, e.g. "{{trigger.amount}}" or {{trigger.amount}}.`);
    }
    if (usesSecrets(step.config) && destinationFromData(url)) {
      problems.push(`${at}.url: a request that uses a secret must go to a fixed address; move trigger and step data after the host, into the path or query`);
    }
  }
  return problems;
}
