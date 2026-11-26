import { randomBytes } from "node:crypto";
import {
  connections,
  runs,
  stepRuns,
  users,
  workflowVersions,
  workflows,
  createApproval,
  type Db,
} from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import type { HomePayload } from "./home";
import type { InboxPayload } from "./inbox";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let seq = 0;

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

async function createOwner() {
  const email = `home${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id, email };
}

async function addMember(ownerAgent: ReturnType<typeof request.agent>, role: "approver" | "requester") {
  const email = `${role}-h-${++seq}@test.local`;
  const created = await ownerAgent.post("/workspace/invites").send({ email, role }).expect(201);
  const token = String(created.body.link).split("/invite/")[1]!;
  const agent = request.agent(server);
  await agent.post(`/auth/invites/${token}/accept`).send({ password: "correct horse battery" }).expect(200);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id, email };
}

describe("Today Home API (G5)", () => {
  it("validates tz, matches GET /inbox counts, surfaces problems and running workflows, and scopes non-staff roles", async () => {
    const owner = await createOwner();
    await owner.agent.get("/home?tz=Not/A_Zone").expect(400);

    const [wf] = await db
      .insert(workflows)
      .values({
        userId: owner.userId,
        name: "Daily inquiries",
        slug: `daily-${seq}`,
        scheduleMissedAt: new Date(),
      })
      .returning();
    const [ver] = await db
      .insert(workflowVersions)
      .values({ workflowId: wf!.id, version: 1, published: true, definition: { trigger: { type: "manual", config: {} }, steps: [], edges: [] } })
      .returning();

    // Live run succeeded today + failed run + failed connection + pending approval
    await db.insert(runs).values({ workflowVersionId: ver!.id, state: "succeeded", test: false }).returning();
    await db.insert(runs).values({ workflowVersionId: ver!.id, state: "failed", test: false, error: "Webhook 500" }).returning();
    const [waitRun] = await db.insert(runs).values({ workflowVersionId: ver!.id, state: "waiting", test: false }).returning();
    const [step] = await db
      .insert(stepRuns)
      .values({ runId: waitRun!.id, stepId: "ap", attempt: 1, state: "waiting", input: { message: "Check" } })
      .returning();
    const approver = await addMember(owner.agent, "approver");
    await createApproval(db, step!.id, new Date(Date.now() + 3600_000), approver.userId);

    await db.insert(connections).values({
      userId: owner.userId,
      provider: "slack",
      status: "failed",
      account: "team-slack",
      credentialCiphertext: "c",
      credentialIv: "i",
      credentialAuthTag: "t",
      authMethod: "token",
      lastError: "invalid_auth",
    });

    const inbox = (await owner.agent.get("/inbox").expect(200)).body as InboxPayload;
    const home = (await owner.agent.get("/home?tz=Asia/Manila").expect(200)).body as HomePayload;

    expect(home.needsYou).toEqual(inbox.counts);
    expect(home.problems.map((p) => p.kind)).toEqual(expect.arrayContaining(["run", "connection", "schedule"]));
    expect(home.running).toEqual([
      expect.objectContaining({
        id: wf!.id,
        name: "Daily inquiries",
        runsToday: 3,
      }),
    ]);
    expect(home.recentRuns.length).toBe(3);

    // Approver sees only their own approval count and no workspace runs/problems.
    const appHome = (await approver.agent.get("/home").expect(200)).body as HomePayload;
    expect(appHome.needsYou.approvals).toBe(1);
    expect(appHome.problems).toEqual([]);
    expect(appHome.running).toEqual([]);
    expect(appHome.recentRuns).toEqual([]);

    // Requester sees zero counts and no workspace runs/problems.
    const requester = await addMember(owner.agent, "requester");
    const reqHome = (await requester.agent.get("/home").expect(200)).body as HomePayload;
    expect(reqHome.needsYou.total).toBe(0);
    expect(reqHome.problems).toEqual([]);
    expect(reqHome.running).toEqual([]);
    expect(reqHome.recentRuns).toEqual([]);
  });
});
