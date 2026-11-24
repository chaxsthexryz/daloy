import { randomBytes } from "node:crypto";
import { joinWorkspace, runs, sessions, users, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
type Agent = ReturnType<typeof request.agent>;

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

const PASSWORD = "correct horse battery";
let seq = 0;

async function owner() {
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email: `res${++seq}@test.local`, password: PASSWORD }).expect(201);
  return agent;
}

async function member(ownerAgent: Agent, role: "operator" | "approver" | "requester") {
  const workspaceId = (await ownerAgent.get("/auth/me").expect(200)).body.workspaceId as string;
  const [u] = await db.insert(users).values({ email: `res${++seq}@test.local`, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}

const add = async (agent: Agent, name: string) => (await agent.post("/resources").send({ name }).expect(201)).body as { id: string; name: string; active: boolean };

const year = new Date().getUTCFullYear() + 1;
const fields = [
  { name: "therapist", label: "Therapist", type: "resource", required: true },
  { name: "at", label: "Appointment", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
];
const definition = (trigger: object) => ({ trigger, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] });

async function published(agent: Agent, trigger: object) {
  const wf = await agent.post("/workflows").send({ name: "Spa", slug: `spa-${++seq}` }).expect(201);
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: definition(trigger), publish: true }).expect(201);
  return (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body as { id: string; trigger: { id: string; webhookPath: string } };
}
const payloadOf = async (runId: string) => (await db.select().from(runs).where(eq(runs.id, runId)))[0]!.triggerPayload;

describe("resources API", () => {
  it("lets the owner add, rename, archive and restore resources, listed by name", async () => {
    const agent = await owner();
    const ben = await add(agent, "Ben");
    const ana = await add(agent, "Ana");
    expect(ana).toMatchObject({ name: "Ana", active: true });
    await agent.patch(`/resources/${ben.id}`).send({ name: "Benjamin" }).expect(200);
    await agent.patch(`/resources/${ana.id}`).send({ active: false }).expect(200);
    const list = (await agent.get("/resources").expect(200)).body as { name: string; active: boolean }[];
    expect(list.map((r) => [r.name, r.active])).toEqual([
      ["Ana", false],
      ["Benjamin", true],
    ]);
    await agent.patch(`/resources/${ana.id}`).send({ active: true }).expect(200);
  });

  it("refuses blank, long and duplicate names with a reason", async () => {
    const agent = await owner();
    await add(agent, "Ana");
    expect((await agent.post("/resources").send({ name: "Ana" }).expect(409)).body.message).toBe("a resource named Ana already exists");
    await agent.post("/resources").send({ name: "  " }).expect(400);
    await agent.post("/resources").send({ name: "x".repeat(101) }).expect(400);
    await agent.post("/resources").send({}).expect(400);
    const ben = await add(agent, "Ben");
    await agent.patch(`/resources/${ben.id}`).send({ name: "Ana" }).expect(409);
    await agent.patch(`/resources/${ben.id}`).send({}).expect(400);
  });

  it("lets every member list resources but only the owner change them", async () => {
    const agent = await owner();
    const ana = await add(agent, "Ana");
    for (const role of ["operator", "approver", "requester"] as const) {
      const m = await member(agent, role);
      expect((await m.get("/resources").expect(200)).body).toHaveLength(1);
      await m.post("/resources").send({ name: `By ${role}` }).expect(403);
      await m.patch(`/resources/${ana.id}`).send({ name: "Changed" }).expect(403);
    }
  });

  it("keeps each workspace's resources to itself", async () => {
    const a = await owner();
    const b = await owner();
    const ana = await add(a, "Ana");
    expect((await b.get("/resources").expect(200)).body).toEqual([]);
    await b.patch(`/resources/${ana.id}`).send({ name: "Mine" }).expect(404);
    await add(b, "Ana");
    await request(server).get("/resources").expect(401);
  });

  it("supports optional resource labels (room types) on create and update, and lets them be cleared", async () => {
    const agent = await owner();
    const room = (await agent.post("/resources").send({ name: "Villa 1", label: "Beach Villa" }).expect(201)).body as { id: string; name: string; label: string | null };
    expect(room).toMatchObject({ name: "Villa 1", label: "Beach Villa" });
    await agent.patch(`/resources/${room.id}`).send({ label: "Ocean Villa" }).expect(200).then((r) => expect(r.body.label).toBe("Ocean Villa"));
    await agent.patch(`/resources/${room.id}`).send({ label: null }).expect(200).then((r) => expect(r.body.label).toBeNull());
    await agent.post("/resources").send({ name: "Villa 2", label: "x".repeat(81) }).expect(400);
  });
});

describe("resource and datetime fields at every entry point", () => {
  it("test runs and the Run button store the resource with its name and the zoned time", async () => {
    const agent = await owner();
    const ana = await add(agent, "Ana");
    const wf = await published(agent, { type: "manual" });
    const trigger = { type: "webhook", config: { fields } };
    const payload = { therapist: ana.id, at: `${year}-01-20T14:00` };
    const test = await agent.post(`/workflows/${wf.id}/test-runs`).send({ definition: definition(trigger), payload }).expect(202);
    expect(await payloadOf(test.body.id)).toEqual({ therapist: { id: ana.id, name: "Ana" }, at: `${year}-01-20T14:00:00+08:00` });

    const hooked = await published(agent, trigger);
    const run = await agent.post(`/workflows/${hooked.id}/runs`).send({ payload }).expect(202);
    expect(await payloadOf(run.body.id)).toEqual({ therapist: { id: ana.id, name: "Ana" }, at: `${year}-01-20T14:00:00+08:00` });
  });

  it("refuses another workspace's resource, an archived one, a past time and a DST gap, naming the field", async () => {
    const agent = await owner();
    const other = await owner();
    const ana = await add(agent, "Ana");
    const old = await add(agent, "Old");
    await agent.patch(`/resources/${old.id}`).send({ active: false }).expect(200);
    const foreign = await add(other, "Zed");
    const wf = await published(agent, { type: "webhook", config: { fields } });
    const errors = async (payload: object) => (await agent.post(`/workflows/${wf.id}/runs`).send({ payload }).expect(400)).body.message as string[];
    const at = `${year}-01-20T14:00`;
    expect(await errors({ therapist: foreign.id, at })).toEqual(["therapist: must be one of this workspace's resources"]);
    expect(await errors({ therapist: old.id, at })).toEqual(["therapist: must be one of this workspace's resources"]);
    expect(await errors({ therapist: ana.id, at: "2020-01-20T14:00" })).toEqual(["at: must be in the future"]);
    expect(await errors({ therapist: ana.id, at: `${year}-01-20T14:30` })).toEqual(["at: must start on a 60-minute slot, counted from midnight in Asia/Manila"]);

    const ny = await published(agent, { type: "webhook", config: { fields: [{ name: "at", label: "At", type: "datetime", required: true, timezone: "America/New_York" }] } });
    expect((await agent.post(`/workflows/${ny.id}/runs`).send({ payload: { at: "2030-03-10T02:30" } }).expect(400)).body.message).toEqual(["at: does not exist in America/New_York (the clocks skip it)"]);
  });

  it("checks webhook payloads the same way", async () => {
    const agent = await owner();
    const ana = await add(agent, "Ana");
    const wf = await published(agent, { type: "webhook", config: { fields } });
    const hook = (body: object) => request(server).post(`/hooks/${wf.trigger.webhookPath}`).send(body);
    await hook({ therapist: "not-an-id", at: `${year}-01-20T14:00` }).expect(400);
    const res = await hook({ therapist: ana.id, at: `${year}-01-20T06:00:00Z` }).expect(202);
    expect(await payloadOf(res.body.runId ?? res.body.id)).toEqual({ therapist: { id: ana.id, name: "Ana" }, at: `${year}-01-20T14:00:00+08:00` });
  });

  it("the public form lists active resources and names the timezone, and checks the submission on the server", async () => {
    const agent = await owner();
    const other = await owner();
    const ana = await add(agent, "Ana <3");
    const old = await add(agent, "Old");
    await agent.patch(`/resources/${old.id}`).send({ active: false }).expect(200);
    const foreign = await add(other, "Zed");
    const wf = await published(agent, { type: "form", config: { fields } });

    const page = (await request(server).get(`/forms/${wf.trigger.id}`).expect(200)).text;
    expect(page).toContain(`<option value="${ana.id}">Ana &lt;3</option>`);
    expect(page).not.toContain(old.id);
    expect(page).toContain('type="datetime-local"');
    expect(page).toContain('step="3600"');
    expect(page).toContain("Times are in Asia/Manila");

    const submit = (body: object) => request(server).post(`/forms/${wf.trigger.id}`).type("form").send({ ...body, _website: "" });
    await submit({ therapist: foreign.id, at: `${year}-01-20T14:00` }).expect(400);
    await submit({ therapist: ana.id, at: `${year}-01-20T32:00` }).expect(400);
    await submit({ therapist: ana.id, at: `${year}-01-20T14:00` }).expect(200);
    const rows = await db.select().from(runs);
    expect(rows.map((r) => r.triggerPayload)).toContainEqual({ therapist: { id: ana.id, name: "Ana <3" }, at: `${year}-01-20T14:00:00+08:00` });
  });

  it("answers a replayed event with its first run even when the payload would now be refused", async () => {
    const agent = await owner();
    const ana = await add(agent, "Ana");
    // On the hour one to two hours ahead; the clock then moves three hours on, so that time has passed.
    const soon = new Date(Math.ceil((Date.now() + 3_600_000) / 3_600_000) * 3_600_000).toISOString();
    const byHeader = await published(agent, { type: "webhook", config: { fields } });
    const byTemplate = await published(agent, { type: "webhook", config: { fields, eventKey: "{{trigger.event_id}}" } });
    const hook = (wf: { trigger: { webhookPath: string } }, body: object, key?: string) => {
      const req = request(server).post(`/hooks/${wf.trigger.webhookPath}`);
      return (key ? req.set("Idempotency-Key", key) : req).send(body);
    };
    const event = (id: string, at: string) => ({ event_id: id, therapist: ana.id, at });

    const first = await hook(byHeader, { therapist: ana.id, at: `${year}-01-20T14:00` }, "evt-1").expect(202);
    const second = await hook(byTemplate, event("evt-2", soon)).expect(202);
    // The Run button replays a webhook trigger's eventKey the same way.
    const viaButton = await agent.post(`/workflows/${byTemplate.id}/runs`).send({ payload: event("evt-3", soon) }).expect(202);
    await agent.patch(`/resources/${ana.id}`).send({ active: false }).expect(200);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3 * 3_600_000 });
    try {
      expect((await hook(byHeader, { therapist: ana.id, at: `${year}-01-20T14:00` }, "evt-1").expect(202)).body).toEqual({ runId: first.body.runId, duplicate: true });
      expect((await hook(byTemplate, event("evt-2", soon)).expect(202)).body).toEqual({ runId: second.body.runId, duplicate: true });
      expect((await agent.post(`/workflows/${byTemplate.id}/runs`).send({ payload: event("evt-3", soon) }).expect(202)).body).toEqual({ id: viaButton.body.id, duplicate: true });

      // A new key still gets the checks: the resource is archived and the time has passed.
      expect((await hook(byHeader, { therapist: ana.id, at: `${year}-01-20T14:00` }, "evt-4").expect(400)).body.message).toEqual(["therapist: must be one of this workspace's resources"]);
      expect((await hook(byTemplate, event("evt-5", soon)).expect(400)).body.message).toContain("at: must be in the future");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the form's time input a browser step only when the slot divides the day, so every server slot can be sent", async () => {
    const agent = await owner();
    const slots = [7, 45, 60, 90, 1440];
    const wf = await published(agent, { type: "form", config: { fields: slots.map((slotMinutes) => ({ name: `at_${slotMinutes}`, label: `At ${slotMinutes}`, type: "datetime", timezone: "Asia/Manila", slotMinutes })) } });
    const page = (await request(server).get(`/forms/${wf.trigger.id}`).expect(200)).text;
    const steps = Object.fromEntries([...page.matchAll(/id="(at_[0-9]+)"[^>]* step="([0-9]+)"/g)].map((m) => [m[1], m[2]]));
    expect(slots.map((s) => steps[`at_${s}`])).toEqual(["60", "2700", "3600", "5400", "86400"]);
  });

  it("keeps the name a run started with after the resource is renamed or archived", async () => {
    const agent = await owner();
    const ana = await add(agent, "Ana");
    const wf = await published(agent, { type: "webhook", config: { fields } });
    const run = await agent.post(`/workflows/${wf.id}/runs`).send({ payload: { therapist: ana.id, at: `${year}-01-20T14:00` } }).expect(202);
    await agent.patch(`/resources/${ana.id}`).send({ name: "Ana Reyes" }).expect(200);
    await agent.patch(`/resources/${ana.id}`).send({ active: false }).expect(200);
    expect(await payloadOf(run.body.id)).toMatchObject({ therapist: { id: ana.id, name: "Ana" } });
  });
});
