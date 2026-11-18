import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { claimUsage, joinWorkspace, manilaDay, planOf, requests, runs, SCHEDULE_QUEUE, sessions, users, type Db } from "@daloy/db";
import { defaultAnswers, officeRequestDefinition, TEMPLATES } from "@daloy/engine";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let llm: Server;
type Agent = ReturnType<typeof request.agent>;

// A fake Ollama that answers with the queued replies in order and counts the calls.
let replies: string[] = [];
let asked = 0;
const valid = JSON.stringify({ name: "Contact form triage", summary: "Thanks the sender.", definition: TEMPLATES[0]!.definition });
const invalid = JSON.stringify({ name: "Broken", summary: "x", definition: { trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "sms", config: {} }], edges: [] } });

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();
  llm = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      asked++;
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
  asked = 0;
});

let seq = 0;
async function owner(plan?: "pilot" | "business" | "business_plus") {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `quota${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  const id = res.body.id as string;
  if (plan) await setPlan(id, plan);
  return { agent, id };
}
const setPlan = (id: string, plan: string | null) => db.update(users).set({ plan, planStartedOn: plan ? "2026-01-01" : null }).where(eq(users.id, id));

const manual = { trigger: { type: "manual", config: {} }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
const scheduled = (cron: string) => ({ ...manual, trigger: { type: "schedule", config: { cron } } });
const newWorkflow = async (agent: Agent) => (await agent.post("/workflows").send({ name: "W", slug: `q-${++seq}` }).expect(201)).body.id as string;
const publish = (agent: Agent, id: string, definition: object = manual) => agent.post(`/workflows/${id}/versions`).send({ definition, publish: true });
async function live(agent: Agent, n: number) {
  for (let i = 0; i < n; i++) await publish(agent, await newWorkflow(agent)).expect(201);
}

describe("Build with AI quota", () => {
  it("answers 429 with the message and never calls the model at the limit", async () => {
    const { agent, id } = await owner("pilot");
    await claimUsage(db, id, "ai", { n: 100 });
    const res = await agent.post("/ai/draft").send({ request: "thank people" }).expect(429);
    expect(res.body.message).toMatch(/used its 100 AI actions/);
    expect(asked).toBe(0);
  });

  it("counts one request as one action even when it tries twice", async () => {
    const { agent, id } = await owner("pilot");
    replies = [invalid, valid];
    await agent.post("/ai/draft").send({ request: "thank people" }).expect(200);
    expect(asked).toBe(2);
    expect((await agent.get("/usage").expect(200)).body.ai.used).toBe(1);
    expect(id).toBeTruthy();
  });

  it("has no limit without a plan", async () => {
    const { agent, id } = await owner();
    await claimUsage(db, id, "ai", { n: 5000 });
    replies = [valid];
    await agent.post("/ai/draft").send({ request: "thank people" }).expect(200);
  });
});

describe("live automation limit", () => {
  it("refuses a new live automation at the limit with 403", async () => {
    const { agent } = await owner("business");
    await live(agent, 5);
    const wf = await newWorkflow(agent);
    const res = await publish(agent, wf).expect(403);
    expect(res.body.message).toBe("Your Business plan allows 5 live automations. Delete one, or ask Daloy to move you to a larger plan.");
    // A draft is free, and nothing was published.
    await agent.post(`/workflows/${wf}/versions`).send({ definition: manual }).expect(201);
    expect((await agent.get("/usage")).body.automations).toEqual({ live: 5, limit: 5 });
  });

  it("lets an already live automation be published again at the limit", async () => {
    const { agent } = await owner("pilot");
    const wf = await newWorkflow(agent);
    await publish(agent, wf).expect(201);
    await publish(agent, wf).expect(201);
  });

  it("lets exactly one of several parallel publishes through at limit minus one", async () => {
    const { agent } = await owner("business");
    await live(agent, 4);
    const ids = await Promise.all(Array.from({ length: 6 }, () => newWorkflow(agent)));
    const statuses = (await Promise.all(ids.map((id) => publish(agent, id)))).map((r) => r.status);
    expect(statuses.filter((x) => x === 201)).toHaveLength(1);
    expect(statuses.filter((x) => x === 403)).toHaveLength(5);
  });

  it("has no limit without a plan", async () => {
    const { agent } = await owner();
    await live(agent, 20);
  });
});

describe("schedule interval", () => {
  it("refuses a schedule that fires too often with 400 and schedules nothing", async () => {
    const { agent } = await owner("pilot");
    const wf = await newWorkflow(agent);
    const res = await publish(agent, wf, scheduled("*/5 * * * *")).expect(400);
    expect(res.body.message).toBe("Your Pilot plan runs a schedule at most once every 60 minutes. Pick a less frequent schedule, or ask Daloy to move you to a larger plan.");
    expect(await boss.getSchedules(SCHEDULE_QUEUE, wf)).toEqual([]);
    await publish(agent, wf, scheduled("0 9 * * 1")).expect(201);
  });

  it("checks a seconds field too, and the gap between later fires", async () => {
    const { agent } = await owner("business");
    const wf = await newWorkflow(agent);
    await publish(agent, wf, scheduled("*/30 * * * * *")).expect(400);
    await publish(agent, wf, scheduled("0,10 9 * * *")).expect(400);
    await publish(agent, wf, scheduled("*/15 * * * *")).expect(201);
  });

  it("has no limit without a plan", async () => {
    const { agent } = await owner();
    await publish(agent, await newWorkflow(agent), scheduled("* * * * *")).expect(201);
  });
});

describe("GET /usage", () => {
  it("returns the summary to the owner and an operator, and refuses other roles", async () => {
    const { agent, id } = await owner("business");
    await live(agent, 1);
    const res = await agent.get("/usage").expect(200);
    expect(res.body).toMatchObject({
      plan: "business",
      label: "Business",
      ai: { used: 0, limit: 500 },
      email: { used: 0, limit: 300 },
      http: { used: 0, limit: 1000 },
      automations: { live: 1, limit: 5 },
      minScheduleMinutes: 15,
    });
    const as = async (role: "operator" | "approver") => {
      const [u] = await db.insert(users).values({ email: `${role}${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
      await joinWorkspace(db, u!.id, id, role);
      const token = randomBytes(32).toString("base64url");
      await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
      return request.agent(server).set("Cookie", `daloy_session=${token}`);
    };
    await (await as("operator")).get("/usage").expect(200);
    await (await as("approver")).get("/usage").expect(403);
    await request(server).get("/usage").expect(401);
  });

  it("shows no limits without a plan", async () => {
    const { agent } = await owner();
    expect((await agent.get("/usage").expect(200)).body).toMatchObject({ plan: null, limits: null, automations: { live: 0, limit: null }, minScheduleMinutes: null });
  });
});

