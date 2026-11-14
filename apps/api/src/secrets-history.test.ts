import { randomBytes } from "node:crypto";
import { runs, smtpMailer, stepRuns, users, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

// Regression for the fec03cc report: run history must not reveal a secret in any encoding, including rows written
// before the fix and values the owner has since rotated or deleted (decision 0025).
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
const key = randomBytes(32);
let seq = 0;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  const mail: MailDeps = { installation: smtpMailer({}), gmail: () => smtpMailer({}).transport, sharedMail: "open" };
  app = await createApp({ db, boss, secretsKey: key, secureCookies: false, mail, publicUrl: "https://daloy.example.com" });
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
  const email = `hist${++seq}@test.local`;
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: user!.id };
}

const V1 = 'old"se\\cret\nvalue%';
const forms = (v: string) => [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2)];

describe("run history and secrets", () => {
  it("hides every form of a secret in rows written before the fix, also after the secret is rotated and deleted", async () => {
    const { agent, userId } = await owner();
    await agent.put("/secrets/tricky").send({ value: V1 }).expect(204);
    // A row as the old worker could leave it: the secret JSON-escaped in the body, URL-encoded in a reply, raw in an error.
    const [wf] = await db.insert(workflows).values({ userId, name: "Old", slug: `old-${seq}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "failed", triggerPayload: { note: V1 }, error: `step call: ${V1}` }).returning();
    await db.insert(stepRuns).values({
      runId: r!.id,
      stepId: "call",
      attempt: 1,
      state: "failed",
      input: { body: JSON.stringify({ token: V1 }) },
      output: { body: `echo=${encodeURIComponent(V1)}&form=${new URLSearchParams({ v: V1 }).toString().slice(2)}` },
      error: `failed with ${V1}`,
    });

    const leaked = async () => {
      const text = JSON.stringify([(await agent.get(`/runs/${r!.id}`).expect(200)).body, (await agent.get("/runs").expect(200)).body]);
      return forms(V1).filter((f) => text.includes(f) || text.includes(JSON.stringify(f).slice(1, -1)));
    };
    expect(await leaked()).toEqual([]);
    await agent.put("/secrets/tricky").send({ value: "new-value" }).expect(204);
    expect(await leaked()).toEqual([]);
    await agent.delete("/secrets/tricky").expect(204);
    expect(await leaked()).toEqual([]);
    // Retired values are for redaction only: the secret is gone for workflows.
    expect((await agent.get("/secrets").expect(200)).body).toEqual([]);
  });

  it("refuses to save JSON bodies that will not parse, secrets outside HTTP steps and secrets sent to data-chosen hosts", async () => {
    const { agent } = await owner();
    const wf = (await agent.post("/workflows").send({ name: "Checks", slug: `checks-${seq}` }).expect(201)).body as { id: string };
    const save = (steps: unknown[]) => agent.post(`/workflows/${wf.id}/versions`).send({ definition: { trigger: { type: "manual", config: {} }, steps, edges: [] } });
    const http = (config: object) => ({ id: "call", type: "http", config: { method: "POST", headers: {}, ...config } });

    expect((await save([http({ url: "https://a.example/x", headers: { "content-type": "application/json" }, body: '{"a": 1' })]).expect(400)).body.message).toEqual([expect.stringContaining("not valid JSON")]);
    expect((await save([{ id: "mail", type: "email", config: { to: "a@example.com", subject: "s", text: "{{secrets.k}}" } }]).expect(400)).body.message).toEqual([expect.stringContaining("only be used in HTTP steps")]);
    expect((await save([http({ url: "https://{{trigger.host}}/x", headers: { Authorization: "{{secrets.k}}" } })]).expect(400)).body.message).toEqual([expect.stringContaining("fixed address")]);
    await save([http({ url: "https://a.example/x/{{trigger.id}}", headers: { Authorization: "{{secrets.k}}", "content-type": "application/json" }, body: '{"amount": {{trigger.amount}}}' })]).expect(201);
    // A test run saves the draft too, so it gets the same check.
    await agent.post(`/workflows/${wf.id}/test-runs`).send({ definition: { trigger: { type: "manual", config: {} }, steps: [http({ url: "{{trigger.url}}", headers: { Authorization: "{{secrets.k}}" } })], edges: [] }, payload: {} }).expect(400);
  });
});
