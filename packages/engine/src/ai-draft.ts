import * as z from "zod";
import { BRANCHES, definitionSchema, type WorkflowDefinition } from "./definition";
import { stepJsonSchemas } from "./step-schemas";
import { TEMPLATES } from "./templates";

/**
 * Turning a plain-language request into a workflow draft (decision 0017). The model writes the whole definition as
 * JSON; the same definitionSchema as a hand-built workflow checks it. A draft is never saved or published by itself.
 */
const replySchema = z.object({ name: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(500), definition: definitionSchema });

export type DraftResult = { ok: true; name: string; summary: string; definition: WorkflowDefinition } | { ok: false; errors: string[] };

const example = TEMPLATES[0]!;

const SYSTEM = [
  "You build workflow definitions for Daloy, a workflow automation tool. Reply with one JSON object and nothing else:",
  '{"name": "<short workflow name>", "summary": "<one sentence on what the workflow does, or what you changed>", "definition": <definition>}',
  "",
  "A definition is {trigger, steps, edges}.",
  'trigger is one of: {"type":"manual","config":{}}, {"type":"webhook","config":{}}, {"type":"schedule","config":{"cron":"0 9 * * 1"}},',
  '{"type":"form","config":{"fields":[{"name":"email","label":"Email","type":"email","required":true}]}} (field types: text, email, number, textarea).',
  'steps is a list of {"id","type","config"}. ids use a-z, 0-9 and _. The config of each step type follows this JSON Schema:',
  JSON.stringify(stepJsonSchemas()),
  'edges is a list of {"from","to"} and, from a branching step, "on": ' +
    Object.entries(BRANCHES)
      .map(([type, labels]) => `${type} has ${labels!.map((l) => `"${l}"`).join(", ")}`)
      .join("; ") +
    ". Each branch label and each non-branching step has at most one outgoing edge. No cycles. The first step is the one no edge points to.",
  "Text fields can use {{trigger.<field>}} and {{steps.<id>.output.<path>}}. An ai step with task classify outputs {label}, so a condition reads {{steps.<id>.output.label}}.",
  "Use real-looking placeholders such as you@example.com when the request gives no address. Keep steps to what was asked.",
  "",
  `Example, for "${example.description}":`,
  JSON.stringify({ name: example.name, summary: example.description, definition: example.definition }),
].join("\n");

/** The request, and the current draft when changing one, go in the user message, never in the system prompt. */
export function draftPrompt(input: { request: string; current?: unknown }) {
  const content = input.current
    ? `Change this workflow definition:\n${JSON.stringify(input.current)}\n\nRequested change:\n${input.request}`
    : `Build a workflow for this request:\n${input.request}`;
  return { system: SYSTEM, messages: [{ role: "user" as const, content }] };
}

// The outermost {...} in the reply, so text or a code fence around the JSON does not matter.
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export function parseDraftReply(text: string): DraftResult {
  const json = extractJson(text);
  if (json === undefined || typeof json !== "object" || json === null) return { ok: false, errors: ["The reply was not a JSON object."] };
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 10).map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)) };
  return { ok: true, ...parsed.data };
}
