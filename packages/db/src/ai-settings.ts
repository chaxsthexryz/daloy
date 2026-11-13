import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import { aiSettings } from "./schema";

/**
 * The AI models a user can pick in the console. Hosted ones have a fixed URL, so a user cannot point the server at an
 * internal host. "local" is whatever the operator configured in the env vars (Ollama on the host by default).
 */
export const PRESETS = {
  local: { label: "Local model", defaultModel: "llama3.2", needsKey: false },
  gemini: { label: "Gemini API", defaultModel: "gemini-3.8-flash", needsKey: true, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  openai: { label: "OpenAI", defaultModel: "", needsKey: true, baseUrl: "https://api.openai.com/v1" },
  openrouter: { label: "OpenRouter", defaultModel: "", needsKey: true, baseUrl: "https://openrouter.ai/api/v1" },
} as const;
export type Preset = keyof typeof PRESETS;
export const PRESET_IDS = Object.keys(PRESETS) as [Preset, ...Preset[]];

export type AiConnection = { provider: string; baseUrl: string; apiKey?: string; model: string };

const env = () => ({
  provider: process.env.LLM_PROVIDER || "ollama",
  baseUrl: process.env.LLM_BASE_URL ?? "http://localhost:11434",
  apiKey: process.env.LLM_API_KEY || undefined,
  model: process.env.LLM_MODEL || "llama3.2",
});

// The preset is part of the associated data, so a key saved for one provider never decrypts as another's.
const keyName = (preset: string) => `ai_api_key:${preset}`;

/** What the console shows. The key itself never leaves the database. */
export async function readAiSettings(db: Db, userId: string) {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId));
  return row ? { preset: row.preset as Preset, model: row.model, hasKey: row.keyCiphertext !== null } : null;
}

/** Saves the user's choice. Without apiKey, the saved key is kept if it belongs to the same preset. */
export async function saveAiSettings(db: Db, secretsKey: Buffer, userId: string, input: { preset: Preset; model: string; apiKey?: string }) {
  const preset = PRESETS[input.preset];
  const [old] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId));
  let key: { keyCiphertext: string | null; keyIv: string | null; keyAuthTag: string | null } = { keyCiphertext: null, keyIv: null, keyAuthTag: null };
  if (preset.needsKey) {
    if (input.apiKey) {
      const e = encryptSecret(secretsKey, userId, keyName(input.preset), input.apiKey);
      key = { keyCiphertext: e.ciphertext, keyIv: e.iv, keyAuthTag: e.authTag };
    } else if (old?.preset === input.preset && old.keyCiphertext) {
      key = { keyCiphertext: old.keyCiphertext, keyIv: old.keyIv, keyAuthTag: old.keyAuthTag };
    } else {
      throw new Error(`${preset.label} needs an API key`);
    }
  }
  const values = { preset: input.preset, model: input.model, ...key, updatedAt: new Date() };
  await db.insert(aiSettings).values({ userId, ...values }).onConflictDoUpdate({ target: aiSettings.userId, set: values });
}

/** Where the AI step of this user's workflows sends its requests. */
export async function aiConnection(db: Db, secretsKey: Buffer, userId: string): Promise<AiConnection> {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId));
  if (!row) return env();
  if (row.preset === "local") return { ...env(), model: row.model };
  const preset = PRESETS[row.preset as Exclude<Preset, "local">];
  const apiKey = decryptSecret(secretsKey, userId, keyName(row.preset), { ciphertext: row.keyCiphertext!, iv: row.keyIv!, authTag: row.keyAuthTag! });
  return { provider: "openai", baseUrl: preset.baseUrl, apiKey, model: row.model };
}
