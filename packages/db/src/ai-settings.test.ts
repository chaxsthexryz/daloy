import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { aiConnection, canUseOwnAiKey, OwnKeyNotAllowedError, presetConnection, readAiSettings, readPlatformAi, saveAiSettings, savePlatformAi, sharedConnection, thinkingControl, THINKING_LEVELS } from "./ai-settings";
import { decryptSecret } from "./crypto";
import { eq } from "drizzle-orm";
import { adminActions, aiKeys, aiSettings, platformAi, users } from "./schema";
import type { Db } from "./index";

let db: Db;
let pool: Pool;
const key = randomBytes(32);
let seq = 0;
const newUser = async (plan: "pilot" | "preview" | "business" | "business_plus" | "concierge" | null = "business") => (await db.insert(users).values({ email: `ai${++seq}@test.local`, passwordHash: "x", plan }).returning())[0]!.id;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);
afterAll(async () => {
  await pool?.end();
});
afterEach(() => vi.unstubAllEnvs());

it("falls back to the env vars when the user saved nothing, without the operator's key", async () => {
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_BASE_URL", "http://lmstudio.local:1234/v1");
  vi.stubEnv("LLM_API_KEY", "env-key");
  vi.stubEnv("LLM_MODEL", "qwen");
  vi.stubEnv("SHARED_LLM_KEY", "");
  expect(await aiConnection(db, key, await newUser())).toEqual({ provider: "openai", baseUrl: "http://lmstudio.local:1234/v1", apiKey: undefined, model: "qwen" });
});

it("sends the operator's key for the env connection only with SHARED_LLM_KEY=open", async () => {
  vi.stubEnv("LLM_API_KEY", "env-key");
  const userId = await newUser();
  for (const value of ["", "off", "OPEN", "yes"]) {
    vi.stubEnv("SHARED_LLM_KEY", value);
    expect((await aiConnection(db, key, userId)).apiKey, value).toBeUndefined();
  }
  vi.stubEnv("SHARED_LLM_KEY", "open");
  expect((await aiConnection(db, key, userId)).apiKey).toBe("env-key");
  // The "Local model" preset is the same env connection, so it follows the same rule.
  await saveAiSettings(db, key, userId, { preset: "local", model: "llama3.2" });
  expect((await aiConnection(db, key, userId)).apiKey).toBe("env-key");
  vi.stubEnv("SHARED_LLM_KEY", "off");
  expect((await aiConnection(db, key, userId)).apiKey).toBeUndefined();
});

it("keeps the operator's key from a workspace without a plan, and leaves its own key and a local model alone", async () => {
  vi.stubEnv("LLM_API_KEY", "env-key");
  vi.stubEnv("SHARED_LLM_KEY", "open");
  const userId = await newUser(null);
  expect((await aiConnection(db, key, userId)).apiKey).toBeUndefined();
  await saveAiSettings(db, key, userId, { preset: "local", model: "llama3.2" });
  expect((await aiConnection(db, key, userId)).apiKey).toBeUndefined();
  await db.update(users).set({ plan: "business" }).where(eq(users.id, userId));
  await saveAiSettings(db, key, userId, { preset: "openai", model: "gpt-x", apiKey: "sk-own" });
  expect((await aiConnection(db, key, userId)).apiKey).toBe("sk-own");
  await saveAiSettings(db, key, userId, { preset: "local", model: "llama3.2" });
  expect((await aiConnection(db, key, userId)).apiKey).toBe("env-key");
});

it("allows an own key only on Business, Business Plus and Concierge", () => {
  for (const plan of ["business", "business_plus", "concierge"]) expect(canUseOwnAiKey(plan), plan).toBe(true);
  for (const plan of ["preview", "pilot", null, undefined, "unknown"]) expect(canUseOwnAiKey(plan), String(plan)).toBe(false);
});

