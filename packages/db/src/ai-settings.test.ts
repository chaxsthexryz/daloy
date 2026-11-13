import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { aiConnection, readAiSettings, saveAiSettings } from "./ai-settings";
import { aiSettings, users } from "./schema";
import type { Db } from "./index";

let db: Db;
let pool: Pool;
const key = randomBytes(32);
let seq = 0;
const newUser = async () => (await db.insert(users).values({ email: `ai${++seq}@test.local`, passwordHash: "x" }).returning())[0]!.id;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);
afterAll(async () => {
  await pool?.end();
});
afterEach(() => vi.unstubAllEnvs());

it("falls back to the env vars when the user saved nothing", async () => {
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_BASE_URL", "http://lmstudio.local:1234/v1");
  vi.stubEnv("LLM_API_KEY", "env-key");
  vi.stubEnv("LLM_MODEL", "qwen");
  expect(await aiConnection(db, key, await newUser())).toEqual({ provider: "openai", baseUrl: "http://lmstudio.local:1234/v1", apiKey: "env-key", model: "qwen" });
});

it("uses the fixed Gemini URL and the saved, encrypted key", async () => {
  const userId = await newUser();
  await saveAiSettings(db, key, userId, { preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-test" });

  expect(await aiConnection(db, key, userId)).toEqual({
    provider: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "AIza-test",
    model: "gemini-3.8-flash",
  });
  const [row] = await db.select().from(aiSettings);
  expect(JSON.stringify(row)).not.toContain("AIza-test");
  expect(await readAiSettings(db, userId)).toEqual({ preset: "gemini", model: "gemini-3.8-flash", hasKey: true });
});

it("keeps the saved key when a later save sends none, and drops it for local", async () => {
  const userId = await newUser();
  await saveAiSettings(db, key, userId, { preset: "openai", model: "gpt-x", apiKey: "sk-test" });
  await saveAiSettings(db, key, userId, { preset: "openai", model: "gpt-y" });
  expect((await aiConnection(db, key, userId)).apiKey).toBe("sk-test");

  vi.stubEnv("LLM_BASE_URL", "http://host.docker.internal:11434");
  await saveAiSettings(db, key, userId, { preset: "local", model: "llama3.2" });
  expect(await aiConnection(db, key, userId)).toEqual({ provider: "ollama", baseUrl: "http://host.docker.internal:11434", apiKey: undefined, model: "llama3.2" });
  expect(await readAiSettings(db, userId)).toMatchObject({ hasKey: false });
});

it("refuses a hosted preset without a key", async () => {
  await expect(saveAiSettings(db, key, await newUser(), { preset: "gemini", model: "gemini-3.8-flash" })).rejects.toThrow(/API key/);
});
