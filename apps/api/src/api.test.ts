import { createHmac, randomBytes } from "node:crypto";
import { apiTokens, joinWorkspace, requests, runs, secrets, SCHEDULE_QUEUE, sessions, stepRuns, users, type Db } from "@daloy/db";
import { TEMPLATES } from "@daloy/engine";
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
    { id: "a", type: "delay", config: { seconds: 1 } },
    { id: "b", type: "delay", config: { seconds: 1 } },
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

  it("reports the newest real run of each workflow as `last`, for the Automations home", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "manual" });
    const rowOf = async () => (await agent.get("/workflows").expect(200)).body.find((w: { id: string }) => w.id === wf.id);
    const lastOf = async () => (await rowOf()).last;
    expect(await lastOf()).toBeNull();
    expect(await rowOf()).toMatchObject({ live: true, formId: null });
    const form = await publishedWorkflow(agent, { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } });
    const formRow = (await agent.get("/workflows").expect(200)).body.find((w: { id: string }) => w.id === form.id);
    expect(formRow).toMatchObject({ live: true, formId: form.trigger.id });
    const first = await agent.post(`/workflows/${wf.id}/runs`).send({ payload: { n: 1 } }).expect(202);
    const second = await agent.post(`/workflows/${wf.id}/runs`).send({ payload: { n: 2 } }).expect(202);
    await db.update(runs).set({ state: "failed", createdAt: new Date(Date.now() + 5000) }).where(eq(runs.id, second.body.id));
    expect(await lastOf()).toMatchObject({ runId: second.body.id, state: "failed", needsReview: false, deliveryFailed: false, superseded: false, reference: null });
    // A preview run never counts as the automation's last result.
    await db.update(runs).set({ test: true }).where(eq(runs.id, second.body.id));
    expect((await lastOf()).runId).toBe(first.body.id);
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

  it("returns one version with its definition, and rolls back by publishing it again", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "manual" });
    const v2def = { ...twoSteps({ type: "manual" }), steps: [twoSteps({}).steps[0], { id: "b", type: "delay", config: { seconds: 9 } }] };
    await agent.post(`/workflows/${wf.id}/versions`).send({ definition: v2def, publish: true }).expect(201);

    const v1 = (await agent.get(`/workflows/${wf.id}/versions/1`).expect(200)).body;
    expect(v1).toMatchObject({ version: 1, published: true });
    expect(v1.definition.steps[1].config.seconds).toBe(1);
    await agent.get(`/workflows/${wf.id}/versions/99`).expect(404);
    await agent.get(`/workflows/${wf.id}/versions/zero`).expect(400);
    await (await signedIn()).agent.get(`/workflows/${wf.id}/versions/1`).expect(404);

    // A rollback is a new published version with the old definition. History is never rewritten.
    const v3 = await agent.post(`/workflows/${wf.id}/versions`).send({ definition: v1.definition, publish: true }).expect(201);
    expect(v3.body).toMatchObject({ version: 3, published: true });
    const opened = (await agent.get(`/workflows/${wf.id}`).expect(200)).body;
    expect(opened.live).toMatchObject({ version: 3 });
    expect(opened.live.definition.steps[1].config.seconds).toBe(1);
  });

  it("filters runs by the test flag and masks secret-looking fields", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "manual" });
    const live = await agent.post(`/workflows/${wf.id}/runs`).send({ payload: { customer: "Ana", password: "pw" } }).expect(202);
    const test = await agent.post(`/workflows/${wf.id}/test-runs`).send({ definition: twoSteps({ type: "manual" }) }).expect(202);
    const ids = async (q: string) => (await agent.get(`/runs?workflowId=${wf.id}${q}`).expect(200)).body.map((r: { id: string }) => r.id);
    expect(await ids("&test=true")).toEqual([test.body.id]);
    expect(await ids("&test=false")).toEqual([live.body.id]);
    expect((await ids("")).sort()).toEqual([live.body.id, test.body.id].sort());
    await agent.get("/runs?test=maybe").expect(400);

    await db.insert(stepRuns).values({ runId: live.body.id, stepId: "zz", attempt: 1, state: "succeeded", input: { url: "https://x.test", headers: { Authorization: "Bearer raw" } }, output: { ok: 1, token: "t" } });
    const run = (await agent.get(`/runs/${live.body.id}`).expect(200)).body;
    expect(run.triggerPayload).toEqual({ customer: "Ana", password: "[secret]" });
    expect(run.steps.find((s: { stepId: string }) => s.stepId === "zz")).toMatchObject({
      input: { url: "https://x.test", headers: { Authorization: "[secret]" } },
      output: { ok: 1, token: "[secret]" },
    });
    const listed = (await agent.get(`/runs?workflowId=${wf.id}&test=false`).expect(200)).body;
    expect(listed[0].triggerPayload.password).toBe("[secret]");
  });

  it("lists runs across automations with their name and request reference, by plain state and by search", async () => {
    const { agent, email } = await signedIn();
    const named = async (name: string) => {
      const wf = await agent.post("/workflows").send({ name, slug: `wf-${++seq}` }).expect(201);
      await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: twoSteps({ type: "manual" }), publish: true }).expect(201);
      return wf.body.id as string;
    };
    const run = async (wf: string, state: "failed" | "waiting" | "succeeded") => {
      const id = (await agent.post(`/workflows/${wf}/runs`).send({ payload: {} }).expect(202)).body.id as string;
      await db.update(runs).set({ state }).where(eq(runs.id, id));
      return id;
    };
    const orders = await named("Orders 100%");
    const leads = await named("Leads");
    const failed = await run(orders, "failed");
    const waiting = await run(leads, "waiting");
    const done = await run(leads, "succeeded");
    const [owner] = await db.select().from(users).where(eq(users.email, email));
    const reference = `REQ-Q${++seq}XYZ`;
    await db.insert(requests).values({ userId: owner!.id, workflowId: leads, runId: done, reference, submissionKey: crypto.randomUUID(), subject: "Printer" });
    // Another workspace's automation with the same name is never listed.
    const other = await signedIn();
    const theirs = await other.agent.post("/workflows").send({ name: "Orders 100%", slug: `wf-${++seq}` }).expect(201);
    await other.agent.post(`/workflows/${theirs.body.id}/versions`).send({ definition: twoSteps({ type: "manual" }), publish: true }).expect(201);
    await other.agent.post(`/workflows/${theirs.body.id}/runs`).send({ payload: {} }).expect(202);

    const ids = async (q: string) => (await agent.get(`/runs?${q}`).expect(200)).body.map((r: { id: string }) => r.id).sort();
    const all = (await agent.get("/runs").expect(200)).body as { id: string; workflowName: string; reference: string | null }[];
    expect(all.find((r) => r.id === done)).toMatchObject({ workflowName: "Leads", reference });
    expect(all.find((r) => r.id === failed)).toMatchObject({ workflowName: "Orders 100%", reference: null });
    expect(await ids("state=problem")).toEqual([failed]);
    expect(await ids("state=waiting")).toEqual([waiting]);
    expect(await ids("state=done")).toEqual([done]);
    expect(await ids("q=leads")).toEqual([waiting, done].sort());
    expect(await ids("q=req-q")).toEqual([done]);
    // % and _ are matched as text, not as patterns.
    expect(await ids("q=100%25")).toEqual([failed]);
    expect(await ids("q=%25")).toEqual([failed]);
    expect(await ids("q=_")).toEqual([]);
    await agent.get(`/runs?q=${"x".repeat(101)}`).expect(400);
    await agent.get("/runs?state=broken").expect(400);
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

