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
  '{"type":"form","config":{"fields":[{"name":"email","label":"Email","type":"email","required":true}]}} (field types: text, email, number, textarea, datetime, resource).',
  'A datetime field needs "timezone" (an IANA name such as "Asia/Manila") and can set "slotMinutes"; times must be in the future and on the slot grid. A resource field takes one of the resources of the workspace (a therapist, a room); use {{trigger.<field>.name}} in messages. A delay can wait "until" a datetime field with "offsetSeconds" (e.g. -86400 for a day before); if that time has passed, the run ends at the delay unless it has an edge with "on": "late".',
  'A number field can set "min", "max" and "integer": true, e.g. {"name":"amount","label":"Amount","type":"number","required":true,"min":0.01}. Put limits on the field instead of adding condition steps that check them; a submission outside the limits is refused before the workflow runs. A webhook trigger can list "fields" the same way to check incoming events, and set "eventKey" (such as "{{trigger.event_id}}") so a repeated event starts no second run.',
  'A condition comparing with gt, gte, lt or lte takes its "invalid" branch when a side is missing or not a number. Give it an "invalid" edge when bad data needs its own handling (such as manual review); without one, the run fails with a message.',
  'steps is a list of {"id","type","config"}. ids use a-z, 0-9 and _. The config of each step type follows this JSON Schema:',
  JSON.stringify(stepJsonSchemas()),
  'edges is a list of {"from","to"} and, from a branching step, "on": ' +
    Object.entries(BRANCHES)
      .map(([type, labels]) => `${type} has ${labels!.map((l) => `"${l}"`).join(", ")}`)
      .join("; ") +
    ". Each branch label and each non-branching step has at most one outgoing edge. No cycles. The first step is the one no edge points to.",
  "A sheets step adds a row to the owner's connected Google Sheet; a slack step posts to their connected Slack channel. An outlook step sends an email (to, subject, text) from their connected Outlook mailbox; a teams step posts text to their connected Teams channel. Keep names, emails and other private details out of slack and teams text.",
  "Text fields can use {{trigger.<field>}} and {{steps.<id>.output.<path>}}. An ai step with task classify outputs {label}, so a condition reads {{steps.<id>.output.label}}.",
  'An http POST or PATCH is sent once: when its outcome is unknown (a timeout or a 5xx), the run waits for a person instead of resending. Set "idempotent": true only when the request names an API that is safe to call twice with the same request.',
  'Give an approval step an edge for each of "approved", "rejected" and "timeout", so the requester is told either way, and make sure every label of a classify step reaches a step.',
  "Use real-looking placeholders such as you@example.com when the request gives no address. Keep steps to what was asked.",
  "Mock test runs in Daloy fake every email, HTTP call, approval and connected app, and the tester can pick AI labels and approval outcomes, so never add dry-run flags, test fields or branches for testing.",
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
