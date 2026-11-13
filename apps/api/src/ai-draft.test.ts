import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TEMPLATES } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

let app: INestApplication;
let boss: PgBoss;
let pool: Pool;
let server: Parameters<typeof request>[0];
let llm: Server;

// A fake Ollama that answers with the queued replies in order, and records what it was asked.
let replies: string[] = [];
const asked: { messages: { role: string; content: string }[] }[] = [];
const valid = JSON.stringify({ name: "Contact form triage", summary: "Thanks the sender and sorts billing questions.", definition: TEMPLATES[0]!.definition });
const invalid = JSON.stringify({ name: "Broken", summary: "x", definition: { trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "sms", config: {} }], edges: [] } });

beforeAll(async () => {
  const fresh = await freshDatabase();
  pool = fresh.pool;
  boss = new PgBoss(fresh.url);
  await boss.start();
  app = await createApp({ db: fresh.db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();

  llm = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      asked.push(JSON.parse(raw) as (typeof asked)[number]);
      res.end(JSON.stringify({ message: { content: replies.shift() ?? "" }, prompt_eval_count: 1, eval_count: 1 }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${(llm.address() as AddressInfo).port}`);
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  llm?.close();
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

beforeEach(() => {
  asked.length = 0;
});

let seq = 0;
async function signedIn() {
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email: `draft${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return agent;
}

it("needs a session", async () => {
  await request(server).post("/ai/draft").send({ request: "x" }).expect(401);
});

it("builds a draft from a request", async () => {
  replies = [valid];
  const { body } = await (await signedIn()).post("/ai/draft").send({ request: "Thank people who fill my contact form and sort billing questions" }).expect(200);
  expect(body).toMatchObject({ name: "Contact form triage", summary: "Thanks the sender and sorts billing questions." });
  expect(body.definition.steps.map((s: { id: string }) => s.id)).toContain("classify");
  expect(asked).toHaveLength(1);
});

it("sends the problems back once and accepts the fixed draft", async () => {
  replies = [invalid, valid];
  const { body } = await (await signedIn()).post("/ai/draft").send({ request: "contact form flow" }).expect(200);
  expect(body.name).toBe("Contact form triage");
  expect(asked).toHaveLength(2);
  const retry = asked[1]!.messages;
  expect(retry.at(-2)).toMatchObject({ role: "assistant", content: invalid });
  expect(retry.at(-1)!.content).toMatch(/steps\.0\.type/);
});

it("gives up after the second invalid draft and says why", async () => {
  replies = [invalid, "not json at all"];
  const { body } = await (await signedIn()).post("/ai/draft").send({ request: "contact form flow" }).expect(422);
  expect(body.message).toMatch(/could not make a valid workflow/);
  expect(body.errors).toEqual(["The reply was not a JSON object."]);
});

it("changes the current draft when one is sent", async () => {
  replies = [valid];
  const current = TEMPLATES[1]!.definition;
  await (await signedIn()).post("/ai/draft").send({ request: "Wait two days instead", current }).expect(200);
  expect(asked[0]!.messages.at(-1)!.content).toContain("wait_a_week");
  expect(asked[0]!.messages.at(-1)!.content).toContain("Wait two days instead");
});

it("rejects an empty or oversized request", async () => {
  const agent = await signedIn();
  await agent.post("/ai/draft").send({ request: " " }).expect(400);
  await agent.post("/ai/draft").send({ request: "x".repeat(2001) }).expect(400);
});