describe("builder", () => {
  it("serves a JSON schema per step type, the branch labels and the templates", async () => {
    const { agent } = await signedIn();
    const res = (await agent.get("/step-schemas").expect(200)).body;
    expect(res.schemas.http.properties.method.enum).toContain("POST");
    expect(res.branches.condition).toEqual(["true", "false", "invalid"]);
    const templates = (await agent.get("/templates").expect(200)).body;
    expect(templates).toHaveLength(27);
    await request(server).get("/step-schemas").expect(401);
  });

  it("tells the web app whether SMS is set up on this server (decision 0100)", async () => {
    const { agent } = await signedIn();
    const saved = { UNISMS_SECRET_KEY: process.env.UNISMS_SECRET_KEY, UNISMS_SENDER_ID: process.env.UNISMS_SENDER_ID };
    try {
      delete process.env.UNISMS_SECRET_KEY;
      delete process.env.UNISMS_SENDER_ID;
      expect((await agent.get("/step-schemas").expect(200)).body.sms).toBe(false);
      process.env.UNISMS_SECRET_KEY = "unisms_synth_catalog_key"; // gitleaks:allow
      expect((await agent.get("/step-schemas").expect(200)).body.sms).toBe(false);
      process.env.UNISMS_SENDER_ID = "kymavo";
      expect((await agent.get("/step-schemas").expect(200)).body.sms).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("test-runs a draft as a mocked test run without publishing it", async () => {
    const { agent } = await signedIn();
    const wf = await agent.post("/workflows").send({ name: "Draft", slug: `wf-${++seq}` }).expect(201);
    const body = { definition: twoSteps({ type: "manual" }), payload: { n: 1 } };
    const first = await agent.post(`/workflows/${wf.body.id}/test-runs`).send(body).expect(202);
    const [row] = await db.select().from(runs).where(eq(runs.id, first.body.id));
    expect(row).toMatchObject({ test: true, live: false, triggerPayload: { n: 1 } });
    expect((await agent.get(`/runs/${first.body.id}`).expect(200)).body).toMatchObject({ test: true, live: false });

    // The same draft again reuses its version; a changed draft adds one. Nothing is published.
    const again = await agent.post(`/workflows/${wf.body.id}/test-runs`).send({ ...body, live: true }).expect(202);
    expect(again.body.versionId).toBe(first.body.versionId);
    const changed = { ...body, definition: { ...body.definition, steps: [body.definition.steps[0], { id: "b", type: "delay", config: { seconds: 2 } }] } };
    const third = await agent.post(`/workflows/${wf.body.id}/test-runs`).send(changed).expect(202);
    expect(third.body.versionId).not.toBe(first.body.versionId);
    const versions = (await agent.get(`/workflows/${wf.body.id}/versions`).expect(200)).body;
    expect(versions.map((v: { published: boolean }) => v.published)).toEqual([false, false]);
    const opened = (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body;
    expect(opened).toMatchObject({ live: null, latest: { id: third.body.versionId, published: false } });
    expect(opened.latest.definition.steps[1].config.seconds).toBe(2);
  });

  it("rejects an invalid draft and another user's workflow", async () => {
    const { agent } = await signedIn();
    const wf = await agent.post("/workflows").send({ name: "Draft", slug: `wf-${++seq}` }).expect(201);
    await agent.post(`/workflows/${wf.body.id}/test-runs`).send({ definition: { trigger: { type: "manual" }, steps: [] } }).expect(400);
    const other = await signedIn();
    await other.agent.post(`/workflows/${wf.body.id}/test-runs`).send({ definition: twoSteps({ type: "manual" }) }).expect(404);
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
    const created = (await agent.post("/tokens").send({ name: "claude", scopes: ["read", "run", "manage"] }).expect(201)).body;
    expect(created.token).toMatch(/^dly_/);
    expect(created).toMatchObject({ scopes: ["read", "run", "manage"], expiresAt: null });
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
    expect(page.text).toContain('name="_website"');
  });

  it("starts a run with the submitted fields", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "form", config: { fields } });
    await request(server).post(`/forms/${wf.trigger.id}`).type("form").send({ name: "Ana", email: "ana@example.com", _website: "" }).expect(200);
    const rows = await db.select().from(runs);
    expect(rows.map((r) => r.triggerPayload)).toContainEqual({ name: "Ana", email: "ana@example.com" });
  });

  it("validates fields and drops honeypot submissions without saying so", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "form", config: { fields } });
    await request(server).post(`/forms/${wf.trigger.id}`).type("form").send({ name: "Ana", email: "not-an-email" }).expect(400);
    const before = (await db.select().from(runs)).length;
    await request(server).post(`/forms/${wf.trigger.id}`).type("form").send({ name: "Bot", email: "bot@example.com", _website: "http://spam" }).expect(200);
    expect((await db.select().from(runs)).length).toBe(before);
  });

  it("keeps a real field named website apart from the honeypot", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "form", config: { fields: [...fields, { name: "website", label: "Your website", type: "text", required: true }] } });
    await request(server).post(`/forms/${wf.trigger.id}`).type("form").send({ name: "Lea", email: "lea@example.com", website: "https://lea.example" }).expect(200);
    expect((await db.select().from(runs)).map((r) => r.triggerPayload)).toContainEqual({ name: "Lea", email: "lea@example.com", website: "https://lea.example" });
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

