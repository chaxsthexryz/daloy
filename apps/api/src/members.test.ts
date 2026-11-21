import { randomBytes, randomUUID } from "node:crypto";
import { createInvite, joinWorkspace, queueDelivery, sessions, users, type Db } from "@daloy/db";
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
    expect((await o.agent.get("/auth/me").expect(200)).body).toEqual({ id: o.id, email: o.email, workspaceId: o.id, role: "owner", ask: false, language: "en" });
  });
});

describe("workspace language", () => {
  it("starts in English, applies the owner's choice to existing members, and can switch back", async () => {
    const o = await owner();
    const operator = await member(o.agent, "operator");
    const other = await owner();
    const path = "/settings/language";
    await request(server).put(path).send({ language: "tl" }).expect(401);
    await operator.agent.put(path).send({ language: "tl" }).expect(403);
    await o.agent.put(path).send({ language: "fr" }).expect(400);
    await o.agent.put(path).send({ language: "tl", workspaceId: other.id }).expect(400);
    await o.agent.put(path).send({ language: "tl" }).expect(200, { language: "tl" });
    expect((await operator.agent.get("/auth/me")).body.language).toBe("tl");
    expect((await other.agent.get("/auth/me")).body.language).toBe("en");
    const login = await request(server).post("/auth/login").send({ email: operator.email, password: PASSWORD }).expect(200);
    expect(login.body.language).toBe("tl");
    const invite = await o.agent.post("/workspace/invites").send({ email: nextEmail(), role: "requester" }).expect(201);
    const joined = await request(server).post(`/auth/invites/${tokenOf(invite.body.link)}/accept`).send({ password: PASSWORD }).expect(200);
    expect(joined.body.language).toBe("tl");
    await o.agent.put(path).send({ language: "en" }).expect(200, { language: "en" });
    expect((await operator.agent.get("/auth/me")).body.language).toBe("en");
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

  const only = ["owner"];
  const operate = ["owner", "operator"];
  const all = ["owner", "operator", "approver", "requester"];
  const routeMatrix = (id: string): [string, string, string[], object?][] => [
      ["get", "/auth/me", all],
      ["get", "/my/requests", all],
      ["get", "/workflows", operate],
      ["get", "/workflows/overview", operate],
      ["get", `/workflows/${id}`, operate],
      ["get", `/workflows/${id}/requests`, operate],
      ["get", `/workflows/${id}/versions`, operate],
      ["get", "/runs", operate],
      ["get", `/deliveries?runId=${randomUUID()}`, operate],
      ["get", `/runs/${randomUUID()}/files/${randomUUID()}`, operate],
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
      ["post", "/settings/connections/outlook/oauth/start", only],
      ["post", "/settings/connections/gmail/oauth/start", only],
      ["post", "/settings/connections/google-sheets/picker-token", only],
      ["post", "/settings/connections/google-drive/picker-token", only],
      ["post", "/settings/connections/google-sheets/create", only],
      ["post", "/settings/connections/google-sheets/pick", only, {}],
      ["get", "/settings/connections/google-sheets/tabs", only],
      ["post", "/settings/connections/google-drive/create", only],
      ["post", "/settings/connections/google-drive/pick", only, {}],
      ["post", "/settings/connections/google-calendar/create", only, {}],
      ["get", "/settings/connections/airtable/bases", only],
      ["get", "/settings/connections/airtable/bases/app1234567890/tables", only],
      ["put", "/settings/connections/airtable/target", only, {}],
      ["get", "/settings/connections/notion/databases", only],
      ["put", "/settings/connections/notion/target", only, {}],
      ["get", "/settings/connections/trello/boards", only],
      ["get", "/settings/connections/trello/boards/0123456789abcdef01234567/lists", only],
      ["put", "/settings/connections/trello/target", only, {}],
      ["post", "/settings/connections/telegram/chats", only, {}],
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
      ["get", `/workflows/${id}/versions/1`, operate],
      ["post", `/workflows/${id}/webhook-url`, only, {}],
      ["get", `/workflows/${id}/email-source`, only],
      ["put", `/workflows/${id}/email-source`, only, {}],
      ["post", `/workflows/${id}/email-source/check`, only, {}],
      ["delete", `/workflows/${id}/email-source`, only],
      ["get", "/usage", operate],
      ["get", `/runs/ask?reference=REQ-1`, operate],
      ["post", "/runs/ask/reword", only, {}],
      ["get", `/runs/export.csv?workflowId=${id}`, operate],
      ["get", `/runs/${randomUUID()}`, operate],
      ["get", `/runs/${randomUUID()}/explanation`, operate],
      ["post", `/runs/${randomUUID()}/explanation/reword`, only, {}],
      ["post", `/runs/${randomUUID()}/resolve`, operate, {}],
      ["post", `/runs/${randomUUID()}/cancel`, operate, {}],
      ["post", `/runs/${randomUUID()}/retry`, operate, {}],
      ["put", "/secrets/matrix_secret", only, { value: "x" }],
      ["delete", "/secrets/matrix_secret", only],
      ["get", "/bookings", operate],
      ["get", "/bookings/export.csv", operate],
      ["post", `/bookings/${randomUUID()}/cancel`, operate, {}],
      ["post", `/bookings/${randomUUID()}/no-show`, operate, {}],
      ["post", `/bookings/${randomUUID()}/undo-no-show`, operate, {}],
      ["post", `/bookings/${randomUUID()}/reschedule`, operate, {}],
      ["post", "/tokens", only, { name: "matrix", scopes: ["read"] }],
      ["delete", `/tokens/${randomUUID()}`, only],
      ["get", "/settings/ai/local-models", only],
      ["post", "/settings/ai/models", only, {}],
      ["put", "/settings/ai", only, {}],
      ["post", "/settings/ai/test", only, {}],
      ["put", "/settings/language", only, {}],
      ["put", "/settings/email/profile", only, {}],
      ["put", "/settings/email/gmail", only, {}],
      ["post", "/settings/email/test", only, {}],
      ["post", "/settings/email/verify", only, {}],
      ["post", "/settings/email/verify/status", only, {}],
      ["post", "/settings/email/disconnect", only, {}],
      ["delete", "/settings/email/gmail", only],
      ["put", "/settings/connections/google-sheets", only, {}],
      ["put", "/settings/connections/google-sheets/destination", only, {}],
      ["post", "/settings/connections/google-sheets/test", only, {}],
      ["put", "/settings/connections/google-calendar", only, {}],
      ["post", "/settings/connections/google-calendar/test", only, {}],
      ["put", "/settings/connections/google-drive", only, {}],
      ["put", "/settings/connections/slack", only, {}],
      ["post", "/settings/connections/slack/test", only, {}],
      ["get", "/settings/connections/slack/channels", only],
      ["put", "/settings/connections/slack/channel", only, {}],
      ["put", "/settings/connections/telegram", only, {}],
      ["post", "/settings/connections/telegram/test", only, {}],
      ["put", "/settings/connections/unisms", only, {}],
      ["post", "/settings/connections/unisms/test", only, {}],
      ["delete", "/settings/connections/unisms", only],
      ["put", "/settings/connections/paymongo", only, {}],
      ["post", "/settings/connections/paymongo/test", only, {}],
      ["put", "/settings/connections/airtable", only, {}],
      ["post", "/settings/connections/airtable/test", only, {}],
      ["put", "/settings/connections/notion", only, {}],
      ["post", "/settings/connections/notion/test", only, {}],
      ["put", "/settings/connections/trello", only, {}],
      ["post", "/settings/connections/trello/test", only, {}],
      ["post", "/settings/connections/outlook/start", only, {}],
      ["post", "/settings/connections/outlook/test", only, {}],
      ["put", "/settings/connections/teams", only, {}],
      ["post", "/settings/connections/teams/test", only, {}],
      ["put", "/settings/connections/meta-messenger", only, {}],
      ["post", "/settings/connections/meta-messenger/test", only, {}],
      ["delete", "/settings/connections/slack", only],
      ["post", "/ai/chat", only, {}],
      ["get", "/settings/brand", only],
      ["put", "/settings/brand", only, {}],
      ["put", "/settings/brand/logo", only],
      ["delete", "/settings/brand/logo", only],
      // Pause and resume last: a paused automation refuses the runs above.
      ["post", `/workflows/${id}/pause`, only],
      ["post", `/workflows/${id}/resume`, only],
    ];

  // Not in the matrix on purpose. Each is public by design or guarded by its own rule, and has its own tests:
  // auth.ts and password.test.ts, public*.test.ts, paymongo.test.ts and meta.test.ts, approvals.test.ts, mcp.test.ts, oauth.test.ts, microsoft.test.ts, brand.test.ts.
  const outsideMatrix = new Set([
    "POST /auth/register", "POST /auth/login", "POST /auth/invites/:token/accept", "POST /auth/logout", "POST /auth/password", "POST /auth/password-reset", "POST /auth/password-reset/:token",
    "POST /hooks/:path", "POST /hooks/paymongo/:path", "GET /hooks/meta/:path", "POST /hooks/meta/:path", "GET /forms/:id", "GET /forms/:id/embed", "POST /forms/:id", "POST /forms/:id/embed",
    "GET /approvals/:token", "POST /approvals/:token", "GET /settings/connections/oauth/callback", "GET /settings/connections/outlook/callback", "GET /brand/logo/:id",
  ]);

  it("gives each role exactly its routes", async () => {
    const o = await owner();
    const wf = await o.agent.post("/workflows").send({ name: "Office requests", slug: "office" }).expect(201);
    const id = wf.body.id as string;
    const agents = {
      owner: o.agent,
      operator: (await member(o.agent, "operator")).agent,
      approver: (await member(o.agent, "approver")).agent,
      requester: (await member(o.agent, "requester")).agent,
      signedOut: request.agent(server),
    };
    const wrong: string[] = [];
    for (const [method, path, allowed, body] of routeMatrix(id)) {
      for (const [role, agent] of Object.entries(agents)) {
        const req = (agent as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
        const res = await (body ? req.send(body) : req);
        const refused = res.status === 403 || res.status === 401;
        // Signed out is always a 401: the session check comes before any role check.
        if (role === "signedOut" ? res.status !== 401 : refused === allowed.includes(role)) wrong.push(`${role} ${method} ${path} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 15_000);

  it("puts every route the API registers in the matrix or on the short list of routes with their own rules", () => {
    const stack = (app.getHttpAdapter().getInstance() as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }).router.stack;
    // /mcp answers every verb and checks an API token, not a session (mcp.test.ts).
    const registered = stack.flatMap((l) => (l.route && l.route.path !== "/mcp" ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`) : []));
    const params = (r: string) => (r.match(/:/g) ?? []).length;
    const matches = (route: string, method: string, path: string) => {
      const [m, pattern] = route.split(" ") as [string, string];
      if (m !== method.toUpperCase()) return false;
      const want = pattern.split("/");
      const got = path.split("?")[0]!.split("/");
      return want.length === got.length && want.every((seg, i) => (seg.startsWith(":") ? got[i]!.length > 0 : seg === got[i]));
    };
    const covered = new Set<string>();
    const stray: string[] = [];
    for (const [method, path] of routeMatrix(randomUUID())) {
      // A concrete path can fit several patterns (/runs/ask and /runs/:id): the one with fewer parameters is meant.
      const best = registered.filter((r) => matches(r, method, path)).sort((a, b) => params(a) - params(b))[0];
      if (best) covered.add(best);
      else stray.push(`${method} ${path}`);
    }
    expect({ stray, unlisted: registered.filter((r) => !covered.has(r) && !outsideMatrix.has(r)), staleOutside: [...outsideMatrix].filter((r) => !registered.includes(r)) }).toEqual({ stray: [], unlisted: [], staleOutside: [] });
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

  it("keeps another workspace's owner out of every object that can be named by id, and leaves it unchanged", async () => {
    const a = await owner();
    const b = await owner();
    const definition = { trigger: { type: "manual" }, steps: [{ id: "s", type: "delay", config: { seconds: 1 } }], edges: [] };
    const wf = (await a.agent.post("/workflows").send({ name: "Theirs", slug: "theirs" }).expect(201)).body.id as string;
    await a.agent.post(`/workflows/${wf}/versions`).send({ definition, publish: true }).expect(201);
    const version = (await pool.query<{ id: string }>("select id from workflow_versions where workflow_id = $1", [wf])).rows[0]!.id;
    const run = (await pool.query<{ id: string }>("insert into runs (workflow_version_id, trigger_payload) values ($1, '{}') returning id", [version])).rows[0]!.id;
    const resource = (await a.agent.post("/resources").send({ name: "Room A" }).expect(201)).body.id as string;
    const token = (await a.agent.post("/tokens").send({ name: "theirs", scopes: ["read"] }).expect(201)).body.id as string;
    await a.agent.put("/secrets/their_secret").send({ value: "kept" }).expect(204);
    const delivery = (await queueDelivery(db, { userId: a.id, runId: run, stepId: "s", provider: "slack", reference: "R-1", payload: { text: "hi" } })).id;
    const booking = (await pool.query<{ id: string }>("insert into bookings (user_id, test, reference, resource_id, during, timezone) values ($1, false, 'BK-1', $2, tstzrange(now() + interval '1 day', now() + interval '1 day 1 hour', '[)'), 'Asia/Manila') returning id", [a.id, resource])).rows[0]!.id;

    const none = randomUUID();
    const attempts: [string, string, number[], object?][] = [
      ["get", `/workflows/${wf}`, [404]],
      ["patch", `/workflows/${wf}`, [404], { name: "Taken" }],
      ["patch", `/workflows/${wf}/setup`, [404], { step: "fields", answers: defaultAnswers("office@test.local") }],
      ["post", `/workflows/${wf}/webhook-url`, [404], {}],
      ["get", `/workflows/${wf}/requests`, [404]],
      ["post", `/workflows/${wf}/pause`, [404]],
      ["post", `/workflows/${wf}/resume`, [404]],
      ["get", `/workflows/${wf}/versions`, [404]],
      ["get", `/workflows/${wf}/versions/1`, [404]],
      ["post", `/workflows/${wf}/versions`, [404], { definition, publish: true }],
      ["post", `/workflows/${wf}/test-runs`, [404], { definition }],
      ["post", `/workflows/${wf}/runs`, [404], {}],
      ["get", `/workflows/${wf}/email-source`, [404]],
      ["put", `/workflows/${wf}/email-source`, [400, 404], {}],
      ["post", `/workflows/${wf}/email-source/check`, [404], {}],
      ["delete", `/workflows/${wf}/email-source`, [404]],
      ["get", `/runs/${run}`, [404]],
      ["get", `/runs/${run}/explanation`, [404]],
      ["post", `/runs/${run}/explanation/reword`, [404], {}],
      ["get", `/runs/${run}/files/${none}`, [404]],
      ["post", `/runs/${run}/resolve`, [404], { action: "stop" }],
      ["post", `/runs/${run}/cancel`, [404], {}],
      ["post", `/runs/${run}/retry`, [404], {}],
      ["patch", `/resources/${resource}`, [404], { active: false }],
      ["delete", `/tokens/${token}`, [404]],
      ["post", `/deliveries/${delivery}/retry`, [404], {}],
      ["post", `/deliveries/${delivery}/confirm`, [404]],
      ["post", `/bookings/${booking}/cancel`, [404], { version: 1 }],
      ["post", `/bookings/${booking}/no-show`, [404], { version: 1 }],
      ["post", `/bookings/${booking}/undo-no-show`, [404], { version: 1 }],
      ["post", `/bookings/${booking}/reschedule`, [404], { version: 1, start: "2030-01-01T09:00", timezone: "Asia/Manila" }],
      // Secrets are named, not numbered: another workspace deleting the same name touches only its own (none).
      ["delete", `/secrets/their_secret`, [204, 404]],
      ["delete", `/workflows/${wf}`, [404]],
    ];
    const wrong: string[] = [];
    for (const [method, path, expected, body] of attempts) {
      const req = (b.agent as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
      const res = await (body ? req.send(body) : req);
      if (!expected.includes(res.status)) wrong.push(`${method} ${path} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);

    // Their lists show nothing of ours.
    expect((await b.agent.get("/runs").expect(200)).body).toEqual([]);
    expect((await b.agent.get(`/runs?workflowId=${wf}`).expect(200)).body).toEqual([]);
    expect((await b.agent.get(`/deliveries?runId=${run}`).expect(200)).body).toEqual([]);
    expect((await b.agent.get("/bookings").expect(200)).body).toEqual([]);
    expect((await b.agent.get("/resources").expect(200)).body).toEqual([]);
    expect((await b.agent.get("/tokens").expect(200)).body).toEqual([]);
    expect((await b.agent.get("/secrets").expect(200)).body).toEqual([]);
    expect((await b.agent.get(`/runs/export.csv?workflowId=${wf}`)).text ?? "").not.toContain("Theirs");

    // And nothing of ours changed.
    const mine = (await a.agent.get(`/workflows/${wf}`).expect(200)).body;
    expect(mine).toMatchObject({ name: "Theirs", pausedAt: null });
    expect((await pool.query("select state from runs where id = $1", [run])).rows[0]).toEqual({ state: "pending" });
    expect((await pool.query("select state from deliveries where id = $1", [delivery])).rows[0]).toEqual({ state: "queued" });
    expect((await pool.query("select status, version from bookings where id = $1", [booking])).rows[0]).toEqual({ status: "active", version: 1 });
    expect((await pool.query("select active from resources where id = $1", [resource])).rows[0]).toEqual({ active: true });
    expect(((await a.agent.get("/tokens").expect(200)).body as { id: string; revokedAt: string | null }[]).map((t) => [t.id, t.revokedAt])).toEqual([[token, null]]);
    expect(((await a.agent.get("/secrets").expect(200)).body as { name: string }[]).map((x) => x.name)).toEqual(["their_secret"]);
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
    await rosa.agent.post(`/forms/${formId}`).set("Origin", "https://daloy.example.com").type("form").send({ ...submission, submission_key: randomUUID() }).expect(200);
    // Signed out, and signed in to another workspace: recorded without a requester.
    await request(server).post(`/forms/${formId}`).type("form").send({ ...submission, submission_key: randomUUID() }).expect(200);
    await stranger.agent.post(`/forms/${formId}`).set("Origin", "https://daloy.example.com").type("form").send({ ...submission, submission_key: randomUUID() }).expect(200);

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
