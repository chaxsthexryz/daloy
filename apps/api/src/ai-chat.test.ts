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

const draft = JSON.stringify({ kind: "draft", name: "Contact thanks", summary: "Thanks the sender.", definition: TEMPLATES[0]!.definition });
const question = JSON.stringify({ kind: "question", text: "What starts it?", choices: ["Someone fills a form", "On a schedule"] });
const invalid = JSON.stringify({ kind: "draft", name: "Broken", summary: "x", definition: { trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "fax", config: {} }], edges: [] } });

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
  vi.stubEnv("LLM_PROVIDER", "ollama");
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
  await agent.post("/auth/register").send({ email: `chat${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return agent;
}

const say = (content: string) => ({ messages: [{ role: "user", content }] });

it("needs a session", async () => {
  await request(server).post("/ai/chat").send(say("x")).expect(401);
});

it("answers a first message with a question and its choices", async () => {
  replies = [question];
  const { body } = await (await signedIn()).post("/ai/chat").send(say("When someone fills my form, thank them by email.")).expect(200);
  expect(body).toEqual({ kind: "question", text: "What starts it?", choices: ["Someone fills a form", "On a schedule"] });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.messages.at(-1)).toMatchObject({ role: "user", content: "When someone fills my form, thank them by email." });
});

it("returns the draft with the checker's warnings once the answers are enough", async () => {
  replies = [draft];
  const { body } = await (await signedIn()).post("/ai/chat").send({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "What starts it?" }, { role: "user", content: "Someone fills a form" }] }).expect(200);
  expect(body).toMatchObject({ kind: "draft", name: "Contact thanks" });
  expect(Array.isArray(body.warnings)).toBe(true);
});

it("sends the draft being changed apart from the conversation, and names the connected apps", async () => {
  replies = [draft];
  const messages = [{ role: "user", content: "a" }, { role: "assistant", content: "q" }, { role: "user", content: "change it" }];
  await (await signedIn()).post("/ai/chat").send({ messages, current: TEMPLATES[0]!.definition, apps: ["google_sheets", "slack"] }).expect(200);
  expect(asked[0]!.messages.at(-1)!.content).toContain("The current draft is:");
  expect(asked[0]!.messages.at(-1)!.content).toContain('"classify"');
  // The apps are names from a fixed list, and they reach the system prompt only.
  expect(asked[0]!.messages[0]!.content).toContain("Apps connected: google_sheets, slack.");
  expect(asked[0]!.messages.at(-1)!.content).not.toContain("google_sheets");
});

it("tells the model to stop asking after six questions", async () => {
  replies = [draft];
  const messages: { role: string; content: string }[] = [];
  for (let i = 0; i < 6; i++) messages.push({ role: "user", content: `a${i}` }, { role: "assistant", content: `q${i}` });
  await (await signedIn()).post("/ai/chat").send({ messages }).expect(200);
  expect(asked[0]!.messages.at(-1)!.content).toMatch(/Ask no more questions/);
});

it("sends the problems back once and accepts the fixed reply", async () => {
  replies = [invalid, draft];
  const { body } = await (await signedIn()).post("/ai/chat").send(say("contact form flow")).expect(200);
  expect(body.name).toBe("Contact thanks");
  expect(asked).toHaveLength(2);
  expect(asked[1]!.messages.at(-2)).toMatchObject({ role: "assistant", content: invalid });
  expect(asked[1]!.messages.at(-1)!.content).toMatch(/steps\.0\.type/);
});

it("gives up after the second invalid reply and says why", async () => {
  replies = [invalid, "not json at all"];
  const { body } = await (await signedIn()).post("/ai/chat").send(say("contact form flow")).expect(422);
  expect(body.message).toMatch(/could not make a valid workflow/);
  expect(body.errors).toEqual(["The reply was not a JSON object."]);
});

it("refuses a conversation that is too long, a message that is too long, and an unknown app", async () => {
  const agent = await signedIn();
  const long = { messages: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })) };
  await agent.post("/ai/chat").send(long).expect(400);
  await agent.post("/ai/chat").send({ messages: [{ role: "user", content: "x".repeat(2001) }] }).expect(400);
  await agent.post("/ai/chat").send({ messages: [{ role: "user", content: "x" }], apps: ["dropbox"] }).expect(400);
  await agent.post("/ai/chat").send({ messages: [] }).expect(400);
});
