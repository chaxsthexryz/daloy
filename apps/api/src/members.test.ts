import { randomBytes, randomUUID } from "node:crypto";
import { createInvite, joinWorkspace, sessions, users, type Db } from "@daloy/db";
import { defaultAnswers, officeRequestDefinition } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { hash } from "@node-rs/argon2";
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
const nextEmail = () => `team${++seq}@test.local`;

async function owner() {
  const agent = request.agent(server);
  const email = nextEmail();
  const res = await agent.post("/auth/register").send({ email, password: PASSWORD }).expect(201);
  return { agent, email, id: res.body.id as string };
}

const tokenOf = (link: string) => /#\/invite\/([A-Za-z0-9_-]{43})$/.exec(link)![1]!;

/** Invites a new person with `role` and signs them in through the invite link (rate limited to 10 a minute per IP). */
async function invited(boss: Agent, role: "operator" | "approver" | "requester") {
  const email = nextEmail();
  const invite = await boss.post("/workspace/invites").send({ email, role }).expect(201);
  const agent = request.agent(server);
  const res = await agent.post(`/auth/invites/${tokenOf(invite.body.link)}/accept`).send({ password: PASSWORD }).expect(200);
  return { agent, email, id: res.body.id as string };
}

/** A member added straight in the database with a live session, for tests about what a member may do afterwards. */
async function member(ownerAgent: Agent, role: "operator" | "approver" | "requester") {
  const workspaceId = (await ownerAgent.get("/auth/me").expect(200)).body.workspaceId as string;
  const email = nextEmail();
  const [u] = await db.insert(users).values({ email, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return { agent: request.agent(server).set("Cookie", `daloy_session=${token}`), email, id: u!.id };
}

describe("registration and sign-in", () => {
  it("makes a new account the owner of its own workspace", async () => {
    const o = await owner();
    expect((await o.agent.get("/auth/me").expect(200)).body).toEqual({ id: o.id, email: o.email, workspaceId: o.id, role: "owner" });
  });
});

describe("invites", () => {
  it("returns a one-time link; accepting creates the account in the owner's workspace with the role", async () => {
    const o = await owner();
    const invite = await o.agent.post("/workspace/invites").send({ email: "Rosa@Test.local", role: "approver" }).expect(201);
    expect(invite.body.link).toMatch(/^https:\/\/daloy\.example\.com\/#\/invite\/[A-Za-z0-9_-]{43}$/);
    const agent = request.agent(server);
    await agent.post(`/auth/invites/${tokenOf(invite.body.link)}/accept`).send({ password: PASSWORD }).expect(200);
    expect((await agent.get("/auth/me").expect(200)).body).toMatchObject({ email: "rosa@test.local", workspaceId: o.id, role: "approver" });
    // The same link a second time does nothing.
    await request(server).post(`/auth/invites/${tokenOf(invite.body.link)}/accept`).send({ password: PASSWORD }).expect(404);
    const list = (await o.agent.get("/workspace/members").expect(200)).body as { email: string; role: string }[];
    expect(list.map((m) => [m.email, m.role])).toEqual([
      [o.email, "owner"],
      ["rosa@test.local", "approver"],
    ]);
  });

  it("refuses an expired invite, an owner invite, a bad token and someone already in the workspace", async () => {
    const o = await owner();
    const expired = await createInvite(db, o.id, nextEmail(), "operator", -1000);
    await request(server).post(`/auth/invites/${expired}/accept`).send({ password: PASSWORD }).expect(404);
    await request(server).post("/auth/invites/short/accept").send({ password: PASSWORD }).expect(400);
    await o.agent.post("/workspace/invites").send({ email: nextEmail(), role: "owner" }).expect(400);
    const m = await member(o.agent, "operator");
    await o.agent.post("/workspace/invites").send({ email: m.email, role: "approver" }).expect(409);
    await o.agent.post("/workspace/invites").send({ email: o.email, role: "approver" }).expect(409);
  });

  it("refuses an account that already belongs to a workspace, and leaves the invite usable", async () => {
    const o = await owner();
    const other = await owner();
    const invite = await o.agent.post("/workspace/invites").send({ email: other.email, role: "operator" }).expect(201);
    await request(server).post(`/auth/invites/${tokenOf(invite.body.link)}/accept`).send({ password: "wrong password here" }).expect(401);
    await request(server).post(`/auth/invites/${tokenOf(invite.body.link)}/accept`).send({ password: PASSWORD }).expect(409);
    expect((await other.agent.get("/auth/me").expect(200)).body.role).toBe("owner");
  });

  it("lets a removed member rejoin through a new invite with their own password", async () => {
    const o = await owner();
    const m = await invited(o.agent, "operator");
    await o.agent.delete(`/workspace/members/${m.id}`).expect(204);
    const invite = await o.agent.post("/workspace/invites").send({ email: m.email, role: "requester" }).expect(201);
    const agent = request.agent(server);
    await agent.post(`/auth/invites/${tokenOf(invite.body.link)}/accept`).send({ password: "wrong password here" }).expect(401);
    await agent.post(`/auth/invites/${tokenOf(invite.body.link)}/accept`).send({ password: PASSWORD }).expect(200);
    expect((await agent.get("/auth/me").expect(200)).body).toMatchObject({ id: m.id, role: "requester", workspaceId: o.id });
  });
});

describe("changing and removing members", () => {
  it("changes a role, and never the owner's", async () => {
    const o = await owner();
    const m = await member(o.agent, "requester");
    await o.agent.patch(`/workspace/members/${m.id}`).send({ role: "operator" }).expect(204);
    expect((await m.agent.get("/auth/me").expect(200)).body.role).toBe("operator");
    await o.agent.patch(`/workspace/members/${m.id}`).send({ role: "owner" }).expect(400);
    await o.agent.patch(`/workspace/members/${o.id}`).send({ role: "operator" }).expect(404);
    await o.agent.delete(`/workspace/members/${o.id}`).expect(404);
  });

  it("removing a member signs them out and keeps them out", async () => {
    const o = await owner();
    const m = await member(o.agent, "operator");
    await m.agent.get("/workflows").expect(200);
    await o.agent.delete(`/workspace/members/${m.id}`).expect(204);
    await m.agent.get("/workflows").expect(401);
    await request(server).post("/auth/login").send({ email: m.email, password: PASSWORD }).expect(403);
  });

  it("can't touch members of another workspace", async () => {
    const a = await owner();
    const b = await owner();
    const theirs = await member(b.agent, "operator");
    await a.agent.patch(`/workspace/members/${theirs.id}`).send({ role: "approver" }).expect(404);
    await a.agent.delete(`/workspace/members/${theirs.id}`).expect(404);
    const list = (await a.agent.get("/workspace/members").expect(200)).body as { email: string }[];
    expect(list.map((m) => m.email)).toEqual([a.email]);
  });
});

describe("role permissions", () => {
  const answers = defaultAnswers("office@test.local");

  it("gives each role exactly its routes", async () => {
    const o = await owner();
    const wf = await o.agent.post("/workflows").send({ name: "Office requests", slug: "office" }).expect(201);
    const id = wf.body.id as string;
    const agents = {
      owner: o.agent,
      operator: (await member(o.agent, "operator")).agent,
      approver: (await member(o.agent, "approver")).agent,
      requester: (await member(o.agent, "requester")).agent,
    };
    const only = ["owner"];
    const operate = ["owner", "operator"];
    const all = ["owner", "operator", "approver", "requester"];
    const routes: [string, string, string[], object?][] = [
      ["get", "/auth/me", all],
      ["get", "/my/requests", all],
      ["get", "/workflows", operate],
      ["get", `/workflows/${id}`, operate],
      ["get", `/workflows/${id}/requests`, operate],
      ["get", `/workflows/${id}/versions`, operate],
      ["get", "/runs", operate],
      ["get", `/deliveries?runId=${randomUUID()}`, operate],
      ["get", "/templates", operate],
      ["get", "/step-schemas", operate],
      ["post", "/workflows", only, { name: "x", slug: `x-${randomUUID().slice(0, 8)}` }],
      ["patch", `/workflows/${id}`, only, { name: "Renamed" }],
      ["patch", `/workflows/${id}/setup`, only, { step: "fields", answers }],
      ["post", `/workflows/${id}/versions`, only, { definition: officeRequestDefinition(answers) }],
      ["post", `/workflows/${id}/test-runs`, only, {}],
      ["post", `/workflows/${id}/runs`, only, {}],
      ["get", "/secrets", only],
      ["get", "/tokens", only],
      ["get", "/settings/ai", only],
      ["get", "/settings/email", only],
      ["get", "/settings/connections", only],
      ["post", "/ai/draft", only, { description: "x" }],
      ["get", "/workspace/members", only],
      ["post", "/workspace/invites", only, { email: "x@test.local", role: "operator" }],
      ["patch", `/workspace/members/${randomUUID()}`, only, { role: "operator" }],
      ["delete", `/workspace/members/${randomUUID()}`, only],
      ["post", `/deliveries/${randomUUID()}/retry`, operate, {}],
      ["post", `/deliveries/${randomUUID()}/confirm`, operate],
      ["delete", `/workflows/${randomUUID()}`, only],
      ["get", "/resources", all],
      ["post", "/resources", only, { name: `Room ${randomUUID().slice(0, 8)}` }],
      ["patch", `/resources/${randomUUID()}`, only, { active: false }],
    ];
    const wrong: string[] = [];
    for (const [method, path, allowed, body] of routes) {
      for (const [role, agent] of Object.entries(agents)) {
        const req = (agent as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
        const res = await (body ? req.send(body) : req);
        const refused = res.status === 403 || res.status === 401;
        if (refused === allowed.includes(role)) wrong.push(`${role} ${method} ${path} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps every role out of another workspace's data", async () => {
    const a = await owner();
    const wf = await a.agent.post("/workflows").send({ name: "Office requests", slug: "office" }).expect(201);
    const b = await owner();
    const theirOperator = await member(b.agent, "operator");
    for (const agent of [b.agent, theirOperator.agent]) {
      await agent.get(`/workflows/${wf.body.id}`).expect(404);
      await agent.get(`/workflows/${wf.body.id}/requests`).expect(404);
      expect((await agent.get("/workflows").expect(200)).body).toEqual([]);
    }
  });

  it("lets an operator see the owner's workflows and requests", async () => {
    const o = await owner();
    const wf = await o.agent.post("/workflows").send({ name: "Office requests", slug: "office" }).expect(201);
    const op = await member(o.agent, "operator");
    expect((await op.agent.get("/workflows").expect(200)).body.map((w: { id: string }) => w.id)).toEqual([wf.body.id]);
  });
});

describe("named approvers in a workflow", () => {
  const approvalDefinition = (approver: string) => ({
    trigger: { type: "manual" },
    steps: [{ id: "ask", type: "approval", config: { approver, subject: "Buy?", message: "A printer", timeoutSeconds: 3600 } }],
  });

  it("refuses to turn on an approval named to someone who can't approve in this workspace", async () => {
    const o = await owner();
    const op = await member(o.agent, "operator");
    const ap = await member(o.agent, "approver");
    const stranger = await owner();
    const wf = await o.agent.post("/workflows").send({ name: "Purchases", slug: "purchases" }).expect(201);
    for (const email of [op.email, stranger.email, "nobody@test.local"]) {
      const res = await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: approvalDefinition(email), publish: true }).expect(400);
      expect(JSON.stringify(res.body)).toContain("can't approve");
    }
    // A draft is fine; only turning it on checks.
    await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: approvalDefinition(op.email) }).expect(201);
    await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: approvalDefinition(ap.email), publish: true }).expect(201);
    await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: approvalDefinition(o.email), publish: true }).expect(201);
  });
});

describe("my requests", () => {
  const answers = defaultAnswers("office@test.local");
  const submission = { name: "Rosa Diaz", email: "rosa@example.com", summary: "The printer on floor 2 is jammed.", location: "Floor 2" };

  it("records who sent a form while signed in and shows each member only their own", async () => {
    const o = await owner();
    const wf = await o.agent.post("/workflows").send({ name: "Office requests", slug: "office" }).expect(201);
    await o.agent.patch(`/workflows/${wf.body.id}/setup`).send({ step: "review", answers }).expect(200);
    await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: officeRequestDefinition(answers), publish: true }).expect(201);
    const formId = (await o.agent.get(`/workflows/${wf.body.id}`).expect(200)).body.trigger.id as string;

    const rosa = await member(o.agent, "requester");
    const other = await member(o.agent, "requester");
    const stranger = await owner();
    await rosa.agent.post(`/forms/${formId}`).type("form").send({ ...submission, submission_key: randomUUID() }).expect(200);
    // Signed out, and signed in to another workspace: recorded without a requester.
    await request(server).post(`/forms/${formId}`).type("form").send({ ...submission, submission_key: randomUUID() }).expect(200);
    await stranger.agent.post(`/forms/${formId}`).type("form").send({ ...submission, submission_key: randomUUID() }).expect(200);

    const embedded = `/forms/${formId}/embed`;
    const shown = await rosa.agent.get(embedded).expect(200);
    expect(shown.headers["x-frame-options"]).toBeUndefined();
    expect(shown.headers["content-security-policy"]).toMatch(/frame-ancestors [^;]*https:/);
    const key = /name="submission_key" value="([^"]+)"/.exec(shown.text)![1];
    const data = { ...submission, submission_key: key };
    await rosa.agent.post(embedded).type("form").send({ ...data, email: "invalid" }).expect(400);
    await rosa.agent.post(embedded).type("form").send({ ...data, _website: "spam" }).expect(200);
    for (let attempt = 0; attempt < 2; attempt++) {
      const receipt = await rosa.agent.post(embedded).type("form").send(data).expect(200);
      expect(receipt.text).toContain("Request received");
      expect(receipt.headers["x-frame-options"]).toBeUndefined();
    }
    for (const path of [`/forms/${formId}`, "/workflows", "/approvals/invalid"]) {
      const protectedPage = await rosa.agent.get(path);
      expect(protectedPage.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
      expect(protectedPage.headers["x-frame-options"]).toBe("SAMEORIGIN");
    }

    const mine = (await rosa.agent.get("/my/requests").expect(200)).body as { reference: string; subject: string; automation: string }[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ subject: submission.summary, automation: "Office requests" });
    expect((await other.agent.get("/my/requests").expect(200)).body).toEqual([]);
    expect((await stranger.agent.get("/my/requests").expect(200)).body).toEqual([]);
    expect((await o.agent.get(`/workflows/${wf.body.id}/requests`).expect(200)).body).toHaveLength(4);
  });
});
