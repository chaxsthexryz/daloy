import type { WorkflowDefinition } from "./definition";
import { resolveTemplate, type ExpressionContext } from "./expressions";

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
export function resolveJsonTemplate(parsed: Extract<JsonTemplate, { ok: true }>, ctx: ExpressionContext): string {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.startsWith(parsed.marker)) return resolveTemplate(parsed.slots[Number(v.slice(parsed.marker.length))]!, ctx) ?? null;
      return resolveTemplate(v, ctx) ?? "";
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return JSON.stringify(walk(parsed.value));
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
