import { and, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import { aiKeys, aiSettings } from "./schema";

/**
 * The AI models a user can pick in the console. Hosted ones have a fixed URL, so a user cannot point the server at an
 * internal host. "local" is whatever the operator configured in the env vars (Ollama on the host by default).
 */
// Suggestions for the console, with a plain note each; any model name the provider knows also works. Gemini
// free-tier status and descriptions come from Google's pricing and models pages (read 2026-11-13).
type Suggestion = { id: string; free: boolean; note: string };
const LOCAL: Suggestion[] = [
  { id: "llama3.2", free: true, note: "Small (3B) and fast on most computers. Fine for classify steps; often gets Build with AI wrong." },
  { id: "hermes3", free: true, note: "Larger (8B) and better at following instructions. Needs more memory: run ollama pull hermes3 first." },
];
const GEMINI: Suggestion[] = [
  { id: "gemini-3.8-flash", free: true, note: "Built for agents and complex workflows. The best pick here for Build with AI." },
  { id: "gemini-3.6-flash", free: true, note: "Balances speed and quality for everyday tasks." },
  { id: "gemini-3.5-flash-lite", free: true, note: "Fastest and cheapest. Good for simple AI steps such as classify." },
  { id: "gemini-4-hydrogen", free: true, note: "Newer, tuned for speed in everyday coding and agent work. Not marked stable yet." },
];

export const PRESETS = {
  local: { label: "Local model", defaultModel: "llama3.2", needsKey: false, models: LOCAL },
  gemini: { label: "Gemini API", defaultModel: "gemini-3.8-flash", needsKey: true, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: GEMINI },
  openai: { label: "OpenAI", defaultModel: "", needsKey: true, baseUrl: "https://api.openai.com/v1", models: [] as Suggestion[] },
  openrouter: { label: "OpenRouter", defaultModel: "", needsKey: true, baseUrl: "https://openrouter.ai/api/v1", models: [] as Suggestion[] },
} as const;
export type Preset = keyof typeof PRESETS;
export const PRESET_IDS = Object.keys(PRESETS) as [Preset, ...Preset[]];

export type AiConnection = { provider: string; baseUrl: string; apiKey?: string; model: string; extraBody?: Record<string, unknown>; reasoningTokens?: number };

/**
 * Thinking models write hidden reasoning that counts against max_tokens, so a short budget can come back empty.
 * - A local llama.cpp or vLLM server (Qwen 3.5 and similar): the chat template switch turns thinking off. Only sent
 *   to this machine, because hosted APIs may reject fields they do not know.
 * - The Gemini API: Gemini 3 and newer cannot turn thinking off, so ask for "low" (every current model accepts it)
 *   and allow 2,048 extra tokens for it on top of each caller's answer budget.
 */
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|host\.docker\.internal)$/;
function thinkingControl(provider: string, baseUrl: string): Pick<AiConnection, "extraBody" | "reasoningTokens"> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return {};
  }
  if (provider !== "openai") return {};
  if (LOCAL_HOST.test(host)) return { extraBody: { chat_template_kwargs: { enable_thinking: false } } };
  if (host === "generativelanguage.googleapis.com") return { extraBody: { reasoning_effort: "low" }, reasoningTokens: 2048 };
  return {};
}

/**
 * The operator's server from the env vars. LLM_API_KEY goes with it only when SHARED_LLM_KEY=open, so on a public
 * installation an account without its own key cannot spend the operator's (decision 0035).
 */
const env = (): AiConnection => {
  const provider = process.env.LLM_PROVIDER || "ollama";
  const baseUrl = process.env.LLM_BASE_URL ?? "http://localhost:11434";
  const apiKey = process.env.SHARED_LLM_KEY === "open" ? process.env.LLM_API_KEY || undefined : undefined;
  return { provider, baseUrl, apiKey, model: process.env.LLM_MODEL || "llama3.2", ...thinkingControl(provider, baseUrl) };
};

// The preset is part of the associated data, so a key saved for one provider never decrypts as another's.
const keyName = (preset: string) => `ai_api_key:${preset}`;

/** The local server from the env vars, for listing its models. */
export const localConnection = env;

const savedKey = async (db: Db, userId: string, preset: string) =>
  (await db.select().from(aiKeys).where(and(eq(aiKeys.userId, userId), eq(aiKeys.preset, preset))))[0];

/** What the console shows: the choice in use and which providers have a saved key. The keys never leave the database. */
export async function readAiSettings(db: Db, userId: string) {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId));
  if (!row) return null;
  const keys = (await db.select({ preset: aiKeys.preset }).from(aiKeys).where(eq(aiKeys.userId, userId))).map((k) => k.preset as Preset);
  return { preset: row.preset as Preset, model: row.model, hasKey: keys.includes(row.preset as Preset), keys };
}

/** Saves the user's choice. A new apiKey replaces that provider's key; without one, the provider's saved key is used. */
export async function saveAiSettings(db: Db, secretsKey: Buffer, userId: string, input: { preset: Preset; model: string; apiKey?: string }) {
  const preset = PRESETS[input.preset];
  if (preset.needsKey && !input.apiKey && !(await savedKey(db, userId, input.preset))) throw new Error(`${preset.label} needs an API key`);
  await db.transaction(async (tx) => {
    if (preset.needsKey && input.apiKey) {
      const e = encryptSecret(secretsKey, userId, keyName(input.preset), input.apiKey);
      const key = { keyCiphertext: e.ciphertext, keyIv: e.iv, keyAuthTag: e.authTag, updatedAt: new Date() };
      await tx.insert(aiKeys).values({ userId, preset: input.preset, ...key }).onConflictDoUpdate({ target: [aiKeys.userId, aiKeys.preset], set: key });
    }
    const values = { preset: input.preset, model: input.model, updatedAt: new Date() };
    await tx.insert(aiSettings).values({ userId, ...values }).onConflictDoUpdate({ target: aiSettings.userId, set: values });
  });
}

/** Where the AI step of this user's workflows sends its requests. */
export async function aiConnection(db: Db, secretsKey: Buffer, userId: string): Promise<AiConnection> {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId));
  if (!row) return env();
  if (row.preset === "local") return { ...env(), model: row.model };
  const preset = PRESETS[row.preset as Exclude<Preset, "local">];
  const key = await savedKey(db, userId, row.preset);
  if (!key) throw new Error(`${preset.label} has no saved API key`);
  const apiKey = decryptSecret(secretsKey, userId, keyName(row.preset), { ciphertext: key.keyCiphertext, iv: key.keyIv, authTag: key.keyAuthTag });
  return { provider: "openai", baseUrl: preset.baseUrl, apiKey, model: row.model, ...thinkingControl("openai", preset.baseUrl) };
}
