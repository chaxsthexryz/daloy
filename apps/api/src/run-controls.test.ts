import { randomBytes } from "node:crypto";
import { joinWorkspace, requests, runs, sessions, stepRuns, users, WorkflowPausedError, workflowVersions, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";
import { recordRequest } from "./public";

// N11b: pause and cancel through the API, and every route that starts a run.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

type Agent = ReturnType<typeof request.agent>;
let seq = 0;
async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `rc${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}
async function member(ownerAgent: Agent, role: "operator" | "approver" | "requester") {
  const workspaceId = (await ownerAgent.get("/auth/me").expect(200)).body.workspaceId as string;
  const [u] = await db.insert(users).values({ email: `rc${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}
const delays = (trigger: object) => ({ trigger, steps: [{ id: "a", type: "delay", config: { seconds: 3600 } }], edges: [] });
async function published(agent: Agent, trigger: object) {
  const wf = await agent.post("/workflows").send({ name: "T", slug: `rc-${++seq}` }).expect(201);
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: delays(trigger), publish: true }).expect(201);
  return (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body;
}
const runCount = async (workflowId: string) =>
  (await db.select({ id: runs.id }).from(runs).innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId)).where(eq(workflowVersions.workflowId, workflowId))).length;

describe("pause", () => {
  it("pauses and resumes, shows it on the list and the workflow, and is repeatable", async () => {
    const { agent } = await owner();
    const wf = await published(agent, { type: "manual", config: {} });
    expect(wf.pausedAt).toBeNull();
    await agent.post(`/workflows/${wf.id}/pause`).expect(204);
    await agent.post(`/workflows/${wf.id}/pause`).expect(204);
    expect((await agent.get(`/workflows/${wf.id}`).expect(200)).body.pausedAt).toEqual(expect.any(String));
    expect((await agent.get("/workflows").expect(200)).body.find((w: { id: string }) => w.id === wf.id).pausedAt).toEqual(expect.any(String));
    await agent.post(`/workflows/${wf.id}/resume`).expect(204);
    await agent.post(`/workflows/${wf.id}/resume`).expect(204);
    expect((await agent.get(`/workflows/${wf.id}`).expect(200)).body.pausedAt).toBeNull();
  });

  it("is for the owner of that workspace: other workspaces get 404, operators and approvers 403, signed-out 401", async () => {
    const a = await owner();
    const b = await owner();
    const wf = await published(a.agent, { type: "manual", config: {} });
    await b.agent.post(`/workflows/${wf.id}/pause`).expect(404);
    await b.agent.post(`/workflows/${wf.id}/resume`).expect(404);
    for (const role of ["operator", "approver", "requester"] as const) await (await member(a.agent, role)).post(`/workflows/${wf.id}/pause`).expect(403);
    await request(server).post(`/workflows/${wf.id}/pause`).expect(401);
    expect((await a.agent.get(`/workflows/${wf.id}`).expect(200)).body.pausedAt).toBeNull();
  });

  it("answers a webhook call with 409 and a plain message, starts nothing, and accepts calls again after the resume", async () => {
    const { agent } = await owner();
    const wf = await published(agent, { type: "webhook", config: {} });
    const call = () => request(server).post(`/hooks/${wf.trigger.webhookPath}`).send({ n: 1 });
    await call().expect(202);
    await agent.post(`/workflows/${wf.id}/pause`).expect(204);
    const res = await call().expect(409);
    expect(res.body.message).toBe("This automation is paused, so it starts no new runs. Resume it to start runs again.");
    expect(await runCount(wf.id)).toBe(1);
    await agent.post(`/workflows/${wf.id}/resume`).expect(204);
    await call().expect(202);
    expect(await runCount(wf.id)).toBe(2);
  });

  it("answers a public form with a paused page and 409, starts nothing, and shows the form again after the resume", async () => {
    const { agent } = await owner();
    const fields = [{ name: "name", label: "Name", type: "text", required: true }];
    const wf = await published(agent, { type: "form", config: { fields } });
    await agent.post(`/workflows/${wf.id}/pause`).expect(204);
    const page = await request(server).get(`/forms/${wf.trigger.id}`).expect(200);
    expect(page.text).toContain("This form is paused");
    expect(page.text).not.toContain('name="_website"');
    const sent = await request(server).post(`/forms/${wf.trigger.id}`).type("form").send({ name: "Ana", _website: "" }).expect(409);
    expect(sent.text).toContain("This form is paused");
    expect(await runCount(wf.id)).toBe(0);
    await agent.post(`/workflows/${wf.id}/resume`).expect(204);
    expect((await request(server).get(`/forms/${wf.trigger.id}`).expect(200)).text).toContain('name="_website"');
    await request(server).post(`/forms/${wf.trigger.id}`).type("form").send({ name: "Ana", _website: "" }).expect(200);
    expect(await runCount(wf.id)).toBe(1);
  });

  it("refuses the console Run button, but a builder test run still works", async () => {
    const { agent } = await owner();
    const wf = await published(agent, { type: "manual", config: {} });
    await agent.post(`/workflows/${wf.id}/pause`).expect(204);
    const res = await agent.post(`/workflows/${wf.id}/runs`).send({ payload: {} }).expect(409);
    expect(res.body.message).toContain("paused");
    await agent.post(`/workflows/${wf.id}/test-runs`).send({ definition: delays({ type: "manual", config: {} }), payload: {} }).expect(202);
    expect(await runCount(wf.id)).toBe(1);
  });

  it("refuses a tracked request form submission without leaving a request behind", async () => {
    const { agent, id } = await owner();
    const wf = await published(agent, { type: "manual", config: {} });
    const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf.id)))[0]!;
    await agent.post(`/workflows/${wf.id}/pause`).expect(204);
    await expect(recordRequest(db, { id: wf.id, userId: id }, version.id, "6f1a2b3c-0000-4000-8000-000000000001", { summary: "x" })).rejects.toBeInstanceOf(WorkflowPausedError);
    expect(await db.select().from(requests).where(eq(requests.workflowId, wf.id))).toEqual([]);
    expect(await runCount(wf.id)).toBe(0);
  });
});

