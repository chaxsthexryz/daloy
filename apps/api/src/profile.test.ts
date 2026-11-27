import { randomBytes } from "node:crypto";
import { joinWorkspace, runs, sessions, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
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
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, publicUrl: "https://daloy.example.com" });
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
  const email = `profile${++seq}@test.local`;
  const res = await agent.post("/auth/register").send({ email, password: PASSWORD }).expect(201);
  return { agent, email, id: res.body.id as string };
}

/** A member added straight in the database with a live session. */
async function member(ownerAgent: Agent, role: "operator" | "approver" | "requester") {
  const workspaceId = (await ownerAgent.get("/auth/me").expect(200)).body.workspaceId as string;
  const email = `profile${++seq}@test.local`;
  const [u] = await db.insert(users).values({ email, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return { agent: request.agent(server).set("Cookie", `daloy_session=${token}`), email, id: u!.id };
}

describe("PUT /auth/profile", () => {
  it("needs a signed-in user", async () => {
    await request(server).put("/auth/profile").send({ displayName: "Maria" }).expect(401);
  });

  it("is null until set, saves a trimmed name and shows it in /auth/me and after sign-in", async () => {
    const o = await owner();
    expect((await o.agent.get("/auth/me").expect(200)).body.displayName).toBeNull();
    await o.agent.put("/auth/profile").send({ displayName: "  Maria Santos  " }).expect(200).expect({ displayName: "Maria Santos" });
    expect((await o.agent.get("/auth/me").expect(200)).body.displayName).toBe("Maria Santos");
    const [row] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, o.id));
    expect(row!.displayName).toBe("Maria Santos");
    const again = await request(server).post("/auth/login").send({ email: o.email, password: PASSWORD }).expect(200);
    expect(again.body.displayName).toBe("Maria Santos");
  });

  it("clears the name with null", async () => {
    const o = await owner();
    await o.agent.put("/auth/profile").send({ displayName: "Maria" }).expect(200);
    await o.agent.put("/auth/profile").send({ displayName: null }).expect(200).expect({ displayName: null });
    expect((await o.agent.get("/auth/me").expect(200)).body.displayName).toBeNull();
  });

  it.each([
    ["an empty string", { displayName: "" }],
    ["only spaces", { displayName: "   " }],
    ["61 characters", { displayName: "a".repeat(61) }],
    ["a newline", { displayName: "Maria\nSantos" }],
    ["a control character", { displayName: "Maria\u0007" }],
    ["a number", { displayName: 5 }],
    ["a missing field", {}],
    ["an unknown field", { displayName: "Maria", role: "owner" }],
  ])("rejects %s", async (_label, body) => {
    const o = await owner();
    await o.agent.put("/auth/profile").send(body).expect(400);
    expect((await o.agent.get("/auth/me").expect(200)).body.displayName).toBeNull();
  });

  it("accepts exactly 60 characters and accented names", async () => {
    const o = await owner();
    await o.agent.put("/auth/profile").send({ displayName: "a".repeat(60) }).expect(200);
    await o.agent.put("/auth/profile").send({ displayName: "José Peña" }).expect(200).expect({ displayName: "José Peña" });
  });

  it("works for every role, and each person only changes their own row", async () => {
    const o = await owner();
    for (const role of ["operator", "approver", "requester"] as const) {
      const m = await member(o.agent, role);
      await m.agent.put("/auth/profile").send({ displayName: `Name of ${role}` }).expect(200);
      expect((await m.agent.get("/auth/me").expect(200)).body.displayName).toBe(`Name of ${role}`);
    }
    expect((await o.agent.get("/auth/me").expect(200)).body.displayName).toBeNull();
  });

  it("refuses a database row that is empty or too long", async () => {
    const o = await owner();
    await expect(db.update(users).set({ displayName: "" }).where(eq(users.id, o.id))).rejects.toThrow();
    await expect(db.update(users).set({ displayName: "a".repeat(61) }).where(eq(users.id, o.id))).rejects.toThrow();
  });
});

describe("the name in the members list", () => {
  it("shows each member's name next to their email, null when not set", async () => {
    const o = await owner();
    const op = await member(o.agent, "operator");
    await member(o.agent, "requester");
    await o.agent.put("/auth/profile").send({ displayName: "Maria Santos" }).expect(200);
    await op.agent.put("/auth/profile").send({ displayName: "Ben Cruz" }).expect(200);
    const list = (await o.agent.get("/workspace/members").expect(200)).body as { email: string; displayName: string | null; role: string }[];
    expect(list.map((m) => [m.role, m.displayName])).toEqual([["owner", "Maria Santos"], ["operator", "Ben Cruz"], ["requester", null]]);
    expect(list[0]!.email).toBe(o.email);
  });
});

describe("the name in run history", () => {
  it("replaces the email stored as 'decided by' with the current name, and keeps the email without one", async () => {
    const o = await owner();
    const approver = await member(o.agent, "approver");
    const [wf] = await db.insert(workflows).values({ userId: o.id, name: "Purchases", slug: `purchases-${++seq}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    const [run] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "succeeded" }).returning();
    const output = { decision: "approved", decidedBy: approver.email, decidedAt: new Date().toISOString() };
    await db.insert(stepRuns).values({ runId: run!.id, stepId: "ask", attempt: 1, state: "succeeded", output });
    const decidedBy = async () => ((await o.agent.get(`/runs/${run!.id}`).expect(200)).body.steps[0].output as typeof output).decidedBy;
    expect(await decidedBy()).toBe(approver.email);
    await approver.agent.put("/auth/profile").send({ displayName: "Ana Reyes" }).expect(200);
    expect(await decidedBy()).toBe("Ana Reyes");
  });
});
