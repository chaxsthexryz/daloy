import { and, eq } from "drizzle-orm";
import type { FileKind } from "@daloy/engine";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import { adminActions, aiKeys, aiSettings, platformAi, users } from "./schema";

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
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-flash", needsKey: true, baseUrl: "https://api.deepseek.com", models: [{ id: "deepseek-flash", free: false, note: "DeepSeek V4.1 Flash. Fast and low cost, paid per use." }] as Suggestion[] },
} as const;
export type Preset = keyof typeof PRESETS;

/** Only these plans may bring their own AI key (decision 0156). Everyone else uses the shared model. */
export const canUseOwnAiKey = (plan: string | null | undefined) => plan === "business" || plan === "business_plus" || plan === "concierge";
/** Thrown when a workspace on a lower plan tries to save a hosted provider. The API maps it to HTTP 403. */
export class OwnKeyNotAllowedError extends Error {
  constructor() {
    super("Your own AI key is available from the Business plan. Until then your workspace uses the shared AI model.");
  }
}
/** The plan of a workspace, for the own-key rule. */
export async function ownKeyAllowed(db: Db, userId: string): Promise<boolean> {
  const [u] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, userId));
  return canUseOwnAiKey(u?.plan);
}
export const PRESET_IDS = Object.keys(PRESETS) as [Preset, ...Preset[]];

// The file types a preset's model reads as images. Gemini reads HEIC natively; OpenAI does not. DeepSeek reads none.
const IMAGE_TYPES: Partial<Record<Preset, FileKind[]>> = {
  gemini: ["jpeg", "png", "webp", "heic"],
  openai: ["jpeg", "png", "webp"],
  openrouter: ["jpeg", "png", "webp"],
  // deepseek-flash reads images (its /models lists "image" input); checked with a real call on 2026-11-18.
  deepseek: ["jpeg", "png", "webp"],
};

export type AiConnection = { imageTypes?: FileKind[]; provider: string; baseUrl: string; apiKey?: string; model: string; extraBody?: Record<string, unknown>; reasoningTokens?: number; jsonMode?: "schema" | "object" };

/** How much a model may think before it answers, set per workspace (decision 0150). */
export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
// Thinking counts against max_tokens, so each level adds room for it on top of the caller's answer budget.
const THINKING_TOKENS: Record<ThinkingLevel, number> = { off: 0, low: 2048, medium: 4096, high: 8192 };
// DeepSeek's effort names: it has no "medium", and "max" is its highest.
const DEEPSEEK_EFFORT: Record<Exclude<ThinkingLevel, "off">, string> = { low: "low", medium: "high", high: "max" };

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|host\.docker\.internal)$/;
/** A model on this machine or an Ollama server, which gets the short Build with AI prompt (decision 0106). */
export function isLocalModel(conn: Pick<AiConnection, "provider" | "baseUrl">): boolean {
  if (conn.provider === "ollama") return true;
  try {
    return LOCAL_HOST.test(new URL(conn.baseUrl).hostname);
  } catch {
    return true;
  }
}

/**
 * The request fields that set a model's thinking for each host. Only known hosts get them, because hosted APIs may
 * reject fields they do not know, and "off" sends what was sent before the setting existed.
 * - A local llama.cpp or vLLM server (Qwen 3.5 and similar): the chat template switch.
 * - The Gemini API: Gemini 3 and newer cannot turn thinking off, so "off" asks for "low", which every model accepts.
 * - DeepSeek: thinking on or off, plus its own effort names. Its thinking mode keeps json_object output.
 * - OpenRouter: its reasoning object. OpenAI: reasoning_effort, which a non-reasoning model may refuse with HTTP 400.
 */
export function thinkingControl(provider: string, baseUrl: string, level: ThinkingLevel = "off"): Pick<AiConnection, "extraBody" | "reasoningTokens" | "jsonMode"> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return {};
  }
  if (provider !== "openai") return {};
  const room = level === "off" ? {} : { reasoningTokens: THINKING_TOKENS[level] };
  if (LOCAL_HOST.test(host)) return { extraBody: { chat_template_kwargs: { enable_thinking: level !== "off" } }, ...room };
  if (host === "generativelanguage.googleapis.com") {
    const effort = level === "off" ? "low" : level;
    return { extraBody: { reasoning_effort: effort }, reasoningTokens: THINKING_TOKENS[effort] };
  }
  if (host === "api.deepseek.com") {
    if (level === "off") return { extraBody: { thinking: { type: "disabled" } }, jsonMode: "object" };
    return { extraBody: { thinking: { type: "enabled" }, reasoning_effort: DEEPSEEK_EFFORT[level] }, ...room, jsonMode: "object" };
  }
  if (level === "off") return {};
  if (host === "openrouter.ai") return { extraBody: { reasoning: { effort: level } }, ...room };
  if (host === "api.openai.com") return { extraBody: { reasoning_effort: level }, ...room };
  return {};
}

/**
 * The operator's server from the env vars. LLM_API_KEY goes with it only when SHARED_LLM_KEY=open, so on a public
 * installation an account without its own key cannot spend the operator's (decision 0035). It also goes only to a
 * workspace with a plan, so a sign-up without one cannot spend it either.
 */
