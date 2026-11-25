import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { LlmError } from "@daloy/llm-ts";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { explain, explainForOwner } from "./settings";

let app: INestApplication;
let boss: PgBoss;
let pool: Pool;
let server: Parameters<typeof request>[0];
let llm: Server;
let llmUrl: string;
const asked: { model: string }[] = [];

beforeAll(async () => {
  const { url, db, pool: p } = await freshDatabase();
  pool = p;
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();

  // A fake Ollama that classifies everything as billing.
  llm = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      // Also answers as an OpenAI-compatible server's model list.
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "Qwen3.5-4B-Q4_K_M" }] }));
      asked.push(JSON.parse(raw) as { model: string });
      res.end(JSON.stringify({ message: { content: '{"label":"billing"}' }, prompt_eval_count: 40, eval_count: 3 }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  llm?.close();
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

afterEach(() => vi.unstubAllGlobals());

/** A provider that serves these model names, so a hosted save never needs the network. */
function stubOffers(models: string[]) {
  vi.stubGlobal("fetch", async (url: string | URL) =>
    String(url).endsWith("/models") ? new Response(JSON.stringify({ data: models.map((id) => ({ id })) })) : new Response("{}", { status: 400 }));
}

let seq = 0;
async function signedIn() {
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email: `ai${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return agent;
}

it("needs a session", async () => {
  await request(server).get("/settings/ai").expect(401);
});

it("lists the choices and starts on the local model", async () => {
  vi.stubEnv("LLM_MODEL", "llama3.2");
  const { body } = await (await signedIn()).get("/settings/ai").expect(200);
  expect(body.current).toEqual({ preset: "local", model: "llama3.2", hasKey: false, keys: [], saved: false });
  expect(body.presets.gemini).toMatchObject({ label: "Gemini API", defaultModel: "gemini-3.8-flash", needsKey: true });
  expect(body.presets.gemini.models).toContainEqual(expect.objectContaining({ id: "gemini-3.5-flash-lite", free: true }));
  expect(JSON.stringify(body.presets)).not.toContain("http");
});

it("saves a hosted choice with a key and never sends the key back", async () => {
  // The provider's model list is remembered for the key below, so no request leaves the machine.
  stubOffers(["gemini-3.8-flash"]);
  const agent = await signedIn();
  await agent.put("/settings/ai").send({ preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-secret-test" }).expect(204);
  const res = await agent.get("/settings/ai").expect(200);
  expect(res.body.current).toEqual({ preset: "gemini", model: "gemini-3.8-flash", hasKey: true, keys: ["gemini"], saved: true });
  expect(res.text).not.toContain("AIza-secret-test");
  // Another user still gets the default.
  expect((await (await signedIn()).get("/settings/ai")).body.current.saved).toBe(false);
});

it("offers the local model from .env as the local default", async () => {
  vi.stubEnv("LLM_MODEL", "Qwen3.5-4B-Q4_K_M");
  const { body } = await (await signedIn()).get("/settings/ai").expect(200);
  expect(body.presets.local.defaultModel).toBe("Qwen3.5-4B-Q4_K_M");
});

it("lists the models the local server from .env offers, and says when it is not answering", async () => {
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_BASE_URL", `${llmUrl}/v1`);
  const agent = await signedIn();
  expect((await agent.get("/settings/ai/local-models").expect(200)).body).toEqual({ ok: true, models: ["Qwen3.5-4B-Q4_K_M"] });

  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9");
  const down = (await agent.get("/settings/ai/local-models").expect(200)).body;
  expect(down).toMatchObject({ ok: false, models: [] });
  expect(down.error).toMatch(/Could not connect to the model/);
  vi.unstubAllEnvs();
  await request(server).get("/settings/ai/local-models").expect(401);
});

it("rejects a hosted choice without a key, unknown choices and blank models", async () => {
  const agent = await signedIn();
  const noKey = await agent.put("/settings/ai").send({ preset: "openai", model: "gpt-x" }).expect(400);
  expect(noKey.body.message).toMatch(/API key/);
  await agent.put("/settings/ai").send({ preset: "custom", model: "m", apiKey: "k" }).expect(400);
  await agent.put("/settings/ai").send({ preset: "local", model: " " }).expect(400);
});

it("refuses a model name the provider does not serve, and names the ones it does", async () => {
  // What DeepSeek's own dashboard calls "DeepSeek-V4.1-Flash" is the id "deepseek-flash" over the API.
  stubOffers(["deepseek-flash", "deepseek-v4-pro"]);
  const agent = await signedIn();
  const refused = await agent.put("/settings/ai").send({ preset: "deepseek", model: "DeepSeek-V4.1-Flash-1017", apiKey: "sk-display-name" }).expect(400);
  expect(refused.body.message).toContain("deepseek-flash");
  expect(refused.body.message).toContain("deepseek-v4-pro");
  // Nothing was saved, so the page keeps showing the previous choice.
  expect((await agent.get("/settings/ai")).body.current.saved).toBe(false);
  // The id the provider serves is accepted.
  await agent.put("/settings/ai").send({ preset: "deepseek", model: "deepseek-flash", apiKey: "sk-display-name" }).expect(204);
  expect((await agent.get("/settings/ai")).body.current).toMatchObject({ preset: "deepseek", model: "deepseek-flash", saved: true });
});

it("saves when the provider cannot be reached, so an outage does not block the page", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("fetch failed");
  });
  const agent = await signedIn();
  await agent.put("/settings/ai").send({ preset: "openai", model: "gpt-they-typed", apiKey: "sk-offline" }).expect(204);
  expect((await agent.get("/settings/ai")).body.current).toMatchObject({ preset: "openai", model: "gpt-they-typed", saved: true });
});

it("offers the model names a provider serves, before anything is saved", async () => {
  stubOffers(["deepseek-flash", "deepseek-v4-pro"]);
  const agent = await signedIn();
  const { body } = await agent.post("/settings/ai/models").send({ preset: "deepseek", apiKey: "sk-list" }).expect(200);
  expect(body).toEqual({ ok: true, models: ["deepseek-flash", "deepseek-v4-pro"] });
  await request(server).post("/settings/ai/models").send({ preset: "deepseek", apiKey: "sk-list" }).expect(401);
});

it("names the models the provider serves when the test call is refused", async () => {
  // The first list request fails, so the save goes through with the name as typed; the test then says what is served.
  let lists = 0;
  vi.stubGlobal("fetch", async (url: string | URL) => {
    if (String(url).endsWith("/models")) {
      lists += 1;
      if (lists === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }));
    }
    return new Response(JSON.stringify({ error: { message: "The supported API model names are deepseek-flash, deepseek-v4-pro" } }), { status: 400 });
  });
  const agent = await signedIn();
  await agent.put("/settings/ai").send({ preset: "deepseek", model: "DeepSeek-V4.1-Flash", apiKey: "sk-refused-test" }).expect(204);
  const { body } = await agent.post("/settings/ai/test").expect(200);
  expect(body).toMatchObject({ ok: false, model: "DeepSeek-V4.1-Flash" });
  expect(body.error).toContain("deepseek-flash");
  expect(body.error).toContain("deepseek-v4-pro");
});

it("tests the saved model live on a sample inquiry", async () => {
  vi.stubEnv("LLM_BASE_URL", llmUrl);
  const agent = await signedIn();
  await agent.put("/settings/ai").send({ preset: "local", model: "test-model" }).expect(204);
  const { body } = await agent.post("/settings/ai/test").expect(200);
  expect(body).toMatchObject({ ok: true, label: "billing", inputTokens: 40, outputTokens: 3 });
  expect(body.ms).toBeGreaterThanOrEqual(0);
  expect(asked.at(-1)!.model).toBe("test-model");
});

it("refuses the sample once the monthly AI actions are used up, without calling the model", async () => {
  vi.stubEnv("LLM_BASE_URL", llmUrl);
  const agent = await signedIn();
  await agent.put("/settings/ai").send({ preset: "local", model: "test-model" }).expect(204);
  const email = `ai${seq}@test.local`;
  await pool.query("update users set plan = 'pilot', plan_started_on = '2026-01-01' where email = $1", [email]);
  await pool.query("insert into usage_counts (user_id, kind, period, used) select id, 'ai', to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-01'), 100 from users where email = $1", [email]);
  const before = asked.length;
  expect((await agent.post("/settings/ai/test").expect(429)).body.message).toMatch(/AI actions/);
  expect(asked).toHaveLength(before);
});

it("explains a model it cannot reach and spends 0 AI quota", async () => {
  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9");
  const agent = await signedIn();
  const { body } = await agent.post("/settings/ai/test").expect(200);
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/Could not connect to the model/);
  expect((await agent.get("/usage").expect(200)).body.ai.used).toBe(0);
});

it("explains provider errors to non-admin owners without leaking API key internals", () => {
  for (const err of [
    new LlmError("LLM returned HTTP 401", false),
    new LlmError("LLM returned HTTP 403", false),
    new LlmError("LLM request failed: TypeError", true),
    new LlmError("OpenRouter has no saved API key", false),
  ]) {
    const msg = explainForOwner(err);
    expect(msg).not.toMatch(/API key|rejected|\.env|Ollama/i);
    expect(msg).toMatch(/temporarily unavailable/i);
  }
  expect(explainForOwner(new LlmError("LLM request failed: TimeoutError", true))).toMatch(/took too long/i);
  expect(explainForOwner(new LlmError("LLM returned HTTP 429", true))).toMatch(/rate limit/i);
});

it.each([
  [new LlmError("LLM request failed: TimeoutError", true), /took too long/],
  [new LlmError("LLM request failed: TypeError", true), /Could not connect to the model/],
  [new LlmError("LLM returned HTTP 503", true), /busy or down/],
  [new LlmError("LLM returned HTTP 500", true), /busy or down/],
  [new LlmError("LLM returned HTTP 401", false), /rejected the API key/],
  [new LlmError("LLM returned HTTP 400", false), /model name may be wrong/],
  [new LlmError("LLM returned HTTP 404", false), /does not know this model name/],
  [new LlmError("LLM returned HTTP 429", true), /rate limit/],
  [new LlmError("the model used up its token limit before answering (thinking counts toward it)", false, { invalidOutput: true }), /thinking/],
])("explains %s in plain words", (err, reason) => {
  expect(explain(err)).toMatch(reason);
});

it("names the models the provider serves when it refuses the name", () => {
  expect(explain(new LlmError("LLM returned HTTP 400", false), ["deepseek-flash", "deepseek-v4-pro"])).toBe(
    "The provider does not offer this model name (HTTP 400). It offers: deepseek-flash, deepseek-v4-pro.",
  );
  // A long list stays readable.
  const many = Array.from({ length: 20 }, (_, i) => `model-${i}`);
  expect(explain(new LlmError("LLM returned HTTP 400", false), many)).toContain("model-11 and 8 more");
});
