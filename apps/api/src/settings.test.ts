import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { LlmError } from "@daloy/llm-ts";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { explain } from "./settings";

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
  expect(body.current).toEqual({ preset: "local", model: "llama3.2", hasKey: false, saved: false });
  expect(body.presets.gemini).toMatchObject({ label: "Gemini API", defaultModel: "gemini-3.8-flash", needsKey: true });
  expect(body.presets.gemini.models).toContainEqual(expect.objectContaining({ id: "gemini-3.5-flash-lite", free: true }));
  expect(JSON.stringify(body.presets)).not.toContain("http");
});

it("saves a hosted choice with a key and never sends the key back", async () => {
  const agent = await signedIn();
  await agent.put("/settings/ai").send({ preset: "gemini", model: "gemini-3.8-flash", apiKey: "AIza-secret-test" }).expect(204);
  const res = await agent.get("/settings/ai").expect(200);
  expect(res.body.current).toEqual({ preset: "gemini", model: "gemini-3.8-flash", hasKey: true, saved: true });
  expect(res.text).not.toContain("AIza-secret-test");
  // Another user still gets the default.
  expect((await (await signedIn()).get("/settings/ai")).body.current.saved).toBe(false);
});

it("rejects a hosted choice without a key, unknown choices and blank models", async () => {
  const agent = await signedIn();
  const noKey = await agent.put("/settings/ai").send({ preset: "openai", model: "gpt-x" }).expect(400);
  expect(noKey.body.message).toMatch(/API key/);
  await agent.put("/settings/ai").send({ preset: "custom", model: "m", apiKey: "k" }).expect(400);
  await agent.put("/settings/ai").send({ preset: "local", model: " " }).expect(400);
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

it("explains a model it cannot reach", async () => {
  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9");
  const { body } = await (await signedIn()).post("/settings/ai/test").expect(200);
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/Could not connect to the model/);
});

it.each([
  [new LlmError("LLM request failed: TimeoutError", true), /took too long/],
  [new LlmError("LLM request failed: TypeError", true), /Could not connect to the model/],
  [new LlmError("LLM returned HTTP 503", true), /busy or down/],
  [new LlmError("LLM returned HTTP 500", true), /busy or down/],
  [new LlmError("LLM returned HTTP 401", false), /rejected the API key/],
  [new LlmError("LLM returned HTTP 429", true), /rate limit/],
])("explains %s in plain words", (err, reason) => {
  expect(explain(err)).toMatch(reason);
});