describe("forms and webhooks are never blocked", () => {
  it("still takes a form request and a webhook run with every limit reached", async () => {
    const { agent, id } = await owner();
    const answers = defaultAnswers("office@test.local");
    const form = await agent.post("/workflows").send({ name: "Office requests", slug: "office" }).expect(201);
    await agent.patch(`/workflows/${form.body.id}/setup`).send({ step: "review", answers }).expect(200);
    await publish(agent, form.body.id, officeRequestDefinition(answers)).expect(201);
    const hook = await newWorkflow(agent);
    await publish(agent, hook, { ...manual, trigger: { type: "webhook", config: {} } }).expect(201);
    const formId = (await agent.get(`/workflows/${form.body.id}`)).body.trigger.id as string;
    const path = (await agent.get(`/workflows/${hook}`)).body.trigger.webhookPath as string;

    // Two live automations on the one-automation plan, and every counter used up.
    await setPlan(id, "pilot");
    for (const [kind, n] of [["ai", 100], ["email", 100], ["http", 200]] as const) await claimUsage(db, id, kind, { n });
    await publish(agent, await newWorkflow(agent)).expect(403);

    const submission = { name: "Rosa Diaz", email: "rosa@example.com", summary: "The printer is jammed.", location: "Floor 2", submission_key: randomUUID() };
    await request(server).post(`/forms/${formId}`).type("form").send(submission).expect(200);
    expect(await db.select().from(requests).where(eq(requests.workflowId, form.body.id))).toHaveLength(1);
    const res = await request(server).post(`/hooks/${path}`).send({ order: 1 }).expect(202);
    expect((await db.select().from(runs).where(eq(runs.id, res.body.runId))).length).toBe(1);
  });
});

describe("a fresh public sign-up (M6)", () => {
  const signUp = async () => {
    const agent = request.agent(server);
    const res = await agent.post("/auth/register").send({ email: `fresh${++seq}@test.local`, password: "correct horse battery" }).expect(201);
    return { agent, id: res.body.id as string };
  };

  it("gets the preview plan: one live automation, nothing faster than hourly, finite limits", async () => {
    vi.stubEnv("SIGNUP_PLAN", "preview");
    const { agent, id } = await signUp();
    expect(await planOf(db, id)).toMatchObject({ plan: "preview", startedOn: manilaDay() });
    await publish(agent, await newWorkflow(agent)).expect(201);
    await publish(agent, await newWorkflow(agent)).expect(403);
    await publish(agent, await newWorkflow(agent), scheduled("*/5 * * * *")).expect(400);
    expect((await agent.get("/usage").expect(200)).body).toMatchObject({ plan: "preview", label: "Preview", ai: { limit: 20 }, email: { limit: 20 }, http: { limit: 50 }, automations: { live: 1, limit: 1 }, minScheduleMinutes: 60 });
    vi.unstubAllEnvs();
  });

  it("keeps the old unlimited behaviour when the installation sets SIGNUP_PLAN=none", async () => {
    vi.stubEnv("SIGNUP_PLAN", "none");
    const { id } = await signUp();
    expect(await planOf(db, id)).toEqual({ plan: null, startedOn: null });
    vi.unstubAllEnvs();
  });
});
