import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startWorker, type Worker } from "../../worker/src/worker";
import { createApp } from "./app";

// The API and the worker together on one database: a webhook call ends as a finished run.
let app: INestApplication;
let boss: PgBoss;
let worker: Worker;
let pool: Pool;

beforeAll(async () => {
  const { url, db, pool: p } = await freshDatabase();
  pool = p;
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  worker = await startWorker({
    connectionString: url,
    db,
    executor: { execute: async ({ step, ctx }) => ({ output: { step: step.id, saw: ctx.trigger } }) },
    pollingIntervalSeconds: 0.5,
    sweepMs: 500,
  });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

it("runs a published workflow end to end from a webhook call", async () => {
  const agent = request.agent(app.getHttpServer());
  await agent.post("/auth/register").send({ email: "e2e@test.local", password: "correct horse battery" }).expect(201);
  const wf = (await agent.post("/workflows").send({ name: "Orders", slug: "orders" }).expect(201)).body;
  const definition = {
    trigger: { type: "webhook" },
    steps: [
      { id: "a", type: "http", config: {} },
      { id: "b", type: "email", config: {} },
    ],
    edges: [{ from: "a", to: "b" }],
  };
  await agent.post(`/workflows/${wf.id}/versions`).send({ definition, publish: true }).expect(201);
  const { trigger } = (await agent.get(`/workflows/${wf.id}`).expect(200)).body;

  const { runId } = (await request(app.getHttpServer()).post(`/hooks/${trigger.webhookPath}`).send({ order: 42 }).expect(202)).body;

  let run: { state: string; steps: { stepId: string; output: unknown }[] } | undefined;
  for (let i = 0; i < 100 && run?.state !== "succeeded"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    run = (await agent.get(`/runs/${runId}`).expect(200)).body;
  }
  expect(run?.state).toBe("succeeded");
  expect(run?.steps.map((s) => s.stepId)).toEqual(["a", "b"]);
  expect(run?.steps[1]?.output).toEqual({ step: "b", saw: { order: 42 } });
});