it("refuses a hosted choice on a lower plan but still saves the local one", async () => {
  for (const plan of ["preview", "pilot", null] as const) {
    const userId = await newUser(plan);
    await expect(saveAiSettings(db, key, userId, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-test" }), String(plan)).rejects.toBeInstanceOf(OwnKeyNotAllowedError);
    await expect(saveAiSettings(db, key, userId, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-test" })).rejects.toThrow(/Business plan/);
    expect(await readAiSettings(db, userId)).toBeNull();
    expect(await db.select().from(aiKeys).where(eq(aiKeys.userId, userId))).toHaveLength(0);
    await saveAiSettings(db, key, userId, { preset: "local", model: "llama3.2" });
    expect(await readAiSettings(db, userId)).toMatchObject({ preset: "local" });
  }
  for (const plan of ["business", "business_plus", "concierge"] as const) {
    await saveAiSettings(db, key, await newUser(plan), { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-test" });
  }
});

it("sends a lower plan with a saved hosted choice to the shared model, and gives the keys back on upgrade", async () => {
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_BASE_URL", "http://lmstudio.local:1234/v1");
  vi.stubEnv("LLM_MODEL", "shared-qwen");
  vi.stubEnv("SHARED_LLM_KEY", "");
  await pool.query("delete from platform_ai");
  for (const plan of ["pilot", "preview", null] as const) {
    const userId = await newUser("business");
    await saveAiSettings(db, key, userId, { preset: "deepseek", model: "deepseek-flash", apiKey: "sk-own", thinking: "high" });
    await db.update(users).set({ plan }).where(eq(users.id, userId));
    expect(await aiConnection(db, key, userId), String(plan)).toMatchObject({ baseUrl: "http://lmstudio.local:1234/v1", apiKey: undefined, model: "shared-qwen" });
    // Nothing was deleted or changed, so the page can still show what was saved.
    expect(await readAiSettings(db, userId)).toMatchObject({ preset: "deepseek", model: "deepseek-flash", thinking: "high", keys: ["deepseek"] });
    await db.update(users).set({ plan: "business" }).where(eq(users.id, userId));
    expect(await aiConnection(db, key, userId)).toMatchObject({ baseUrl: "https://api.deepseek.com", apiKey: "sk-own", model: "deepseek-flash" });
  }
  // With a shared model saved by the admin, that model is used, with the admin's thinking override.
  await savePlatformAi(db, key, ADMIN, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-platform-1234" });
  const lower = await newUser("business");
  await saveAiSettings(db, key, lower, { preset: "deepseek", model: "deepseek-flash", apiKey: "sk-own" });
  await db.update(users).set({ plan: "pilot", aiThinking: "medium" }).where(eq(users.id, lower));
  expect(await aiConnection(db, key, lower)).toMatchObject({ baseUrl: GEMINI_URL, model: "gemini-3.8-flash", ...thinkingControl("openai", GEMINI_URL, "medium") });
  await pool.query("delete from platform_ai");
});

it("sends a lower plan with a saved local choice to the shared model too, and keeps the row", async () => {
  vi.stubEnv("LLM_MODEL", "shared-model");
  await pool.query("delete from platform_ai");
  const userId = await newUser("pilot");
  await saveAiSettings(db, key, userId, { preset: "local", model: "hermes3", thinking: "high" });
  expect(await aiConnection(db, key, userId)).toMatchObject({ model: "shared-model" });
  expect(await readAiSettings(db, userId)).toMatchObject({ preset: "local", model: "hermes3" });
});

it("keeps the operator's key from a preview workspace", async () => {
  vi.stubEnv("LLM_API_KEY", "env-key");
  vi.stubEnv("SHARED_LLM_KEY", "open");
  expect((await aiConnection(db, key, await newUser("preview"))).apiKey).toBeUndefined();
});

it("uses the fixed Gemini URL and the saved, encrypted key", async () => {
  const userId = await newUser();
  await saveAiSettings(db, key, userId, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-test" });

  expect(await aiConnection(db, key, userId)).toEqual({
    provider: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "AIza-test",
    model: "gemini-3.8-flash",
    extraBody: { reasoning_effort: "low" },
    reasoningTokens: 2048,
    imageTypes: ["jpeg", "png", "webp", "heic"],
  });
  const rows = [...(await db.select().from(aiSettings)), ...(await db.select().from(aiKeys))];
  expect(JSON.stringify(rows)).not.toContain("AIza-test");
  expect(await readAiSettings(db, userId)).toEqual({ preset: "gemini", model: "gemini-3.8-flash", thinking: "off", hasKey: true, keys: ["gemini"] });
});

it("keeps each provider's key across switches, so going back needs no new key", async () => {
  const userId = await newUser();
  await saveAiSettings(db, key, userId, { preset: "openai", model: "gpt-x", apiKey: "sk-test" });
  await saveAiSettings(db, key, userId, { preset: "openai", model: "gpt-y" });
  expect((await aiConnection(db, key, userId)).apiKey).toBe("sk-test");

  vi.stubEnv("LLM_BASE_URL", "http://host.docker.internal:11434");
  await saveAiSettings(db, key, userId, { preset: "local", model: "llama3.2" });
  expect(await aiConnection(db, key, userId)).toEqual({ provider: "ollama", baseUrl: "http://host.docker.internal:11434", apiKey: undefined, model: "llama3.2" });
  expect(await readAiSettings(db, userId)).toMatchObject({ preset: "local", hasKey: false, keys: ["openai"] });

  await saveAiSettings(db, key, userId, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-test" });
  await saveAiSettings(db, key, userId, { preset: "openai", model: "gpt-y" });
  expect((await aiConnection(db, key, userId)).apiKey).toBe("sk-test");
  await saveAiSettings(db, key, userId, { preset: "gemini", model: "gemini-3.6-flash" });
  expect(await aiConnection(db, key, userId)).toMatchObject({ apiKey: "AIza-test", model: "gemini-3.6-flash" });
  expect((await readAiSettings(db, userId))!.keys.sort()).toEqual(["gemini", "openai"]);
});

it("a key saved for one provider never decrypts for another", async () => {
  const userId = await newUser();
  await saveAiSettings(db, key, userId, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-test" });
  // Move the stored key to another provider's row by hand: the associated data no longer matches.
  await db.update(aiKeys).set({ preset: "openrouter" }).where(eq(aiKeys.userId, userId));
  await db.update(aiSettings).set({ preset: "openrouter" }).where(eq(aiSettings.userId, userId));
  await expect(aiConnection(db, key, userId)).rejects.toThrow();
});

it("refuses a hosted preset without a key", async () => {
  await expect(saveAiSettings(db, key, await newUser(), { preset: "gemini", model: "gemini-3.8-flash" })).rejects.toThrow(/API key/);
});

it("builds a preset's connection before the choice is saved, from the typed key or the saved one", async () => {
  const userId = await newUser();
  // A key typed on the page but not saved yet, so the page can ask the provider which models it serves.
  expect(await presetConnection(db, key, userId, "deepseek", "sk-typed")).toMatchObject({ provider: "openai", baseUrl: "https://api.deepseek.com", apiKey: "sk-typed" });
  // Nothing typed and nothing saved.
  await expect(presetConnection(db, key, userId, "deepseek")).rejects.toThrow(/API key/);
  await saveAiSettings(db, key, userId, { preset: "deepseek", model: "deepseek-flash", apiKey: "sk-saved" });
  expect((await presetConnection(db, key, userId, "deepseek")).apiKey).toBe("sk-saved");
});

it("turns off thinking only for a local OpenAI-compatible server", async () => {
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_BASE_URL", "http://host.docker.internal:18434/v1");
  const local = await newUser();
  await saveAiSettings(db, key, local, { preset: "local", model: "Qwen3.5-4B-Q4_K_M" });
  expect((await aiConnection(db, key, local)).extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  // The env fallback too, when it names a server on this machine.
  expect((await aiConnection(db, key, await newUser())).extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });

  const openai = await newUser();
  await saveAiSettings(db, key, openai, { preset: "openai", model: "gpt-x", apiKey: "sk-test" });
  expect((await aiConnection(db, key, openai)).extraBody).toBeUndefined();
  vi.stubEnv("LLM_BASE_URL", "https://api.example.com/v1");
  expect((await aiConnection(db, key, await newUser())).extraBody).toBeUndefined();
});

// Gemini 3 and newer cannot turn thinking off, and thinking counts against max_tokens (Google's thinking docs).
it("asks Gemini for low thinking and leaves room for it, from the preset or the env vars", async () => {
  const gemini = await newUser();
  await saveAiSettings(db, key, gemini, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-test" });
  expect(await aiConnection(db, key, gemini)).toMatchObject({ extraBody: { reasoning_effort: "low" }, reasoningTokens: 2048 });

  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai");
  expect(await aiConnection(db, key, await newUser())).toMatchObject({ extraBody: { reasoning_effort: "low" }, reasoningTokens: 2048 });

  vi.stubEnv("LLM_BASE_URL", "http://localhost:18434/v1");
  expect((await aiConnection(db, key, await newUser())).reasoningTokens).toBeUndefined();
});

it("connects the DeepSeek preset to DeepSeek's own API with the saved key and thinking off", async () => {
  const user = await newUser();
  await saveAiSettings(db, key, user, { preset: "deepseek", model: "deepseek-flash", apiKey: "sk-test-deepseek" });
  expect(await aiConnection(db, key, user)).toMatchObject({ baseUrl: "https://api.deepseek.com", apiKey: "sk-test-deepseek", model: "deepseek-flash", extraBody: { thinking: { type: "disabled" } }, jsonMode: "object" });
});

// kymavo's AI jobs (label, summary, short draft, rewording) do not need thinking; off is faster and cheaper.
it("turns DeepSeek thinking off", async () => {
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_BASE_URL", "https://api.deepseek.com");
  expect(await aiConnection(db, key, await newUser())).toMatchObject({ extraBody: { thinking: { type: "disabled" } } });
});

it("lists the image types each preset reads", async () => {
  const types = async (preset: "gemini" | "openai" | "openrouter" | "deepseek") => {
    const user = await newUser();
    await saveAiSettings(db, key, user, { preset, model: "m", apiKey: "sk-test" });
    return (await aiConnection(db, key, user)).imageTypes;
  };
  expect(await types("gemini")).toEqual(["jpeg", "png", "webp", "heic"]);
  expect(await types("openai")).toEqual(["jpeg", "png", "webp"]);
  expect(await types("openrouter")).toEqual(["jpeg", "png", "webp"]);
  expect(await types("deepseek")).toEqual(["jpeg", "png", "webp"]);
});

it("reads images on the local server only when the operator turns LLM_VISION on", async () => {
  const user = await newUser();
  await saveAiSettings(db, key, user, { preset: "local", model: "llama3.2" });
  expect((await aiConnection(db, key, user)).imageTypes).toBeUndefined();
  vi.stubEnv("LLM_VISION", "on");
  expect((await aiConnection(db, key, user)).imageTypes).toEqual(["jpeg", "png", "webp"]);
  expect((await aiConnection(db, key, await newUser())).imageTypes).toEqual(["jpeg", "png", "webp"]);
});

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEEPSEEK_URL = "https://api.deepseek.com";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const OPENAI_URL = "https://api.openai.com/v1";
const LOCAL_URL = "http://localhost:18434/v1";

// Off is today's behaviour; each higher level asks the provider for more thinking and leaves more tokens for it.
it.each([
  [GEMINI_URL, "off", { extraBody: { reasoning_effort: "low" }, reasoningTokens: 2048 }],
  [GEMINI_URL, "low", { extraBody: { reasoning_effort: "low" }, reasoningTokens: 2048 }],
  [GEMINI_URL, "medium", { extraBody: { reasoning_effort: "medium" }, reasoningTokens: 4096 }],
  [GEMINI_URL, "high", { extraBody: { reasoning_effort: "high" }, reasoningTokens: 8192 }],
  [DEEPSEEK_URL, "off", { extraBody: { thinking: { type: "disabled" } }, jsonMode: "object" }],
  [DEEPSEEK_URL, "low", { extraBody: { thinking: { type: "enabled" }, reasoning_effort: "low" }, reasoningTokens: 2048, jsonMode: "object" }],
  [DEEPSEEK_URL, "medium", { extraBody: { thinking: { type: "enabled" }, reasoning_effort: "high" }, reasoningTokens: 4096, jsonMode: "object" }],
  [DEEPSEEK_URL, "high", { extraBody: { thinking: { type: "enabled" }, reasoning_effort: "max" }, reasoningTokens: 8192, jsonMode: "object" }],
  [OPENROUTER_URL, "off", {}],
  [OPENROUTER_URL, "low", { extraBody: { reasoning: { effort: "low" } }, reasoningTokens: 2048 }],
  [OPENROUTER_URL, "high", { extraBody: { reasoning: { effort: "high" } }, reasoningTokens: 8192 }],
  [OPENAI_URL, "off", {}],
  [OPENAI_URL, "medium", { extraBody: { reasoning_effort: "medium" }, reasoningTokens: 4096 }],
  [LOCAL_URL, "off", { extraBody: { chat_template_kwargs: { enable_thinking: false } } }],
  [LOCAL_URL, "low", { extraBody: { chat_template_kwargs: { enable_thinking: true } }, reasoningTokens: 2048 }],
  [LOCAL_URL, "high", { extraBody: { chat_template_kwargs: { enable_thinking: true } }, reasoningTokens: 8192 }],
] as const)("maps %s at thinking %s", (baseUrl, level, expected) => {
  expect(thinkingControl("openai", baseUrl, level)).toEqual(expected);
});

it("sends nothing extra to an unknown host, an Ollama server or a bad URL, whatever the level", () => {
  for (const level of THINKING_LEVELS) {
    expect(thinkingControl("openai", "https://api.example.com/v1", level)).toEqual({});
    expect(thinkingControl("ollama", "http://localhost:11434", level)).toEqual({});
    expect(thinkingControl("openai", "not a url", level)).toEqual({});
  }
});

it("saves the thinking level, keeps it when a save leaves it out, and applies it to the connection", async () => {
  const user = await newUser();
  await saveAiSettings(db, key, user, { preset: "openrouter", model: "m", apiKey: "sk-test", thinking: "medium" });
  expect(await readAiSettings(db, user)).toMatchObject({ thinking: "medium" });
  expect(await aiConnection(db, key, user)).toMatchObject({ extraBody: { reasoning: { effort: "medium" } }, reasoningTokens: 4096 });
  await saveAiSettings(db, key, user, { preset: "openrouter", model: "m2" });
  expect(await readAiSettings(db, user)).toMatchObject({ model: "m2", thinking: "medium" });

  // The Local model preset uses the env server, so the level applies there too.
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_BASE_URL", LOCAL_URL);
  await saveAiSettings(db, key, user, { preset: "local", model: "qwen", thinking: "low" });
  expect(await aiConnection(db, key, user)).toMatchObject({ extraBody: { chat_template_kwargs: { enable_thinking: true } }, reasoningTokens: 2048 });
});

// Platform AI (A2, decision 0151): the shared model the admin set, used where the env vars were.
const ADMIN = "boss@test.local";

it("uses the env vars until the admin saves a shared model, then that model for every workspace on the shared path", async () => {
  vi.stubEnv("LLM_PROVIDER", "ollama");
  vi.stubEnv("LLM_BASE_URL", "http://localhost:11434");
  vi.stubEnv("LLM_MODEL", "llama3.2");
  vi.stubEnv("SHARED_LLM_KEY", "open");
  await pool.query("delete from platform_ai");
  const userId = await newUser();
  expect(await aiConnection(db, key, userId)).toMatchObject({ provider: "ollama", model: "llama3.2" });
  await savePlatformAi(db, key, ADMIN, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-platform-1234", thinking: "medium" });
  const conn = await aiConnection(db, key, userId);
  expect(conn).toMatchObject({ provider: "openai", baseUrl: GEMINI_URL, apiKey: "AIza-platform-1234", model: "gemini-3.8-flash", imageTypes: ["jpeg", "png", "webp", "heic"] });
  expect(conn).toMatchObject(thinkingControl("openai", GEMINI_URL, "medium"));
  // The "Local model" choice means the shared model, so it follows the platform model too.
  await saveAiSettings(db, key, userId, { preset: "local", model: "llama3.2", thinking: "high" });
  expect(await aiConnection(db, key, userId)).toEqual(conn);
});

it("lets the per-workspace override win over the platform level, and null follows the platform again", async () => {
  vi.stubEnv("SHARED_LLM_KEY", "open");
  await savePlatformAi(db, key, ADMIN, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-platform-1234", thinking: "low" });
  const userId = await newUser();
  await db.update(users).set({ aiThinking: "high" }).where(eq(users.id, userId));
  expect(await aiConnection(db, key, userId)).toMatchObject(thinkingControl("openai", GEMINI_URL, "high"));
  await db.update(users).set({ aiThinking: null }).where(eq(users.id, userId));
  expect(await aiConnection(db, key, userId)).toMatchObject(thinkingControl("openai", GEMINI_URL, "low"));
});

it("keeps the shared key from a preview or no-plan workspace and without SHARED_LLM_KEY=open, but still sends the model", async () => {
  await savePlatformAi(db, key, ADMIN, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-platform-1234" });
  vi.stubEnv("SHARED_LLM_KEY", "open");
  for (const plan of ["preview", null] as const) {
    expect(await aiConnection(db, key, await newUser(plan)), String(plan)).toMatchObject({ apiKey: undefined, model: "gemini-3.8-flash", baseUrl: GEMINI_URL });
  }
  expect((await aiConnection(db, key, await newUser("pilot"))).apiKey).toBe("AIza-platform-1234");
  vi.stubEnv("SHARED_LLM_KEY", "");
  expect((await aiConnection(db, key, await newUser("pilot"))).apiKey).toBeUndefined();
});

it("leaves a workspace with its own hosted key on its own provider, model and thinking level", async () => {
  vi.stubEnv("SHARED_LLM_KEY", "open");
  await savePlatformAi(db, key, ADMIN, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-platform-1234", thinking: "high" });
  const userId = await newUser();
  await db.update(users).set({ aiThinking: "high" }).where(eq(users.id, userId));
  await saveAiSettings(db, key, userId, { preset: "deepseek", model: "deepseek-flash", apiKey: "sk-own", thinking: "off" });
  expect(await aiConnection(db, key, userId)).toMatchObject({ baseUrl: "https://api.deepseek.com", apiKey: "sk-own", model: "deepseek-flash", ...thinkingControl("openai", "https://api.deepseek.com", "off") });
});

it("encrypts the shared key with its own name, shows only its last four characters, and keeps it when none is sent", async () => {
  await pool.query("delete from platform_ai");
  await savePlatformAi(db, key, ADMIN, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-platform-1234" });
  const [row] = await db.select().from(platformAi);
  expect(JSON.stringify(row)).not.toContain("AIza-platform");
  expect(decryptSecret(key, "platform", "platform_ai_key", { ciphertext: row!.keyCiphertext!, iv: row!.keyIv!, authTag: row!.keyAuthTag! })).toBe("AIza-platform-1234");
  // It never decrypts as a workspace's key for the same provider.
  expect(() => decryptSecret(key, "platform", "ai_api_key:gemini", { ciphertext: row!.keyCiphertext!, iv: row!.keyIv!, authTag: row!.keyAuthTag! })).toThrow();
  expect(await readPlatformAi(db)).toEqual({ preset: "gemini", model: "gemini-3.8-flash", thinking: "off", hasKey: true, keyLast4: "1234" });
  await savePlatformAi(db, key, ADMIN, { preset: "gemini", model: "gemini-3.6-flash", thinking: "low" });
  expect(await readPlatformAi(db)).toMatchObject({ model: "gemini-3.6-flash", thinking: "low", keyLast4: "1234" });
  vi.stubEnv("SHARED_LLM_KEY", "open");
  expect((await sharedConnection(db, key, "pilot", null)).apiKey).toBe("AIza-platform-1234");
  // A key belongs to one provider: switching provider without a new key is refused, and a hosted one needs a key.
  await expect(savePlatformAi(db, key, ADMIN, { preset: "openai", model: "gpt-x" })).rejects.toThrow(/needs an API key/);
  await pool.query("delete from platform_ai");
  await expect(savePlatformAi(db, key, ADMIN, { preset: "gemini", model: "gemini-3.8-flash" })).rejects.toThrow(/needs an API key/);
});

it("records each save in admin_actions without the key", async () => {
  await pool.query("delete from platform_ai");
  await pool.query("delete from admin_actions where action = 'ai'");
  await savePlatformAi(db, key, ADMIN, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-platform-1234" });
  await savePlatformAi(db, key, ADMIN, { preset: "gemini", model: "gemini-3.6-flash", thinking: "low" });
  const log = await db.select().from(adminActions).where(eq(adminActions.action, "ai"));
  expect(log).toHaveLength(2);
  expect(log.map((l) => l.adminEmail)).toEqual([ADMIN, ADMIN]);
  expect(JSON.stringify(log)).not.toContain("AIza-platform");
  expect(log.find((l) => (l.after as { model: string }).model === "gemini-3.6-flash")).toMatchObject({
    before: { preset: "gemini", model: "gemini-3.8-flash", thinking: "off", hasKey: true },
    after: { preset: "gemini", model: "gemini-3.6-flash", thinking: "low", hasKey: true, keyChanged: false },
  });
});
