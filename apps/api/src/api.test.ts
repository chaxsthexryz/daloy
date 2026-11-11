import { createHmac, randomBytes } from "node:crypto";
import { apiTokens, runs, secrets, SCHEDULE_QUEUE, users, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

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

let seq = 0;
async function signedIn() {
  const agent = request.agent(server);
  const email = `user${++seq}@test.local`;
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  return { agent, email };
}

const twoSteps = (trigger: object) => ({
  trigger,
  steps: [
    { id: "a", type: "http", config: {} },
    { id: "b", type: "email", config: {} },
  ],
  edges: [{ from: "a", to: "b" }],
});

async function publishedWorkflow(agent: ReturnType<typeof request.agent>, trigger: object) {
  const wf = await agent.post("/workflows").send({ name: "Test", slug: `wf-${++seq}` }).expect(201);
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: twoSteps(trigger), publish: true }).expect(201);
  return (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body;
}

describe("console auth", () => {
  it("registers with an argon2id hash and an httpOnly SameSite=Lax session cookie", async () => {
    const res = await request(server).post("/auth/register").send({ email: "a@test.local", password: "correct horse battery" }).expect(201);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/daloy_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const [user] = await db.select().from(users).where(eq(users.email, "a@test.local"));
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("rejects short passwords and duplicate emails", async () => {
    await request(server).post("/auth/register").send({ email: "b@test.local", password: "short" }).expect(400);
    await request(server).post("/auth/register").send({ email: "c@test.local", password: "correct horse battery" }).expect(201);
    await request(server).post("/auth/register").send({ email: "c@test.local", password: "correct horse battery" }).expect(409);
  });

  it("logs in, reports the user, and logs out", async () => {
    const { email } = await signedIn();
    const agent = request.agent(server);
    await agent.post("/auth/login").send({ email, password: "wrong password here" }).expect(401);
    await agent.post("/auth/login").send({ email, password: "correct horse battery" }).expect(200);
    expect((await agent.get("/auth/me").expect(200)).body.email).toBe(email);
    await agent.post("/auth/logout").expect(204);
    await agent.get("/auth/me").expect(401);
  });

  it("keeps console routes behind a session", async () => {
    await request(server).get("/workflows").expect(401);
    await request(server).get("/runs").expect(401);
    await request(server).get("/secrets").set("Cookie", "daloy_session=forged").expect(401);
  });

  it("sends security headers", async () => {
    const res = await request(server).get("/auth/me");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("workflows", () => {
  it("rejects an invalid definition and numbers published versions", async () => {
    const { agent } = await signedIn();
    const wf = await agent.post("/workflows").send({ name: "Inquiries", slug: "inquiries" }).expect(201);
    const bad = { ...twoSteps({ type: "manual" }), edges: [{ from: "a", to: "ghost" }] };
    await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: bad, publish: true }).expect(400);
    await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: twoSteps({ type: "manual" }), publish: true }).expect(201);
    const v2 = await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: twoSteps({ type: "manual" }), publish: false }).expect(201);
    expect(v2.body.version).toBe(2);
    const versions = (await agent.get(`/workflows/${wf.body.id}/versions`).expect(200)).body;
    expect(versions.map((v: { version: number; published: boolean }) => [v.version, v.published])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  it("hides one user's workflows from another", async () => {
    const owner = await signedIn();
    const wf = await owner.agent.post("/workflows").send({ name: "Mine", slug: "mine" }).expect(201);
    const other = await signedIn();
    await other.agent.get(`/workflows/${wf.body.id}`).expect(404);
    await other.agent.post(`/workflows/${wf.body.id}/runs`).send({ payload: {} }).expect(404);
    expect((await other.agent.get("/workflows").expect(200)).body).toEqual([]);
  });

  it("starts a manual run of the published version and lists it", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "manual" });
    const run = await agent.post(`/workflows/${wf.id}/runs`).send({ payload: { customer: "Ana" } }).expect(202);
    const [row] = await db.select().from(runs).where(eq(runs.id, run.body.id));
    expect(row!.triggerPayload).toEqual({ customer: "Ana" });
    const list = (await agent.get("/runs").expect(200)).body;
    expect(list.map((r: { id: string }) => r.id)).toContain(run.body.id);
    expect((await agent.get(`/runs/${run.body.id}`).expect(200)).body.steps).toEqual([]);
  });

  it("refuses a manual run before anything is published", async () => {
    const { agent } = await signedIn();
    const wf = await agent.post("/workflows").send({ name: "Draft", slug: "draft" }).expect(201);
    await agent.post(`/workflows/${wf.body.id}/runs`).send({ payload: {} }).expect(409);
  });

  it("registers and removes the pg-boss schedule of a schedule trigger", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "schedule", config: { cron: "0 9 * * 1" } });
    const schedules = await boss.getSchedules(SCHEDULE_QUEUE, wf.id);
    expect(schedules.map((s) => s.cron)).toEqual(["0 9 * * 1"]);
    await agent.post(`/workflows/${wf.id}/versions`).send({ definition: twoSteps({ type: "manual" }), publish: true }).expect(201);
    expect(await boss.getSchedules(SCHEDULE_QUEUE, wf.id)).toEqual([]);
  });
});

