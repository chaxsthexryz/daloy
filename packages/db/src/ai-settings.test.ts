import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { aiConnection, presetConnection, readAiSettings, saveAiSettings } from "./ai-settings";
import { eq } from "drizzle-orm";
import { aiKeys, aiSettings, users } from "./schema";
import type { Db } from "./index";

let db: Db;
let pool: Pool;
const key = randomBytes(32);
let seq = 0;
const newUser = async (plan: "pilot" | "preview" | null = "pilot") => (await db.insert(users).values({ email: `ai${++seq}@test.local`, passwordHash: "x", plan }).returning())[0]!.id;

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
  await saveAiSettings(db, key, userId, { preset: "openai", model: "gpt-x", apiKey: "sk-own" });
  expect((await aiConnection(db, key, userId)).apiKey).toBe("sk-own");
  await db.update(users).set({ plan: "pilot" }).where(eq(users.id, userId));
  await saveAiSettings(db, key, userId, { preset: "local", model: "llama3.2" });
  expect((await aiConnection(db, key, userId)).apiKey).toBe("env-key");
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
  expect(await readAiSettings(db, userId)).toEqual({ preset: "gemini", model: "gemini-3.8-flash", hasKey: true, keys: ["gemini"] });
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

// Daloy's AI jobs (label, summary, short draft, rewording) do not need thinking; off is faster and cheaper.
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