describe("webhook signature with a timestamp (N11b)", () => {
  const stamp = (t: number, key: string, body: string) => `sha256=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
  const legacy = (key: string, body: string) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
  async function signedHook(config: object = {}) {
    const { agent } = await signedIn();
    await agent.put("/secrets/hook_key").send({ value: "whsec_test" }).expect(204);
    const wf = await publishedWorkflow(agent, { type: "webhook", config: { hmacSecret: "hook_key", ...config } });
    const post = (body: string) => request(server).post(`/hooks/${wf.trigger.webhookPath}`).set("Content-Type", "application/json").send(body);
    return { agent, wf, post };
  }

  it("accepts a fresh timestamped call, refuses a stale or future one and one the signature does not cover", async () => {
    const { post } = await signedHook();
    const body = JSON.stringify({ order: 1 });
    const now = Math.floor(Date.now() / 1000);
    await post(body).set("X-Daloy-Timestamp", String(now)).set("X-Daloy-Signature", stamp(now, "whsec_test", body)).expect(202);
    const stale = await post(body).set("X-Daloy-Timestamp", String(now - 400)).set("X-Daloy-Signature", stamp(now - 400, "whsec_test", body)).expect(401);
    expect(stale.body.message).toBe("The timestamp is outside the 5 minute window. Check the clock of the sender.");
    await post(body).set("X-Daloy-Timestamp", String(now + 400)).set("X-Daloy-Signature", stamp(now + 400, "whsec_test", body)).expect(401);
    // Someone replaying an old signature under a new timestamp.
    await post(body).set("X-Daloy-Timestamp", String(now)).set("X-Daloy-Signature", stamp(now - 5, "whsec_test", body)).expect(401);
    await post(body).set("X-Daloy-Timestamp", "soon").set("X-Daloy-Signature", stamp(now, "whsec_test", body)).expect(401);
  });

  it("starts one run for an exact replay, and a new run for a call with a new timestamp", async () => {
    const { post } = await signedHook();
    const body = JSON.stringify({ order: 2 });
    const now = Math.floor(Date.now() / 1000);
    const call = (t: number) => post(body).set("X-Daloy-Timestamp", String(t)).set("X-Daloy-Signature", stamp(t, "whsec_test", body));
    const first = (await call(now).expect(202)).body;
    const replay = (await call(now).expect(202)).body;
    expect(replay).toEqual({ runId: first.runId, duplicate: true });
    expect((await call(now - 1).expect(202)).body.runId).not.toBe(first.runId);
  });

  it("a signed timestamped call is repeated by its signature, whatever Idempotency-Key it carries", async () => {
    const { post } = await signedHook();
    const body = JSON.stringify({ order: 3 });
    const now = Math.floor(Date.now() / 1000);
    const call = (key: string) => post(body).set("Idempotency-Key", key).set("X-Daloy-Timestamp", String(now)).set("X-Daloy-Signature", stamp(now, "whsec_test", body));
    const first = (await call("order-3a").expect(202)).body;
    expect((await call("order-3b").expect(202)).body).toEqual({ runId: first.runId, duplicate: true });
  });

  it("still accepts the old signature, says so in a header and records it, until the owner requires the timestamp", async () => {
    const { agent, wf, post } = await signedHook();
    const body = JSON.stringify({ order: 4 });
    const res = await post(body).set("X-Daloy-Signature", legacy("whsec_test", body)).expect(202);
    expect(res.headers["daloy-signature-warning"]).toBe("timestamp-missing");
    const seen = (await agent.get(`/workflows/${wf.id}`).expect(200)).body.trigger.legacySignatureAt;
    expect(typeof seen).toBe("string");
    // A timestamped call carries no warning.
    const now = Math.floor(Date.now() / 1000);
    const fresh = await post(body).set("X-Daloy-Timestamp", String(now)).set("X-Daloy-Signature", stamp(now, "whsec_test", body)).expect(202);
    expect(fresh.headers["daloy-signature-warning"]).toBeUndefined();
  });

  it("refuses the old signature once the trigger requires the timestamp, naming the header", async () => {
    const { post } = await signedHook({ requireTimestamp: true });
    const body = JSON.stringify({ order: 5 });
    const res = await post(body).set("X-Daloy-Signature", legacy("whsec_test", body)).expect(401);
    expect(res.body.message).toContain("X-Daloy-Timestamp");
    const now = Math.floor(Date.now() / 1000);
    await post(body).set("X-Daloy-Timestamp", String(now)).set("X-Daloy-Signature", stamp(now, "whsec_test", body)).expect(202);
  });
});

describe("invoice starter webhook (M2)", () => {
  const stamp = (t: number, key: string, body: string) => `sha256=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
  async function invoiceHook() {
    const { agent } = await signedIn();
    await agent.put("/secrets/invoice_webhook_secret").send({ value: "whsec_invoice" }).expect(204);
    const wf = await agent.post("/workflows").send({ name: "Invoice", slug: `inv-${++seq}` }).expect(201);
    const definition = TEMPLATES.find((t) => t.slug === "invoice-paymongo")!.definition;
    await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
    const full = (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body;
    return (body: string) => request(server).post(`/hooks/${full.trigger.webhookPath}`).set("Content-Type", "application/json").send(body);
  }

  it("makes one run when a signed retry has a new timestamp and a new Idempotency-Key, and refuses an unsigned call", async () => {
    const post = await invoiceHook();
    const body = JSON.stringify({ invoice_id: "INV-1", customer_name: "Ana", customer_email: "ana@example.com", amount: 500 });
    const t = Math.floor(Date.now() / 1000);
    const call = (time: number, key: string) => post(body).set("Idempotency-Key", key).set("X-Daloy-Timestamp", String(time)).set("X-Daloy-Signature", stamp(time, "whsec_invoice", body));
    const first = (await call(t, "k1").expect(202)).body;
    expect((await call(t + 1, "k2").expect(202)).body).toEqual({ runId: first.runId, duplicate: true });
    await post(body).expect(401);
  });
});

describe("workflow webhook URL visibility (M2)", () => {
  it("shows the bearer URL to the owner but not to an operator", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "webhook", config: {} });
    expect(wf.trigger.webhookPath).toEqual(expect.any(String));
    const workspaceId = (await agent.get("/auth/me").expect(200)).body.workspaceId as string;
    const [u] = await db.insert(users).values({ email: `op${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
    await joinWorkspace(db, u!.id, workspaceId, "operator");
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    const operator = request.agent(server).set("Cookie", `daloy_session=${token}`);
    const seen = (await operator.get(`/workflows/${wf.id}`).expect(200)).body;
    expect(seen.trigger.webhookPath).toBeNull();
    expect(seen.trigger.type).toBe("webhook");
  });

  it("lets the owner replace the URL: the old one stops, the new one works, an operator is refused", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "webhook", config: {} });
    const workspaceId = (await agent.get("/auth/me").expect(200)).body.workspaceId as string;
    const [u] = await db.insert(users).values({ email: `op${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
    await joinWorkspace(db, u!.id, workspaceId, "operator");
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    await request.agent(server).set("Cookie", `daloy_session=${token}`).post(`/workflows/${wf.id}/webhook-url`).expect(403);
    const { webhookPath } = (await agent.post(`/workflows/${wf.id}/webhook-url`).expect(201)).body;
    expect(webhookPath).not.toBe(wf.trigger.webhookPath);
    await request(server).post(`/hooks/${wf.trigger.webhookPath}`).send({}).expect(404);
    await request(server).post(`/hooks/${webhookPath}`).send({}).expect(202);
  });
});

describe("runs list limit and deliveryFailed flag", () => {
  it("caps returned rows with limit and exposes deliveryFailed", async () => {
    const { agent } = await signedIn();
    const wf = await publishedWorkflow(agent, { type: "webhook", config: {} });
    await request(server).post(`/hooks/${wf.trigger.webhookPath}`).send({ n: 1 }).expect(202);
    await request(server).post(`/hooks/${wf.trigger.webhookPath}`).send({ n: 2 }).expect(202);

    const limited = await agent.get("/runs?test=false&limit=1").expect(200);
    expect(limited.body).toHaveLength(1);
    expect(limited.body[0]).toMatchObject({ workflowId: wf.id, deliveryFailed: false });

    await agent.get("/runs?limit=0").expect(400);
  });
});
