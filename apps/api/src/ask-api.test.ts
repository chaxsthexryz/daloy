import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { claimUsage, deliveries, joinWorkspace, requests, runs, sessions, stepRuns, usageCounts, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";

let app: INestApplication;
let off: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let offServer: Parameters<typeof request>[0];
let llm: Server;
let llmUrl: string;

// A fake Ollama that records the exact body it was sent.
const reply = "Naka-post na ang request. Tingnan ang Activity.";
const wires: string[] = [];

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  const secretsKey = randomBytes(32);
  app = await createApp({ db, boss, secretsKey, secureCookies: false, ask: true });
  off = await createApp({ db, boss, secretsKey, secureCookies: false });
  await app.init();
  await off.init();
  server = app.getHttpServer();
  offServer = off.getHttpServer();
  llm = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      wires.push(raw);
      res.end(JSON.stringify({ message: { content: reply }, prompt_eval_count: 1, eval_count: 1 }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  llm?.close();
  await app?.close();
  await off?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

beforeEach(() => {
  wires.length = 0;
  vi.stubEnv("LLM_BASE_URL", llmUrl);
});

let seq = 0;
async function owner(srv = server) {
  const agent = request.agent(srv);
  const res = await agent.post("/auth/register").send({ email: `ask${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}
async function member(workspaceId: string, role: "operator" | "approver" | "requester") {
  const [u] = await db.insert(users).values({ email: `${role}${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}

const MARK = { name: "ZEBRAFLOW-NAME", label: "LABELMARK-ONE", secret: "sk_live_SECRETVALUE9", subject: "SUBJECTMARK for Maria Santos" };

/** A failed request: a failing http step and a failed Slack delivery, with private text in every place that holds text. */
async function failedRequest(userId: string) {
  const reference = `REQ-ASK${++seq}Z`;
  const [wf] = await db.insert(workflows).values({ userId, name: MARK.name, slug: `ask-${seq}` }).returning();
  const definition = { trigger: { type: "manual", config: {} }, steps: [{ id: "send_to_maria", type: "http", label: MARK.label, config: {} }], edges: [] };
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition }).returning();
  const [r] = await db
    .insert(runs)
    .values({
      workflowVersionId: v!.id,
      state: "failed",
      triggerPayload: { name: "Maria Santos", email: "maria@example.com", booking: { starts: "2026-03-01T15:00" }, secret: MARK.secret },
      error: `step send_to_maria: HTTP 404 from https://x.test/path?token=abc123 for maria@example.com ${MARK.secret}`,
    })
    .returning();
  await db.insert(stepRuns).values({
    runId: r!.id,
    stepId: "send_to_maria",
    attempt: 1,
    state: "failed",
    error: "HTTP 404 from x.test/path?token=abc123",
    input: { url: "https://x.test/path?token=abc123", body: "Maria Santos 3pm", key: MARK.secret },
    output: { email: "maria@example.com" },
    outcome: "rejected",
  });
  await db.insert(deliveries).values({ userId, runId: r!.id, stepId: "send_to_maria", provider: "slack", reference, payload: { text: "Maria Santos 3pm" }, state: "failed", attempts: 2, errorKind: "permission", lastError: "refused #maria-vip" });
  await db.insert(requests).values({ userId, workflowId: wf!.id, runId: r!.id, reference, submissionKey: randomUUID(), subject: MARK.subject });
  return { runId: r!.id, reference };
}

const snapshot = async (runId: string) => JSON.stringify([await db.select().from(runs).where(eq(runs.id, runId)), await db.select().from(stepRuns).where(eq(stepRuns.runId, runId)), await db.select().from(deliveries).where(eq(deliveries.runId, runId))]);
const used = async (userId: string) => (await db.select().from(usageCounts).where(and(eq(usageCounts.userId, userId), eq(usageCounts.kind, "ai")))).reduce((n, c) => n + c.used, 0);
const reword = (agent: ReturnType<typeof request.agent>, reference: string, extra = {}) => agent.post("/runs/ask/reword").send({ reference, question: "why", ...extra });

describe("the switch", () => {
  it("is off by default: both routes are 404 and /auth/me says so", async () => {
    const { agent, id } = await owner(offServer);
    const { reference } = await failedRequest(id);
    await agent.get("/runs/ask").query({ reference }).expect(404);
    await agent.post("/runs/ask/reword").send({ reference, question: "why" }).expect(404);
    expect((await agent.get("/auth/me").expect(200)).body.ask).toBe(false);
  });
  it("shows in /auth/me when on", async () => {
    const { agent } = await owner();
    expect((await agent.get("/auth/me").expect(200)).body.ask).toBe(true);
  });
});

describe("GET /runs/ask", () => {
  it("answers an owner with fixed text and no model call", async () => {
    const { agent, id } = await owner();
    const { runId, reference } = await failedRequest(id);
    const { body } = await agent.get("/runs/ask").query({ reference }).expect(200);
    expect(body).toMatchObject({ runId, reference, workflowName: MARK.name });
    expect(body.answers.happened.headline).toBe("This request stopped with a problem.");
    expect(body.answers.why.headline).toContain("Slack");
    expect(body.answers.next.lines.at(-1)).toBe("Open the request in Activity to see every step.");
    expect(wires).toHaveLength(0);
    expect(await used(id)).toBe(0);
  });
  it("answers an operator but not an approver or a requester", async () => {
    const { id } = await owner();
    const { reference } = await failedRequest(id);
    await (await member(id, "operator")).get("/runs/ask").query({ reference }).expect(200);
    await (await member(id, "approver")).get("/runs/ask").query({ reference }).expect(403);
    await (await member(id, "requester")).get("/runs/ask").query({ reference }).expect(403);
  });
  it("is 404 for another workspace's reference and for an unknown one", async () => {
    const a = await owner();
    const b = await owner();
    const { reference } = await failedRequest(a.id);
    await b.agent.get("/runs/ask").query({ reference }).expect(404);
    await b.agent.get("/runs/ask").query({ reference: "REQ-NOPE00" }).expect(404);
    await b.agent.get("/runs/ask").expect(400);
  });
  it("answers with the model down", async () => {
    const { agent, id } = await owner();
    const { reference } = await failedRequest(id);
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9");
    await agent.get("/runs/ask").query({ reference }).expect(200);
    await reword(agent, reference).expect(502);
  });
});

describe("POST /runs/ask/reword", () => {
  it("lets an owner only, and 404 for another workspace", async () => {
    const a = await owner();
    const b = await owner();
    const { reference } = await failedRequest(a.id);
    await reword(await member(a.id, "operator"), reference).expect(403);
    await reword(await member(a.id, "approver"), reference).expect(403);
    await reword(b.agent, reference).expect(404);
    expect(wires).toHaveLength(0);
    expect((await reword(a.agent, reference).expect(200)).body).toEqual({ text: reply });
  });
  it("is a 409 for a question with no answer", async () => {
    const { agent, id } = await owner();
    const { runId, reference } = await failedRequest(id);
    await db.update(runs).set({ state: "succeeded" }).where(eq(runs.id, runId));
    await db.update(deliveries).set({ state: "delivered" }).where(eq(deliveries.runId, runId));
    await reword(agent, reference).expect(409);
    await reword(agent, reference, { question: "happened" }).expect(200);
  });
  it("costs one AI action, and stops with 429 once they are used up", async () => {
    const { agent, id } = await owner();
    await db.update(users).set({ plan: "pilot", planStartedOn: "2026-01-01" }).where(eq(users.id, id));
    const { reference } = await failedRequest(id);
    await reword(agent, reference).expect(200);
    expect(await used(id)).toBe(1);
    await claimUsage(db, id, "ai", { n: 99 });
    wires.length = 0;
    expect((await reword(agent, reference).expect(429)).body.message).toMatch(/AI actions/);
    expect(wires).toHaveLength(0);
  });
  it("sends the model only the question, language, closed-set facts and the fixed answer", async () => {
    const { agent, id } = await owner();
    const { runId, reference } = await failedRequest(id);
    await reword(agent, reference, { language: "tl" }).expect(200);
    expect(wires).toHaveLength(1);
    const wire = wires[0]!;
    for (const s of ["Maria", "maria@example.com", "3pm", "15:00", "2026-03-01", MARK.secret, "x.test", "token", "abc123", "send_to_maria", "maria-vip", MARK.name, MARK.label, MARK.subject, reference, runId]) expect(wire).not.toContain(s);
    const sent = (JSON.parse(wire) as { messages: { role: string; content: string }[] }).messages;
    const user = JSON.parse(sent.find((m) => m.role === "user")!.content) as { language: string; facts: object };
    expect(Object.keys(user).sort()).toEqual(["facts", "fixed", "language", "question"]);
    expect(user.language).toBe("tl");
    expect(Object.keys(user.facts).sort()).toEqual(["deliveries", "lint", "plainState", "preview", "runState", "step", "steps"]);
  });
  it("changes no run, step or delivery row", async () => {
    const { agent, id } = await owner();
    const { runId, reference } = await failedRequest(id);
    const before = await snapshot(runId);
    await agent.get("/runs/ask").query({ reference }).expect(200);
    await reword(agent, reference).expect(200);
    expect(await snapshot(runId)).toBe(before);
  });
});
