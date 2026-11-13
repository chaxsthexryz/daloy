import { randomBytes, randomUUID } from "node:crypto";
import { requests, runs, type Db } from "@daloy/db";
import { defaultAnswers, officeRequestDefinition } from "@daloy/engine";
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
  await agent.post("/auth/register").send({ email: `office${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return agent;
}

const answers = defaultAnswers("office@test.local");
const setup = { step: "review", answers };

/** A guided office request workflow, turned on. Returns the workflow id and its form trigger id. */
async function liveOfficeRequests(agent: ReturnType<typeof request.agent>) {
  const wf = await agent.post("/workflows").send({ name: "Office requests", slug: `office-${++seq}` }).expect(201);
  await agent.patch(`/workflows/${wf.body.id}/setup`).send(setup).expect(200);
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: officeRequestDefinition(answers), publish: true }).expect(201);
  const full = await agent.get(`/workflows/${wf.body.id}`).expect(200);
  return { id: wf.body.id as string, formId: full.body.trigger.id as string };
}

const submission = { name: "Rosa Diaz", email: "rosa@example.com", summary: "The printer on floor 2 is jammed.", location: "Floor 2" };
const submit = (formId: string, key: string) => request(server).post(`/forms/${formId}`).type("form").send({ ...submission, submission_key: key });
const referenceIn = (html: string) => /REQ-[0-9A-Z]{6}/.exec(html)?.[0];

describe("guided setup progress", () => {
  it("saves the step and answers, and returns them with the workflow", async () => {
    const agent = await signedIn();
    const wf = await agent.post("/workflows").send({ name: "Office requests", slug: "office-requests" }).expect(201);
    await agent.patch(`/workflows/${wf.body.id}/setup`).send({ step: "fields", answers }).expect(200);
    expect((await agent.get(`/workflows/${wf.body.id}`).expect(200)).body.setup).toEqual({ template: "office-request", step: "fields", answers });
    const [listed] = (await agent.get("/workflows").expect(200)).body;
    expect(listed).toMatchObject({ setup: { step: "fields" }, live: false });
  });

  it("rejects bad answers and another owner's workflow", async () => {
    const agent = await signedIn();
    const wf = await agent.post("/workflows").send({ name: "Office requests", slug: "office-requests" }).expect(201);
    await agent.patch(`/workflows/${wf.body.id}/setup`).send({ step: "fields", answers: { ...answers, notifyEmail: "nope" } }).expect(400);
    await agent.patch(`/workflows/${wf.body.id}/setup`).send({ step: "launch", answers }).expect(400);
    await (await signedIn()).patch(`/workflows/${wf.body.id}/setup`).send(setup).expect(404);
  });
});

describe("office request submissions", () => {
  it("puts a submission key in the form and records one request per key", async () => {
    const agent = await signedIn();
    const { id, formId } = await liveOfficeRequests(agent);
    const page = await request(server).get(`/forms/${formId}`).expect(200);
    const key = /name="submission_key" value="([0-9a-f-]{36})"/.exec(page.text)?.[1];
    expect(key).toBeDefined();
    // Each page load is a new form attempt with its own key.
    expect((await request(server).get(`/forms/${formId}`)).text).not.toContain(key);

    const first = referenceIn((await submit(formId, key!).expect(200)).text);
    const again = referenceIn((await submit(formId, key!).expect(200)).text);
    expect(first).toBeDefined();
    expect(again).toBe(first);

    const rows = await db.select().from(requests).where(eq(requests.workflowId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reference: first, subject: submission.summary });
    const [run] = await db.select().from(runs).where(eq(runs.id, rows[0]!.runId));
    expect(run!.triggerPayload).toEqual({ ...submission, reference: first });
    expect(run!.test).toBe(false);
  });

  it("records one request when two posts with the same key arrive together", async () => {
    const { id, formId } = await liveOfficeRequests(await signedIn());
    const key = randomUUID();
    const [a, b] = await Promise.all([submit(formId, key), submit(formId, key)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(referenceIn(a.text)).toBe(referenceIn(b.text));
    expect(await db.select().from(requests).where(eq(requests.workflowId, id))).toHaveLength(1);
  });

  it("gives two intentional requests with the same wording separate references", async () => {
    const { id, formId } = await liveOfficeRequests(await signedIn());
    const a = referenceIn((await submit(formId, randomUUID()).expect(200)).text);
    const b = referenceIn((await submit(formId, randomUUID()).expect(200)).text);
    expect(a).not.toBe(b);
    expect(await db.select().from(requests).where(eq(requests.workflowId, id))).toHaveLength(2);
  });

  it("rejects a missing or malformed submission key", async () => {
    const { formId } = await liveOfficeRequests(await signedIn());
    await request(server).post(`/forms/${formId}`).type("form").send(submission).expect(400);
    await submit(formId, "not-a-uuid").expect(400);
  });

  it("lists requests with their run state only to the owner", async () => {
    const agent = await signedIn();
    const { id, formId } = await liveOfficeRequests(agent);
    const ref = referenceIn((await submit(formId, randomUUID()).expect(200)).text);
    const list = (await agent.get(`/workflows/${id}/requests`).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ reference: ref, subject: submission.summary, runState: "pending", runId: expect.any(String) })]);
    await (await signedIn()).get(`/workflows/${id}/requests`).expect(404);
  });
});