const env = (hasPlan = false): AiConnection => {
  const provider = process.env.LLM_PROVIDER || "ollama";
  const baseUrl = process.env.LLM_BASE_URL ?? "http://localhost:11434";
  const apiKey = hasPlan && process.env.SHARED_LLM_KEY === "open" ? process.env.LLM_API_KEY || undefined : undefined;
  return { provider, baseUrl, apiKey, model: process.env.LLM_MODEL || "llama3.2", ...thinkingControl(provider, baseUrl),
    // A local model may be text only, so the operator opts in to images.
    imageTypes: process.env.LLM_VISION === "on" ? ["jpeg", "png", "webp"] : undefined,
  };
};

// The preset is part of the associated data, so a key saved for one provider never decrypts as another's.
const keyName = (preset: string) => `ai_api_key:${preset}`;

/** The local server from the env vars, for listing its models. */
export const localConnection = () => env();

const savedKey = async (db: Db, userId: string, preset: string) =>
  (await db.select().from(aiKeys).where(and(eq(aiKeys.userId, userId), eq(aiKeys.preset, preset))))[0];

/** What the console shows: the choice in use and which providers have a saved key. The keys never leave the database. */
export async function readAiSettings(db: Db, userId: string) {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId));
  if (!row) return null;
  const keys = (await db.select({ preset: aiKeys.preset }).from(aiKeys).where(eq(aiKeys.userId, userId))).map((k) => k.preset as Preset);
  return { preset: row.preset as Preset, model: row.model, thinking: row.thinking as ThinkingLevel, hasKey: keys.includes(row.preset as Preset), keys };
}

/**
 * Saves the user's choice. A new apiKey replaces that provider's key; without one, the provider's saved key is used.
 * Without a thinking level the saved one stays ("off" for a first save).
 */
export async function saveAiSettings(db: Db, secretsKey: Buffer, userId: string, input: { preset: Preset; model: string; apiKey?: string; thinking?: ThinkingLevel }) {
  const preset = PRESETS[input.preset];
  if (input.preset !== "local" && !(await ownKeyAllowed(db, userId))) throw new OwnKeyNotAllowedError();
  if (preset.needsKey && !input.apiKey && !(await savedKey(db, userId, input.preset))) throw new Error(`${preset.label} needs an API key`);
  await db.transaction(async (tx) => {
    if (preset.needsKey && input.apiKey) {
      const e = encryptSecret(secretsKey, userId, keyName(input.preset), input.apiKey);
      const key = { keyCiphertext: e.ciphertext, keyIv: e.iv, keyAuthTag: e.authTag, updatedAt: new Date() };
      await tx.insert(aiKeys).values({ userId, preset: input.preset, ...key }).onConflictDoUpdate({ target: [aiKeys.userId, aiKeys.preset], set: key });
    }
    const values = { preset: input.preset, model: input.model, ...(input.thinking && { thinking: input.thinking }), updatedAt: new Date() };
    await tx.insert(aiSettings).values({ userId, ...values }).onConflictDoUpdate({ target: aiSettings.userId, set: values });
  });
}

const PLATFORM_AAD_OWNER = "platform";
const PLATFORM_KEY_NAME = "platform_ai_key";

/** The shared model the admin set, without its key. Null: the env vars decide. */
export async function readPlatformAi(db: Db) {
  const [row] = await db.select().from(platformAi);
  return row ? { preset: row.preset as Preset, model: row.model, thinking: row.thinking as ThinkingLevel, hasKey: row.keyCiphertext !== null, keyLast4: row.keyLast4 } : null;
}

/**
 * Saves the shared model (decision 0151) and records it in admin_actions, in one transaction. A new apiKey replaces the
 * saved one. Without one the saved key stays, but only for the same provider: a key belongs to one preset. The audit
 * row says whether the key changed, never the key. Without a thinking level the saved one stays ("off" the first time).
 */
export async function savePlatformAi(db: Db, secretsKey: Buffer, adminEmail: string, input: { preset: Preset; model: string; apiKey?: string; thinking?: ThinkingLevel }) {
  const preset = PRESETS[input.preset];
  await db.transaction(async (tx) => {
    const [old] = await tx.select().from(platformAi).for("update");
    const keptKey = old && old.preset === input.preset && old.keyCiphertext !== null;
    if (preset.needsKey && !input.apiKey && !keptKey) throw new Error(`${preset.label} needs an API key`);
    const thinking = input.thinking ?? (old?.thinking as ThinkingLevel | undefined) ?? "off";
    let key: Pick<typeof platformAi.$inferInsert, "keyCiphertext" | "keyIv" | "keyAuthTag" | "keyLast4"> = { keyCiphertext: null, keyIv: null, keyAuthTag: null, keyLast4: null };
    if (preset.needsKey && input.apiKey) {
      const e = encryptSecret(secretsKey, PLATFORM_AAD_OWNER, PLATFORM_KEY_NAME, input.apiKey);
      key = { keyCiphertext: e.ciphertext, keyIv: e.iv, keyAuthTag: e.authTag, keyLast4: input.apiKey.slice(-4) };
    } else if (preset.needsKey && old) {
      key = { keyCiphertext: old.keyCiphertext, keyIv: old.keyIv, keyAuthTag: old.keyAuthTag, keyLast4: old.keyLast4 };
    }
    const values = { id: 1, preset: input.preset, model: input.model, thinking, ...key, updatedAt: new Date() };
    await tx.insert(platformAi).values(values).onConflictDoUpdate({ target: platformAi.id, set: values });
    await tx.insert(adminActions).values({
      adminEmail,
      action: "ai",
      before: old ? { preset: old.preset, model: old.model, thinking: old.thinking, hasKey: old.keyCiphertext !== null } : {},
      after: { preset: input.preset, model: input.model, thinking, hasKey: key.keyCiphertext !== null, keyChanged: Boolean(preset.needsKey && input.apiKey) },
    });
  });
}

