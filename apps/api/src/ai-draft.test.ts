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
const invalid = JSON.stringify({ name: "Broken", summary: "x", definition: { trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "fax", config: {} }], edges: [] } });

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

// Valid for the schema, but the approval has no rejected or timeout edge (decision 0033).
const warnedDefinition = {
  trigger: { type: "manual", config: {} },
  steps: [
    { id: "ask", type: "approval", config: { approver: "boss@example.com", subject: "Approve?", message: "Please decide.", timeoutSeconds: 3600 } },
    { id: "done", type: "email", config: { to: "a@example.com", subject: "Approved", text: "ok" } },
  ],
  edges: [{ from: "ask", to: "done", on: "approved" }],
};
const warned = JSON.stringify({ name: "Approval", summary: "Asks the boss.", definition: warnedDefinition });

it("a clean draft makes one model call and carries no warnings", async () => {
  replies = [valid];
  const { body } = await (await signedIn()).post("/ai/draft").send({ request: "contact form flow" }).expect(200);
  expect(body.warnings).toEqual([]);
  expect(asked).toHaveLength(1);
});

it("sends lint warnings back once and keeps the fixed draft", async () => {
  replies = [warned, valid];
  const { body } = await (await signedIn()).post("/ai/draft").send({ request: "ask the boss" }).expect(200);
  expect(body.name).toBe("Contact form triage");
  expect(body.warnings).toEqual([]);
  expect(asked).toHaveLength(2);
  expect(asked[1]!.messages.at(-2)).toMatchObject({ role: "assistant", content: warned });
  expect(asked[1]!.messages.at(-1)!.content).toMatch(/"ask" has no "rejected" edge/);
});

it("returns the warnings that remain after the second try instead of failing", async () => {
  replies = [warned, warned];
  const { body } = await (await signedIn()).post("/ai/draft").send({ request: "ask the boss" }).expect(200);
  expect(asked).toHaveLength(2);
  expect(body.warnings).toHaveLength(2);
});

it("keeps the first valid draft when the repair reply is broken", async () => {
  replies = [warned, "not json at all"];
  const { body } = await (await signedIn()).post("/ai/draft").send({ request: "ask the boss" }).expect(200);
  expect(body.name).toBe("Approval");
  expect(body.warnings).toHaveLength(2);
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

// What the model is sent holds only what the browser wrote: no form text, run data, team address, secret or business profile.
const REAL = { submission: "SENSITIVE-SUBMISSION-TEXT-91", secret: "sk_live_SECRET-VALUE-77", business: "Acme Private Dental", inbox: "inbox@acme-private.test" };

async function ownerWithPrivateData() {
  const owner = request.agent(server);
  const email = `real.owner${++seq}@acme-private.test`;
  await owner.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const member = `real.member${seq}@acme-private.test`;
  const invite = await owner.post("/workspace/invites").send({ email: member, role: "approver" }).expect(201);
  await request(server).post(`/auth/invites/${/#\/invite\/(\S+)$/.exec(invite.body.link)![1]}/accept`).send({ password: "correct horse battery" }).expect(200);
  await owner.put("/settings/email/profile").send({ businessName: REAL.business, website: "https://acme-private.test", inquiryEmail: REAL.inbox, replyTo: REAL.inbox }).expect(204);
  await owner.put("/secrets/crm_key").send({ value: REAL.secret }).expect(204);
  const fields = [{ name: "message", label: "Message", type: "text", required: true }];
  const wf = await owner.post("/workflows").send({ name: "Inquiries", slug: `inq-${seq}` }).expect(201);
  const definition = { trigger: { type: "form", config: { fields } }, steps: [{ id: "wait", type: "delay", config: { seconds: 1 } }], edges: [] };
  await owner.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  const detail = (await owner.get(`/workflows/${wf.body.id}`).expect(200)).body;
  await request(server).post(`/forms/${detail.trigger.id}`).type("form").send({ message: REAL.submission, _website: "" }).expect(200);
  return { owner, emails: [email, member] };
}

const requestText = ["Thank people who fill my form.", "Tell the owner (owner@people.invalid).", "Tell approver member1@people.invalid.", "Apps connected: google_sheets, slack."].join("\n");

function expectNothingReal(emails: string[]) {
  const sent = JSON.stringify(asked);
  for (const real of [...Object.values(REAL), ...emails]) expect(sent).not.toContain(real);
}

it("sends the model no private workspace data, only the labels in the request", async () => {
  const { owner, emails } = await ownerWithPrivateData();
  replies = [valid];
  await owner.post("/ai/draft").send({ request: requestText }).expect(200);
  expect(asked).toHaveLength(1);
  expectNothingReal(emails);
  expect(JSON.stringify(asked)).toContain("owner@people.invalid");
  expect(JSON.stringify(asked)).toContain("member1@people.invalid");
});

it("sends a change request with the placeholders from the current draft and still no private data", async () => {
  const { owner, emails } = await ownerWithPrivateData();
  replies = [valid];
  const current = { trigger: { type: "manual", config: {} }, steps: [{ id: "tell", type: "email", config: { to: "owner@people.invalid", subject: "Hi", text: "ok" } }], edges: [] };
  await owner.post("/ai/draft").send({ request: requestText, current }).expect(200);
  expectNothingReal(emails);
  expect(asked[0]!.messages.at(-1)!.content).toContain(JSON.stringify(current));
});

it("sends no private data when the model fails twice either", async () => {
  const { owner, emails } = await ownerWithPrivateData();
  replies = ["", ""];
  const res = await owner.post("/ai/draft").send({ request: requestText }).expect(422);
  expect(asked).toHaveLength(2);
  expectNothingReal(emails);
  expect(JSON.stringify(res.body)).not.toContain("acme-private");
});
