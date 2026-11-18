import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { requests, runs, triggers, uploads, usageCounts, workflows, workflowVersions, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { spyDb } from "../../../test/spy-db";
import { createApp } from "./app";

// N11c-2 (decision 0057): public intake fixes H3, M1, M14 and M15 of the 19 November security review.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let spy: ReturnType<typeof spyDb>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  spy = spyDb(db);
  // trustProxy lets each submission use its own X-Forwarded-For, so the 10 a minute form limit does not mix the tests up.
  app = await createApp({ db: spy.db, boss, secretsKey: randomBytes(32), secureCookies: false, trustProxy: 1, publicUrl: "https://daloy.test" });
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
let ip = 0;
const nextIp = () => `10.${(ip >> 16) & 255}.${(ip >> 8) & 255}.${++ip & 255}`;

async function owner() {
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email: `intake${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  const workspaceId = (await agent.get("/auth/me").expect(200)).body.workspaceId as string;
  return { agent, workspaceId };
}

const delay = [{ id: "a", type: "delay", config: { seconds: 1 } }];
const define = (trigger: object) => ({ trigger, steps: delay, edges: [] });
const FIELDS = [{ name: "name", label: "Name", type: "text", required: false }];
const publish = (agent: Agent, id: string, trigger: object) => agent.post(`/workflows/${id}/versions`).send({ definition: define(trigger), publish: true });
async function workflow(agent: Agent, trigger: object) {
  const wf = await agent.post("/workflows").send({ name: "Intake", slug: `intake-${++seq}` }).expect(201);
  const v1 = (await publish(agent, wf.body.id, trigger).expect(201)).body.id as string;
  const full = (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body;
  return { id: wf.body.id as string, v1, trigger: full.trigger as { id: string; webhookPath: string } };
}
const runsOf = async (workflowId: string) => {
  const vs = await db.select({ id: workflowVersions.id }).from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId));
  return db.select().from(runs).where(inArray(runs.workflowVersionId, vs.map((v) => v.id)));
};

const versionCount = async (workflowId: string) => (await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId))).length;

describe("H3: a submission that crosses a republish", () => {
  it("a public form runs the version it was read with, not a newer protected one", async () => {
    const o = await owner();
    const f = await workflow(o.agent, { type: "form", config: { fields: FIELDS } });
    // Between the trigger read and the version read, the owner turns the public form into a manual trigger.
    spy.afterFirstRead("triggers", async () => void (await publish(o.agent, f.id, { type: "manual" }).expect(201)));
    const res = await request(server).post(`/forms/${f.trigger.id}`).set("X-Forwarded-For", nextIp()).type("form").send({ name: "Ana" });
    const started = await runsOf(f.id);
    expect(await versionCount(f.id)).toBe(2);
    // Either the old version ran or the call was refused; never the new manual version.
    expect(started.every((r) => r.workflowVersionId === f.v1)).toBe(true);
    expect([200, 404]).toContain(res.status);
  });

  it("a webhook runs the version whose signing secret checked the call", async () => {
    const o = await owner();
    await o.agent.put("/secrets/hook_a").send({ value: "key-a" }).expect(204);
    await o.agent.put("/secrets/hook_b").send({ value: "key-b" }).expect(204);
    const w = await workflow(o.agent, { type: "webhook", config: { hmacSecret: "hook_a" } });
    spy.afterFirstRead("triggers", async () => void (await publish(o.agent, w.id, { type: "webhook", config: { hmacSecret: "hook_b" } }).expect(201)));
    const body = JSON.stringify({ n: 1 });
    const signature = `sha256=${createHmac("sha256", "key-a").update(body).digest("hex")}`;
    const res = await request(server).post(`/hooks/${w.trigger.webhookPath}`).set("Content-Type", "application/json").set("X-Daloy-Signature", signature).send(body);
    expect(await versionCount(w.id)).toBe(2);
    expect((await runsOf(w.id)).every((r) => r.workflowVersionId === w.v1)).toBe(true);
    expect([202, 401, 404]).toContain(res.status);
  });
});

describe("M1: a webhook signing secret that is blank or missing", () => {
  const body = JSON.stringify({ n: 1 });
  const post = (path: string) => request(server).post(`/hooks/${path}`).set("Content-Type", "application/json");
  const signed = (key: string) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

  it("fails closed for an old stored definition with a blank secret name", async () => {
    const o = await owner();
    const [wf] = await db.insert(workflows).values({ userId: o.workspaceId, name: "Old", slug: `old-${++seq}` }).returning();
    await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, published: true, definition: define({ type: "webhook", config: { hmacSecret: "" } }) });
    const webhookPath = randomBytes(32).toString("base64url");
    await db.insert(triggers).values({ workflowId: wf!.id, type: "webhook", config: { hmacSecret: "" }, webhookPath });
    await post(webhookPath).send(body).expect(401);
    expect(await runsOf(wf!.id)).toHaveLength(0);
  });

  it("refuses to publish a signed webhook whose secret does not exist", async () => {
    const o = await owner();
    const wf = await o.agent.post("/workflows").send({ name: "Hook", slug: `hook-${++seq}` }).expect(201);
    const res = await publish(o.agent, wf.body.id, { type: "webhook", config: { hmacSecret: "not_made_yet" } }).expect(400);
    expect(res.body.message).toContain("not_made_yet");
    await publish(o.agent, wf.body.id, { type: "webhook", config: { hmacSecret: "" } }).expect(400);
    // A draft may name a secret that is added later.
    await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: define({ type: "webhook", config: { hmacSecret: "later" } }), publish: false }).expect(201);
  });

  it("answers 401 when the secret is removed after publishing, and accepts a correct signature while it exists", async () => {
    const o = await owner();
    await o.agent.put("/secrets/hook_live").send({ value: "key-live" }).expect(204);
    const w = await workflow(o.agent, { type: "webhook", config: { hmacSecret: "hook_live" } });
    await post(w.trigger.webhookPath).set("X-Daloy-Signature", signed("key-live")).send(body).expect(202);
    await post(w.trigger.webhookPath).send(body).expect(401);
    await o.agent.delete("/secrets/hook_live").expect(204);
    await post(w.trigger.webhookPath).set("X-Daloy-Signature", signed("key-live")).send(body).expect(401);
  });
});

describe("M14: who a tracked request is recorded for", () => {
  async function tracked() {
    const o = await owner();
    const f = await workflow(o.agent, { type: "form", config: { fields: FIELDS } });
    await db.update(workflows).set({ setup: { template: "office-request" } }).where(eq(workflows.id, f.id));
    return { o, f };
  }
  /** Posts as the signed-in owner (the session cookie is sent) and returns the recorded requester. */
  async function post(path: (id: string) => string, origin: string | undefined) {
    const { o, f } = await tracked();
    const key = randomUUID();
    let req = o.agent.post(path(f.trigger.id)).set("X-Forwarded-For", nextIp());
    if (origin) req = req.set("Origin", origin);
    await req.type("form").send({ name: "Ana", submission_key: key }).expect(200);
    const [row] = await db.select().from(requests).where(eq(requests.workflowId, f.id));
    return { requestedBy: row!.requestedBy, ownerId: o.workspaceId };
  }

  it("records the signed-in member when the Origin is the installation's own", async () => {
    const r = await post((id) => `/forms/${id}`, "https://daloy.test");
    expect(r.requestedBy).toBe(r.ownerId);
  });

  it("records nobody for a sibling origin, another port, or a missing Origin", async () => {
    for (const origin of ["https://evil.daloy.test", "https://daloy.test:8443", "http://daloy.test", undefined]) {
      expect((await post((id) => `/forms/${id}`, origin)).requestedBy, String(origin)).toBeNull();
    }
  });

  it("records nobody for an embedded form, whatever the Origin", async () => {
    expect((await post((id) => `/forms/${id}/embed`, "https://daloy.test")).requestedBy).toBeNull();
  });
});

describe("M15: a repeated tracked submission with a file", () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg body")]);
  async function trackedWithFile() {
    const o = await owner();
    const f = await workflow(o.agent, { type: "form", config: { fields: [...FIELDS, { name: "photo", label: "Photo", type: "file", required: false }] } });
    await db.update(workflows).set({ setup: { template: "office-request" } }).where(eq(workflows.id, f.id));
    const key = randomUUID();
    const send = () => request(server).post(`/forms/${f.trigger.id}`).set("X-Forwarded-For", nextIp()).field("submission_key", key).field("name", "Ana").attach("photo", JPEG, "front.jpg");
    return { o, f, send };
  }
  const reference = (html: string) => /REQ-[0-9A-Z]{6}/.exec(html)?.[0];
  const unitsUsed = async (userId: string) => (await db.select().from(usageCounts).where(eq(usageCounts.userId, userId))).filter((r) => r.kind === "upload").reduce((n, r) => n + r.used, 0);

  it("returns the same reference, stores one file and uses one unit", async () => {
    const { o, send } = await trackedWithFile();
    const first = reference((await send().expect(200)).text);
    const again = reference((await send().expect(200)).text);
    expect(first).toBeDefined();
    expect(again).toBe(first);
    expect(await db.select().from(uploads).where(eq(uploads.userId, o.workspaceId))).toHaveLength(1);
    expect(await unitsUsed(o.workspaceId)).toBe(1);
  });

  it("does the same when two duplicates arrive together", async () => {
    const { o, send } = await trackedWithFile();
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(reference(a.text)).toBe(reference(b.text));
    expect(await db.select().from(uploads).where(eq(uploads.userId, o.workspaceId))).toHaveLength(1);
    expect(await unitsUsed(o.workspaceId)).toBe(1);
  });
});