describe("secrets and API tokens", () => {
  it("stores secrets encrypted and never returns their values", async () => {
    const { agent } = await signedIn();
    await agent.put("/secrets/stripe_key").send({ value: "sk_test_plaintext" }).expect(204);
    const list = (await agent.get("/secrets").expect(200)).body;
    expect(list).toEqual([{ name: "stripe_key", createdAt: expect.any(String) }]);
    const [row] = await db.select().from(secrets).where(eq(secrets.name, "stripe_key"));
    expect(JSON.stringify(row)).not.toContain("sk_test_plaintext");
    await agent.delete("/secrets/stripe_key").expect(204);
    expect((await agent.get("/secrets").expect(200)).body).toEqual([]);
  });

  it("shows an API token once and stores only its hash", async () => {
    const { agent } = await signedIn();
    const created = (await agent.post("/tokens").send({ name: "claude" }).expect(201)).body;
    expect(created.token).toMatch(/^dly_/);
    const list = (await agent.get("/tokens").expect(200)).body;
    expect(JSON.stringify(list)).not.toContain(created.token);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, created.id));
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    await agent.delete(`/tokens/${created.id}`).expect(204);
    expect((await agent.get("/tokens").expect(200)).body[0].revokedAt).not.toBeNull();
  });
});

describe("webhook trigger", () => {
  it("starts a run from a POST to the random webhook path", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "webhook" });
    expect(wf.trigger.webhookPath).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const res = await request(server).post(`/hooks/${wf.trigger.webhookPath}`).send({ order: 42 }).expect(202);
    const [row] = await db.select().from(runs).where(eq(runs.id, res.body.runId));
    expect(row!.triggerPayload).toEqual({ order: 42 });
    await request(server).post(`/hooks/${"x".repeat(43)}`).send({}).expect(404);
  });

  it("checks the HMAC-SHA256 signature when the trigger names a secret", async () => {
    const { agent } = await signedIn();
    await agent.put("/secrets/hook_key").send({ value: "whsec_test" }).expect(204);
    const wf = await publishedWorkflow(agent, { type: "webhook", config: { hmacSecret: "hook_key" } });
    const body = JSON.stringify({ order: 7 });
    const sign = (key: string) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
    const post = () => request(server).post(`/hooks/${wf.trigger.webhookPath}`).set("Content-Type", "application/json");
    await post().send(body).expect(401);
    await post().set("X-Daloy-Signature", sign("wrong key")).send(body).expect(401);
    await post().set("X-Daloy-Signature", sign("whsec_test")).send(body).expect(202);
  });

  it("rejects bodies over the size limit", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "webhook" });
    await request(server).post(`/hooks/${wf.trigger.webhookPath}`).send({ blob: "x".repeat(300_000) }).expect(413);
  });
});

describe("form trigger", () => {
  const fields = [
    { name: "name", label: "Your <b>name</b>", type: "text", required: true },
    { name: "email", label: "Email", type: "email", required: true },
  ];

  it("renders the form with escaped labels and a honeypot", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "form", config: { fields } });
    const page = await request(server).get(`/forms/${wf.trigger.id}`).expect(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.text).toContain("Your &lt;b&gt;name&lt;/b&gt;");
    expect(page.text).toContain('name="website"');
  });

  it("starts a run with the submitted fields", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "form", config: { fields } });
    await request(server).post(`/forms/${wf.trigger.id}`).type("form").send({ name: "Ana", email: "ana@example.com", website: "" }).expect(200);
    const rows = await db.select().from(runs);
    expect(rows.map((r) => r.triggerPayload)).toContainEqual({ name: "Ana", email: "ana@example.com" });
  });

  it("validates fields and drops honeypot submissions without saying so", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "form", config: { fields } });
    await request(server).post(`/forms/${wf.trigger.id}`).type("form").send({ name: "Ana", email: "not-an-email" }).expect(400);
    const before = (await db.select().from(runs)).length;
    await request(server).post(`/forms/${wf.trigger.id}`).type("form").send({ name: "Bot", email: "bot@example.com", website: "http://spam" }).expect(200);
    expect((await db.select().from(runs)).length).toBe(before);
  });
});

describe("rate limits", () => {
  it("throttles repeated login attempts", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await request(server).post("/auth/login").send({ email: "nobody@test.local", password: "wrong password" })).status);
    }
    expect(statuses).toContain(429);
  });
});