/**
 * The shared connection, for a workspace on `plan` (null: none) whose admin override is `override`. With a shared model
 * saved it is that model; without, the env vars. The shared key goes only to a workspace with a plan other than
 * "preview", and, as for the env key, only with SHARED_LLM_KEY=open (decisions 0035 and 0151).
 */
export async function sharedConnection(db: Db, secretsKey: Buffer, plan: string | null, override: ThinkingLevel | null): Promise<AiConnection> {
  const hasPlan = plan !== null && plan !== "preview";
  const [row] = await db.select().from(platformAi);
  if (!row) return env(hasPlan);
  const thinking = override ?? (row.thinking as ThinkingLevel);
  if (row.preset === "local") {
    const conn = env(hasPlan);
    return { ...conn, model: row.model, ...thinkingControl(conn.provider, conn.baseUrl, thinking) };
  }
  const preset = PRESETS[row.preset as Exclude<Preset, "local">];
  const shareKey = hasPlan && process.env.SHARED_LLM_KEY === "open" && row.keyCiphertext !== null && row.keyIv !== null && row.keyAuthTag !== null;
  const apiKey = shareKey ? decryptSecret(secretsKey, PLATFORM_AAD_OWNER, PLATFORM_KEY_NAME, { ciphertext: row.keyCiphertext!, iv: row.keyIv!, authTag: row.keyAuthTag! }) : undefined;
  return { provider: "openai", baseUrl: preset.baseUrl, apiKey, model: row.model, imageTypes: IMAGE_TYPES[row.preset as Preset], ...thinkingControl("openai", preset.baseUrl, thinking) };
}

/** Where the AI step of this user's workflows sends its requests. */
export async function aiConnection(db: Db, secretsKey: Buffer, userId: string): Promise<AiConnection> {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId));
  const [u] = await db.select({ plan: users.plan, thinking: users.aiThinking }).from(users).where(eq(users.id, userId));
  const shared = () => sharedConnection(db, secretsKey, u?.plan ?? null, (u?.thinking ?? null) as ThinkingLevel | null);
  // A lower plan uses the shared model whatever it saved. Its rows and keys stay, so an upgrade restores them (decision 0156).
  if (!row || !canUseOwnAiKey(u?.plan)) return shared();
  const thinking = row.thinking as ThinkingLevel;
  if (row.preset === "local") {
    const conn = await shared();
    // With a shared model saved, "Local model" means that model with the admin's thinking level (decision 0151).
    if ((await readPlatformAi(db)) !== null) return conn;
    // shared() carries the "off" fields; every higher level sets the same fields or more, so it replaces them all.
    return { ...conn, model: row.model, ...thinkingControl(conn.provider, conn.baseUrl, thinking) };
  }
  const preset = PRESETS[row.preset as Exclude<Preset, "local">];
  const key = await savedKey(db, userId, row.preset);
  if (!key) throw new Error(`${preset.label} has no saved API key`);
  const apiKey = decryptSecret(secretsKey, userId, keyName(row.preset), { ciphertext: key.keyCiphertext, iv: key.keyIv, authTag: key.keyAuthTag });
  return { provider: "openai", baseUrl: preset.baseUrl, apiKey, model: row.model, imageTypes: IMAGE_TYPES[row.preset as Preset], ...thinkingControl("openai", preset.baseUrl, thinking) };
}

/**
 * A preset's connection before anything is saved: the key just typed, or the one already saved for that preset. The
 * console uses it to ask the provider which model names it offers, and to check a name before it is saved.
 */
export async function presetConnection(db: Db, secretsKey: Buffer, userId: string, preset: Exclude<Preset, "local">, apiKey?: string): Promise<AiConnection> {
  const p = PRESETS[preset];
  let key = apiKey;
  if (!key) {
    const row = await savedKey(db, userId, preset);
    if (!row) throw new Error(`${p.label} has no saved API key`);
    key = decryptSecret(secretsKey, userId, keyName(preset), { ciphertext: row.keyCiphertext, iv: row.keyIv, authTag: row.keyAuthTag });
  }
  return { provider: "openai", baseUrl: p.baseUrl, apiKey: key, model: "", ...thinkingControl("openai", p.baseUrl) };
}
