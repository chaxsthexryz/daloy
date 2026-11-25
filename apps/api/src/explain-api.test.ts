import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { claimUsage, deliveries, joinWorkspace, runs, sessions, stepRuns, usageCounts, users, workflows, workflowVersions, type Db } from "@daloy/db";
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
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let llm: Server;
let llmUrl: string;

// A fake Ollama that records what it was asked.
let reply = "The automation could not post to Slack. Check Apps, then try again from Activity.";
const asked: { messages: { role: string; content: string }[] }[] = [];

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();
  llm = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      asked.push(JSON.parse(raw) as (typeof asked)[number]);
      res.end(JSON.stringify({ message: { content: reply }, prompt_eval_count: 1, eval_count: 1 }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  vi.stubEnv("LLM_BASE_URL", llmUrl);
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
  vi.stubEnv("LLM_BASE_URL", llmUrl);
});

let seq = 0;
async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `explain${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}

/** A failed run with request text, an address and a failing step, plus a failed Slack delivery that names a channel. */
async function failedRun(userId: string, state: "failed" | "succeeded" = "failed") {
  const [wf] = await db.insert(workflows).values({ userId, name: "Maria intake", slug: `maria-${++seq}` }).returning();
  const definition = {
    trigger: { type: "manual", config: {} },
    steps: [{ id: "send_to_maria", type: "http", config: {} }],
    edges: [],
  };
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition }).returning();
  const [r] = await db
    .insert(runs)
    .values({
      workflowVersionId: v!.id,
      state,
      triggerPayload: { form: "Maria Santos needs a 3pm cleaning", email: "maria@example.com", booking: { starts: "2026-03-01T15:00" } },
      error: state === "failed" ? "step send_to_maria: HTTP 404 from api.example.com/x?token=s3cret" : null,
    })
    .returning();
  await db.insert(stepRuns).values({ runId: r!.id, stepId: "send_to_maria", attempt: 1, state: "failed", error: "HTTP 404 from api.example.com/x?token=s3cret", input: { url: "https://api.example.com/x?token=s3cret" }, outcome: "rejected" });
  await db.insert(deliveries).values({
    userId,
    runId: r!.id,
    stepId: "send_to_maria",
    provider: "slack",
    reference: "REQ-1",
    payload: { text: "Maria Santos needs a 3pm cleaning" },
    state: "failed",
    attempts: 2,
    errorKind: "permission",
    lastError: "Slack refused the post to #maria-vip-clients",
  });
  return r!.id;
}

const snapshot = async (runId: string) => JSON.stringify([await db.select().from(runs).where(eq(runs.id, runId)), await db.select().from(stepRuns).where(eq(stepRuns.runId, runId)), await db.select().from(deliveries).where(eq(deliveries.runId, runId))]);
const used = async (userId: string) => (await db.select().from(usageCounts).where(and(eq(usageCounts.userId, userId), eq(usageCounts.kind, "ai")))).reduce((n, c) => n + c.used, 0);

describe("GET /runs/:id/explanation", () => {
  it("returns facts and the fixed explanation without calling the model or using an AI action", async () => {
    const { agent, id } = await owner();
    const runId = await failedRun(id);
    const { body } = await agent.get(`/runs/${runId}/explanation`).expect(200);
    expect(body.facts.deliveries).toEqual([{ provider: "slack", state: "failed", errorKind: "permission", attempts: 2 }]);
    expect(body.fixed.headline).toContain("Slack");
    expect(asked).toHaveLength(0);
    expect(await used(id)).toBe(0);
  });
  it("is null for a run that did not fail", async () => {
    const { agent, id } = await owner();
    const [wf] = await db.insert(workflows).values({ userId: id, name: "Ok", slug: `ok-${++seq}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: { trigger: { type: "manual", config: {} }, steps: [], edges: [] } }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "succeeded" }).returning();
    const res = await agent.get(`/runs/${r!.id}/explanation`).expect(200);
    // Nest sends a null as an empty body; the API client reads that as null.
    expect(res.text).toBe("");
  });
  it("is 404 for another workspace's run", async () => {
    const a = await owner();
    const b = await owner();
    await b.agent.get(`/runs/${await failedRun(a.id)}/explanation`).expect(404);
  });
  it("still answers with the model down and spends 0 AI quota on a 502 reword", async () => {
    const { agent, id } = await owner();
    const runId = await failedRun(id);
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9");
    expect((await agent.get(`/runs/${runId}/explanation`).expect(200)).body.fixed.headline).toBeTruthy();
    const res = await agent.post(`/runs/${runId}/explanation/reword`).expect(502);
    expect(res.body.message).toBeTruthy();
    expect(await used(id)).toBe(0);
  });
});

