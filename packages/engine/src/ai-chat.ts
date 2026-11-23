import * as z from "zod";
import { definitionExample, definitionSpec, extractJson } from "./ai-draft";
import { definitionSchema, type WorkflowDefinition } from "./definition";

/**
 * Build with AI as a conversation (decision 0048). The model answers with either one question or the whole draft, so
 * the console never has to guess which of the two a reply is. The draft goes through the same definitionSchema as a
 * hand-built workflow; a draft is never saved or published by itself.
 */
export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ChatResult =
  | { ok: true; kind: "question"; text: string; choices: string[] }
  | { ok: true; kind: "draft"; name: string; summary: string; definition: WorkflowDefinition }
  | { ok: false; errors: string[] };

/** Six questions, then the model has to draft. A conversation that only asks costs money and never finishes. */
export const MAX_QUESTIONS = 6;

const replySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("question"),
    text: z.string().trim().min(1).max(400),
    choices: z.array(z.string().trim().min(1).max(80)).max(6).optional(),
  }),
  z.object({
    kind: z.literal("draft"),
    name: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(500),
    definition: definitionSchema,
  }),
]);

// For a hosted model only, so the short prompt stays inside a local model's context. The AI stress test showed these
// cut questions from 93% of cases to about half (decision 0106).
const FULL_CHAT =
  "When the request says what starts it and what should happen, reply with the draft at once, with no question: fill smaller gaps (the wording of a message, a time, where else to record it) with sensible defaults and name them in the summary. Never ask what a form should collect, what a message or summary should say, or where else to record something. Draft when the person asks you to build it now, even when something is still open. When a message asks for no automation at all, ask what they want to automate instead of inventing one.";

const system = (full: boolean) => [
  "You help someone build an automation in Daloy by chatting. Reply with one JSON object and nothing else, one of:",
  '{"kind":"question","text":"<one short question>","choices":["<short answer>","<another answer>"]}',
  '{"kind":"draft","name":"<short automation name>","summary":"<one sentence>","definition":<definition>}',
  "",
  "Ask a question only when the answer changes the workflow: what starts it, who should know or decide, where a record or message goes (email, Daloy's request list, Google Sheet, Slack, Outlook, Teams), and how much, how often or when it runs. Ask one question at a time, in the person's own words, at most six in the whole conversation. Never ask something the person already said, and never ask for a password, API key, card number or other private data. Offer two to four short choices when the answer is one of a few, and leave choices out when it is open. When the description is complete, or the person asks you to build it now, reply with the draft. A typed answer is the answer even when it is not a choice: use it, move on, never ask the same question again. A sheets step adds one row per run, so for a grid (rows by time, columns by day) say so and offer one row per item. Never say you saved, published or turned anything on.",
  "The person chatting is owner@people.invalid; use that address in the draft and the console swaps in their real one. For anyone else, ask their name and use a placeholder address such as them@example.com.",
  "",
  definitionSpec(full),
  ...(full ? [FULL_CHAT] : []),
  "",
  definitionExample(),
].join("\n");

/**
 * The conversation, plus the draft being changed when there is one, plus the apps the workspace connected (fixed
 * names only, never text from the person). After six questions the last message tells the model to draft.
 */
export function chatPrompt(input: { messages: ChatMessage[]; current?: unknown; apps?: string[]; full?: boolean }) {
  const prompt = [system(input.full ?? false), `Apps connected: ${input.apps?.length ? input.apps.join(", ") : "none"}.`].join("\n");
  const messages: ChatMessage[] = input.messages.map((m) => ({ role: m.role, content: m.content }));
  if (input.current !== undefined) {
    messages.push({ role: "user", content: `The current draft is:\n${JSON.stringify(input.current)}\n\nChange it as the conversation asks, and keep the rest as it is.` });
  }
  if (input.messages.filter((m) => m.role === "assistant").length >= MAX_QUESTIONS) {
    messages.push({ role: "user", content: "Ask no more questions. Reply with the draft now, choosing sensible defaults for anything you do not know." });
  }
  return { system: prompt, messages };
}

export function parseChatReply(text: string): ChatResult {
  const json = extractJson(text);
  if (json === undefined || typeof json !== "object" || json === null) return { ok: false, errors: ["The reply was not a JSON object."] };
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 10).map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)) };
  if (parsed.data.kind === "question") return { ok: true, kind: "question", text: parsed.data.text, choices: parsed.data.choices ?? [] };
  const { name, summary, definition } = parsed.data;
  return { ok: true, kind: "draft", name, summary, definition };
}
