import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createDue, runs, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { eq } from "drizzle-orm";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

// Review, "Before release" 2: the multipart parser buffers files before the form is looked up, and per-file and per-IP
// limits do not bound the total held in memory. A budget of bytes in flight, checked before any body is read, does.
const BUDGET = 2 * 1024 * 1024;
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let port = 0;
let server: Parameters<typeof request>[0];

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  // trustProxy lets each call use its own X-Forwarded-For, so the 10 a minute per-IP limit does not mix the tests up.
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, trustProxy: 1, uploadBudgetBytes: BUDGET });
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  port = ((server as unknown as import("node:net").Server).address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

let seq = 0;
let ip = 0;
const nextIp = () => `10.1.${(ip >> 8) & 255}.${++ip & 255}`;

async function fileForm() {
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email: `budget${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  const wf = await agent.post("/workflows").send({ name: "Intake", slug: `budget-${seq}` }).expect(201);
  const fields = [{ name: "photo", label: "Photo", type: "file", required: false }];
  const definition = { trigger: { type: "form", config: { fields } }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  return (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body.trigger.id as string;
}

async function payToken() {
  const email = `budget${++seq}@test.local`;
  await request(server).post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Deposits", slug: `pay-${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
  return (await createDue(db, { userId: u!.id, test: false, workflowId: wf!.id, runId: r!.id, stepId: "ask", reference: `B-${seq}`, kind: "deposit", amountCentavos: 35000 })).token;
}

/** Sends only the headers of a multipart post that declares `length` bytes. The body is never sent, so a server that waits for it hangs. */
function headersOnly(path: string, length: number | undefined, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; abort: () => void }>((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "multipart/form-data; boundary=xyz", "x-forwarded-for": nextIp(), ...extra };
    if (length !== undefined) headers["content-length"] = String(length);
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode!, abort: () => req.destroy() });
    });
    req.on("error", () => {});
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("the server waited for the body instead of answering"));
    });
    req.flushHeaders();
  });
}

/** Holds `length` bytes of the budget by declaring a body and then sending none of it. */
function hold(path: string, length: number) {
  const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "multipart/form-data; boundary=xyz", "content-length": String(length), "x-forwarded-for": nextIp() } });
  req.on("error", () => {});
  req.write("--xyz\r\n");
  return () => req.destroy();
}

// An unknown form: 503 while the budget is full, else 404 straight away, so a probe never waits for a body.
const until = async (want: (s: number) => boolean) => {
  const path = `/forms/${crypto.randomUUID()}`;
  for (let i = 0; i < 40; i++) {
    const res = await headersOnly(path, 1000);
    res.abort();
    if (want(res.status)) return res.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("budget state never reached");
};

describe("multipart upload budget", () => {
  it("answers 503 while the declared bytes in flight would pass the budget, and takes requests again once they end", async () => {
    const id = await fileForm();
    const path = `/forms/${id}`;
    const release = hold(path, BUDGET - 500);
    await until((s) => s === 503);
    release();
    expect(await until((s) => s !== 503)).toBe(404);
  });

  it("refuses a declared size above what one submission can hold, before reading it", async () => {
    const id = await fileForm();
    expect((await headersOnly(`/forms/${id}`, 100 * 1024 * 1024)).status).toBe(413);
  });

  it("refuses a multipart post that declares no length", async () => {
    const id = await fileForm();
    expect((await headersOnly(`/forms/${id}`, undefined)).status).toBe(411);
  });

  it("answers an unknown form, or a form with no file field, before reading the body", async () => {
    expect((await headersOnly(`/forms/${crypto.randomUUID()}`, 1000)).status).toBe(404);
    const agent = request.agent(server);
    await agent.post("/auth/register").send({ email: `budget${++seq}@test.local`, password: "correct horse battery" }).expect(201);
    const wf = await agent.post("/workflows").send({ name: "Plain", slug: `plain-${seq}` }).expect(201);
    const definition = { trigger: { type: "form", config: { fields: [{ name: "name", label: "Name", type: "text", required: false }] } }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
    await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
    const formId = (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body.trigger.id as string;
    expect((await headersOnly(`/forms/${formId}`, 1000)).status).toBe(415);
  });

  // Review of 22 November, M1: the pay page read receipts with multer outside the budget, for any token.
  it("holds the pay page to the same budget, and answers an unknown pay link before reading the body", async () => {
    expect((await headersOnly(`/pay/${"x".repeat(43)}`, 1000)).status).toBe(404);
    const token = await payToken();
    expect((await headersOnly(`/pay/${token}`, 20 * 1024 * 1024)).status).toBe(413);
    const id = await fileForm();
    const release = hold(`/forms/${id}`, BUDGET - 500);
    await until((s) => s === 503);
    const busy = await headersOnly(`/pay/${token}`, 1000);
    busy.abort();
    expect(busy.status).toBe(503);
    release();
    await until((s) => s !== 503);
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg body")]);
    await request(server).post(`/pay/${token}`).set("X-Forwarded-For", nextIp()).field("transfer_ref", "BUDGET1234").attach("receipt", JPEG, "r.jpg").expect(200);
  });

  it("still takes an ordinary small upload and a plain urlencoded post", async () => {
    const id = await fileForm();
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg body")]);
    await request(server).post(`/forms/${id}`).set("X-Forwarded-For", nextIp()).attach("photo", JPEG, "a.jpg").expect(200);
    await request(server).post(`/forms/${id}`).set("X-Forwarded-For", nextIp()).type("form").send({}).expect(200);
  });
});