describe("POST /runs/:id/explanation/reword", () => {
  it("sends the model only closed-set facts and the fixed text", async () => {
    const { agent, id } = await owner();
    const runId = await failedRun(id);
    const { body } = await agent.post(`/runs/${runId}/explanation/reword`).expect(200);
    expect(body).toEqual({ text: reply });
    expect(asked).toHaveLength(1);
    const sent = asked[0]!.messages;
    expect(sent[0]!.content.startsWith("You explain why a kymavo automation stopped")).toBe(true);
    const wire = JSON.stringify(asked[0]);
    for (const s of ["Maria", "maria@example.com", "3pm", "api.example.com", "token", "s3cret", "send_to_maria", "maria-vip-clients"]) expect(wire).not.toContain(s);
    const user = JSON.parse(sent.find((m) => m.role === "user")!.content) as { facts: object };
    expect(Object.keys(user).sort()).toEqual(["facts", "fixed", "language"]);
    expect(Object.keys(user.facts).sort()).toEqual(["deliveries", "lint", "preview", "runState", "step"]);
  });
  it("changes no run, step or delivery row", async () => {
    const { agent, id } = await owner();
    const runId = await failedRun(id);
    const before = await snapshot(runId);
    await agent.post(`/runs/${runId}/explanation/reword`).expect(200);
    expect(await snapshot(runId)).toBe(before);
  });
  it("costs one AI action, and stops with 429 once they are used up", async () => {
    const { agent, id } = await owner();
    await db.update(users).set({ plan: "pilot", planStartedOn: "2026-01-01" }).where(eq(users.id, id));
    const runId = await failedRun(id);
    await agent.post(`/runs/${runId}/explanation/reword`).expect(200);
    expect(await used(id)).toBe(1);
    await claimUsage(db, id, "ai", { n: 99 });
    asked.length = 0;
    const res = await agent.post(`/runs/${runId}/explanation/reword`).expect(429);
    expect(res.body.message).toMatch(/AI actions/);
    expect(asked).toHaveLength(0);
  });
  it("is a 502 when the reply is empty or holds a link", async () => {
    const { agent, id } = await owner();
    const runId = await failedRun(id);
    for (const bad of ["", "See https://example.com for help", "Open www.example.com"]) {
      reply = bad;
      expect((await agent.post(`/runs/${runId}/explanation/reword`).expect(502)).body.message).toBe("The AI model could not answer.");
    }
    // The words HTTP and request are fine; only a link is refused.
    reply = "The HTTP request was refused.";
    expect((await agent.post(`/runs/${runId}/explanation/reword`).expect(200)).body.text).toBe("The HTTP request was refused.");
    reply = "Fine.";
  });
  it("is a 409 when there is nothing to explain", async () => {
    const { agent, id } = await owner();
    const runId = await failedRun(id, "succeeded");
    await db.update(deliveries).set({ state: "delivered" }).where(eq(deliveries.runId, runId));
    await agent.post(`/runs/${runId}/explanation/reword`).expect(409);
  });
  it("lets an operator read but not reword", async () => {
    const { id } = await owner();
    const runId = await failedRun(id);
    const [u] = await db.insert(users).values({ email: `op${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
    await joinWorkspace(db, u!.id, id, "operator");
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    const op = request.agent(server).set("Cookie", `daloy_session=${token}`);
    await op.get(`/runs/${runId}/explanation`).expect(200);
    await op.post(`/runs/${runId}/explanation/reword`).expect(403);
    expect(asked).toHaveLength(0);
  });
});
