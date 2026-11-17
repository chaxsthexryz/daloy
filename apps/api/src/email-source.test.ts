import { randomBytes } from "node:crypto";
import { emailSources, workspaceMembers, type Db } from "@daloy/db";
import { eq } from "drizzle-orm";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let sequence = 0;
const mailbox = { host: "imap.example.com", username: "inquiries@example.com", password: "synthetic-app-password", folder: "INBOX" };
const definition = { trigger: { type: "email", config: {} }, steps: [{ id: "wait", type: "delay", config: { seconds: 1 } }], edges: [] };

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
async function owner() {
  const agent = request.agent(server);
  const result = await agent
    .post("/auth/register")
    .send({ email: `mailbox${++sequence}@test.local`, password: "correct horse battery" })
    .expect(201);
  const workflow = await agent
    .post("/workflows")
    .send({ name: "Mail inquiries", slug: `mail-${sequence}` })
    .expect(201);
  return { agent, id: result.body.id as string, workflowId: workflow.body.id as string };
}

it("stores mailbox credentials write-only, queues a check and disconnects", async () => {
  const o = await owner();
  const path = `/workflows/${o.workflowId}/email-source`;
  expect((await o.agent.get(path).expect(200)).body.source).toBeNull();
  const connected = await o.agent.put(path).send(mailbox).expect(200);
  expect(connected.body.source).toMatchObject({ host: mailbox.host, username: mailbox.username, status: "pending" });
  expect(Object.keys(connected.body.source).sort()).toEqual([
    "folder",
    "host",
    "lastCheckedAt",
    "lastError",
    "listening",
    "status",
    "username",
  ]);
  expect(JSON.stringify(connected.body)).not.toContain(mailbox.password);
  const checked = await o.agent.post(`${path}/check`).expect(200);
  expect(checked.body.source.status).toBe("pending");
  expect(JSON.stringify((await o.agent.get(path).expect(200)).body)).not.toContain(mailbox.password);
  await o.agent.delete(path).expect(204);
  expect((await o.agent.get(path).expect(200)).body.source.status).toBe("disconnected");
});

it("requires the workspace owner and hides another workspace's mailbox", async () => {
  const o = await owner();
  const stranger = await owner();
  const path = `/workflows/${o.workflowId}/email-source`;
  await request(server).get(path).expect(401);
  for (const method of ["get", "put", "delete", "post"] as const) {
    await stranger.agent[method](method === "post" ? `${path}/check` : path)
      .send(method === "put" ? mailbox : {})
      .expect(404);
  }
  for (const role of ["operator", "approver", "requester"] as const) {
    await db.update(workspaceMembers).set({ workspaceId: o.id, role }).where(eq(workspaceMembers.userId, stranger.id));
    for (const method of ["get", "put", "delete", "post"] as const) {
      await stranger.agent[method](method === "post" ? `${path}/check` : path)
        .send(method === "put" ? mailbox : {})
        .expect(403);
    }
  }
});

it("rejects invalid mailbox configuration and unknown workflow ids", async () => {
  const o = await owner();
  await o.agent
    .put(`/workflows/${o.workflowId}/email-source`)
    .send({ ...mailbox, host: "https://imap.example.com", password: "" })
    .expect(400);
  await o.agent.get("/workflows/invalid/email-source").expect(400);
  await o.agent.post(`/workflows/${o.workflowId}/email-source/check`).expect(404);
});

it("allows an email draft but preserves the live workflow when its source is missing or pending", async () => {
  const o = await owner();
  const versions = `/workflows/${o.workflowId}/versions`;
  await o.agent
    .post(versions)
    .send({ definition: { ...definition, trigger: { type: "manual", config: {} } }, publish: true })
    .expect(201);
  await o.agent.post(versions).send({ definition, publish: false }).expect(201);
  await o.agent.post(versions).send({ definition, publish: true }).expect(400);
  await o.agent.put(`/workflows/${o.workflowId}/email-source`).send(mailbox).expect(200);
  await o.agent.post(versions).send({ definition, publish: true }).expect(400);
  const current = (await o.agent.get(`/workflows/${o.workflowId}`).expect(200)).body;
  expect(current.live.definition.trigger.type).toBe("manual");
  expect(current.trigger.type).toBe("manual");
  expect((await o.agent.get(versions).expect(200)).body).toHaveLength(2);
});