describe("cancel a pending run", () => {
  async function waitingRun(agent: Agent) {
    const wf = await published(agent, { type: "manual", config: {} });
    const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf.id)))[0]!;
    const [run] = await db.insert(runs).values({ workflowVersionId: version.id, triggerPayload: {}, state: "waiting", nextAttemptAt: new Date(Date.now() + 3_600_000) }).returning();
    await db.insert(stepRuns).values({ runId: run!.id, stepId: "a", attempt: 1, state: "waiting" });
    return run!.id;
  }

  it("cancels a waiting run, and a second cancel is a 409 that names the state", async () => {
    const { agent } = await owner();
    const id = await waitingRun(agent);
    await agent.post(`/runs/${id}/cancel`).expect(204);
    expect((await db.select().from(runs).where(eq(runs.id, id)))[0]).toMatchObject({ state: "cancelled" });
    const again = await agent.post(`/runs/${id}/cancel`).expect(409);
    expect(again.body.message).toBe("This run is cancelled, so it cannot be cancelled.");
  });

  it("says to use Stop for a run in review and refuses a running one", async () => {
    const { agent } = await owner();
    const id = await waitingRun(agent);
    await db.update(runs).set({ state: "needs_review" }).where(eq(runs.id, id));
    expect((await agent.post(`/runs/${id}/cancel`).expect(409)).body.message).toBe("This run is in review, so use Stop.");
    await db.update(runs).set({ state: "running" }).where(eq(runs.id, id));
    expect((await agent.post(`/runs/${id}/cancel`).expect(409)).body.message).toBe("This run is running right now, so it cannot be cancelled. It stops at its next wait.");
  });

  it("is for owners and operators of that workspace: another workspace gets 404, approvers 403", async () => {
    const a = await owner();
    const b = await owner();
    const id = await waitingRun(a.agent);
    await b.agent.post(`/runs/${id}/cancel`).expect(404);
    await (await member(a.agent, "approver")).post(`/runs/${id}/cancel`).expect(403);
    await request(server).post(`/runs/${id}/cancel`).expect(401);
    await (await member(a.agent, "operator")).post(`/runs/${id}/cancel`).expect(204);
  });

  it("gives an unknown id a 404 and a malformed one a 400", async () => {
    const { agent } = await owner();
    await agent.post("/runs/00000000-0000-4000-8000-000000000000/cancel").expect(404);
    await agent.post("/runs/not-an-id/cancel").expect(400);
  });
});