it("publishes a checked mailbox and refuses failed or disconnected mailboxes", async () => {
  const o = await owner();
  const path = `/workflows/${o.workflowId}/email-source`;
  const versions = `/workflows/${o.workflowId}/versions`;
  await o.agent.put(path).send(mailbox).expect(200);
  // The worker normally sets this after checking the mailbox and its initial UID baseline.
  await db.update(emailSources).set({ status: "active" }).where(eq(emailSources.workflowId, o.workflowId));
  await o.agent.post(versions).send({ definition, publish: true }).expect(201);
  expect((await o.agent.get(`/workflows/${o.workflowId}`).expect(200)).body.trigger.type).toBe("email");
  await db.update(emailSources).set({ status: "failed" }).where(eq(emailSources.workflowId, o.workflowId));
  await o.agent.post(versions).send({ definition, publish: true }).expect(400);
  await o.agent.delete(path).expect(204);
  await o.agent.post(versions).send({ definition, publish: true }).expect(400);
  expect((await o.agent.get(versions).expect(200)).body).toHaveLength(1);
});

it("restarts the new-mail baseline across trigger switches and keeps it for continuous email edits", async () => {
  const o = await owner();
  const path = `/workflows/${o.workflowId}/email-source`;
  const versions = `/workflows/${o.workflowId}/versions`;
  await o.agent.put(path).send(mailbox).expect(200);
  await db.update(emailSources).set({ status: "active" }).where(eq(emailSources.workflowId, o.workflowId));
  await o.agent.post(versions).send({ definition, publish: true }).expect(201);
  await db.update(emailSources).set({ listening: true, uidValidity: "101", lastUid: 9 }).where(eq(emailSources.workflowId, o.workflowId));
  await o.agent.post(versions).send({ definition, publish: true }).expect(201);
  let [source] = await db.select().from(emailSources).where(eq(emailSources.workflowId, o.workflowId));
  expect(source).toMatchObject({ listening: true, uidValidity: "101", lastUid: 9 });
  await o.agent
    .post(versions)
    .send({ definition: { ...definition, trigger: { type: "manual", config: {} } }, publish: true })
    .expect(201);
  [source] = await db.select().from(emailSources).where(eq(emailSources.workflowId, o.workflowId));
  expect(source).toMatchObject({ status: "active", listening: false, uidValidity: null, lastUid: null });
  await o.agent.post(versions).send({ definition, publish: true }).expect(201);
  expect((await o.agent.get(path).expect(200)).body.source).toMatchObject({ status: "active", listening: false });
});

it("limits mailbox connection and check attempts per signed-in owner and route", async () => {
  const o = await owner();
  const path = `/workflows/${o.workflowId}/email-source`;
  for (let i = 0; i < 5; i++) await o.agent.put(path).send(mailbox).expect(200);
  await o.agent.put(path).send(mailbox).expect(429);
  // Changing workflow ids must not bypass the owner's credential-attempt limit.
  const second = (
    await o.agent
      .post("/workflows")
      .send({ name: "Second mailbox", slug: `second-mail-${sequence}` })
      .expect(201)
  ).body;
  await o.agent.put(`/workflows/${second.id}/email-source`).send(mailbox).expect(429);
  for (let i = 0; i < 5; i++) await o.agent.post(`${path}/check`).expect(200);
  await o.agent.post(`${path}/check`).expect(429);
  // The same office IP does not share this stricter limit between owners.
  const other = await owner();
  const otherPath = `/workflows/${other.workflowId}/email-source`;
  await other.agent.put(otherPath).send(mailbox).expect(200);
  await other.agent.post(`${otherPath}/check`).expect(200);
  await o.agent.get(path).expect(200);
  await o.agent.delete(path).expect(204);
});
