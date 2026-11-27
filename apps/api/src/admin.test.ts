import { randomBytes, randomUUID } from "node:crypto";
import { adminActions, claimUsage, deliveries, joinWorkspace, mailDeps, manilaDay, runs, sessions, stepRuns, users, usageSummary, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { isPlatformAdmin } from "./admin";
import { createApp } from "./app";
import { sha256 } from "./http";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
const mail: MailDeps = { ...mailDeps({}), sharedMail: "approved" };
type Agent = ReturnType<typeof request.agent>;

const PASSWORD = "correct horse battery";
const ADMIN = "boss@daloy.test";

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  // Mixed case and spaces on purpose: the allowlist is matched trimmed and lowercased.
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, mail, platformAdmins: ` Boss@Daloy.Test , ops@daloy.test` });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

let seq = 0;
async function signUp(email = `owner${++seq}@test.local`) {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email, password: PASSWORD }).expect(201);
  return { agent, id: res.body.id as string, email };
}

/** Seeds an operator account directly in DB (as required before adding an email to PLATFORM_ADMINS, S2) and signs in. */
async function seedAdmin(email: string) {
  const normalized = email.trim().toLowerCase();
  const [u] = await db.insert(users).values({ email: normalized, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, u!.id, "owner");
  const agent = request.agent(server);
  await agent.post("/auth/login").send({ email: normalized, password: PASSWORD }).expect(200);
  return { agent, id: u!.id, email: normalized };
}

/** A member added straight in the database with a live session. */
async function member(workspaceId: string, role: "operator" | "approver" | "requester") {
  const [u] = await db.insert(users).values({ email: `member${++seq}@test.local`, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return { agent: request.agent(server).set("Cookie", `daloy_session=${token}`), id: u!.id };
}

const SECRET_PAYLOAD = "maria.santos@example.com 0917 555 0101";
const SECRET_ERROR = "refused because Maria Santos owes 5000";

/** A workflow with one run in `state`, a step and a delivery, carrying customer data the admin views must never show. */
async function seedRun(userId: string, state: "succeeded" | "failed" | "needs_review", name = "Order follow-up") {
  const [wf] = await db.insert(workflows).values({ userId, name, slug: `wf-${++seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: { trigger: { type: "manual", config: {} }, steps: [], edges: [] } }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, state, triggerPayload: { email: SECRET_PAYLOAD }, error: state === "succeeded" ? null : SECRET_ERROR, finishedAt: new Date() }).returning();
  await db.insert(stepRuns).values({ runId: r!.id, stepId: "a", attempt: 1, state: state === "succeeded" ? "succeeded" : "failed", input: { to: SECRET_PAYLOAD }, output: { body: SECRET_PAYLOAD } });
  await db.insert(deliveries).values({ userId, runId: r!.id, stepId: "a", provider: "slack", reference: `ref-${++seq}`, payload: { text: SECRET_PAYLOAD }, state: state === "succeeded" ? "delivered" : state, lastError: SECRET_ERROR });
  return r!.id;
}

describe("isPlatformAdmin", () => {
  it("matches trimmed, lowercased entries and is off when the list is empty", () => {
    expect(isPlatformAdmin(" A@X.test ,b@x.test", "a@x.test")).toBe(true);
    expect(isPlatformAdmin(" A@X.test ,b@x.test", "B@X.TEST")).toBe(true);
    expect(isPlatformAdmin("a@x.test", "c@x.test")).toBe(false);
    expect(isPlatformAdmin("", "a@x.test")).toBe(false);
    expect(isPlatformAdmin(undefined, "a@x.test")).toBe(false);
    // An empty entry from a stray comma never matches an empty email.
    expect(isPlatformAdmin("a@x.test,,", "")).toBe(false);
  });
});

describe("the admin gate", () => {
  let admin: Agent;
  let normal: Agent;
  let operator: Agent;
  let normalId: string;

  beforeAll(async () => {
    admin = (await seedAdmin(ADMIN)).agent;
    const n = await signUp();
    normal = n.agent;
    normalId = n.id;
    operator = (await member(normalId, "operator")).agent;
  });

  it("lets an allowlisted account in", async () => {
    await admin.get("/admin/overview").expect(200);
    await admin.get("/admin/runs").expect(200);
  });

  it("answers 404 to everyone else on every admin route, so the routes look absent", async () => {
    const stack = (app.getHttpAdapter().getInstance() as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }).router.stack;
    const adminRoutes = stack.flatMap((l) => (l.route?.path.startsWith("/admin") ? Object.keys(l.route.methods).map((m) => [m, l.route!.path.replace(":id", normalId)] as const) : []));
    expect(adminRoutes.length).toBeGreaterThanOrEqual(4);
    const wrong: string[] = [];
    for (const [method, path] of adminRoutes) {
      for (const [who, agent] of [["owner", normal], ["operator", operator], ["signed out", request.agent(server)]] as const) {
        const res = await (agent as unknown as Record<string, (p: string) => request.Test>)[method]!(path).send({ plan: "business_plus", dailyLimit: 9999 });
        if (res.status !== 404) wrong.push(`${who} ${method} ${path} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
    // Nothing changed through the refused calls.
    const [row] = await db.select({ plan: users.plan, limit: users.sharedMailDailyLimit }).from(users).where(eq(users.id, normalId));
    expect(row).toEqual({ plan: null, limit: null });
  });

  it("answers 404 to an expired session of an allowlisted account", async () => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, ADMIN));
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() - 1000) });
    await request(server).get("/admin/overview").set("Cookie", `daloy_session=${token}`).expect(404);
  });

  it("refuses a change sent from another site, even for an admin", async () => {
    await admin.put(`/admin/workspaces/${normalId}/plan`).set("Origin", "https://evil.example").send({ plan: "pilot" }).expect(403);
  });

  it("blocks public sign-up and invite acceptance from claiming an unregistered PLATFORM_ADMINS email (S2)", async () => {
    for (const candidate of ["ops@daloy.test", "OPS@DALOY.TEST"]) {
      const attacker = request.agent(server);
      const res = await attacker.post("/auth/register").send({ email: candidate, password: PASSWORD }).expect(409);
      expect(res.body.message).toBe("email already registered");
      expect(res.headers["set-cookie"]).toBeUndefined();
      await attacker.get("/admin/overview").expect(404);
    }
    const [claimed] = await db.select({ id: users.id }).from(users).where(eq(users.email, "ops@daloy.test"));
    expect(claimed).toBeUndefined();

    // Creating an invite for an unregistered PLATFORM_ADMINS email and accepting it also fails without creating the user.
    const inviteRes = await normal.post("/workspace/invites").send({ email: "ops@daloy.test", role: "operator" }).expect(201);
    const token = new URL(inviteRes.body.link as string).hash.split("/").pop()!;
    const invitedAgent = request.agent(server);
    await invitedAgent.post(`/auth/invites/${token}/accept`).send({ password: PASSWORD }).expect(401);
    await invitedAgent.get("/admin/overview").expect(404);
    const [afterInvite] = await db.select({ id: users.id }).from(users).where(eq(users.email, "ops@daloy.test"));
    expect(afterInvite).toBeUndefined();
  });
});

describe("cross-tenant overview", () => {
  let admin: Agent;
  let a: { id: string; email: string };
  let b: { id: string; email: string };

  beforeAll(async () => {
    admin = (await seedAdmin("ops@daloy.test")).agent;
    a = await signUp();
    b = await signUp();
    await member(a.id, "operator");
    await seedRun(a.id, "succeeded");
    await seedRun(a.id, "failed");
    await seedRun(b.id, "needs_review");
    await db.update(users).set({ plan: "pilot" }).where(eq(users.id, b.id));
    await claimUsage(db, a.id, "ai", { n: 3 });
    await claimUsage(db, b.id, "ai", { n: 4 });
    await claimUsage(db, b.id, "sms", { n: 2 });
  });

  it("counts users, workspaces, runs and usage across every workspace", async () => {
    const body = (await admin.get("/admin/overview").expect(200)).body;
    const [{ users: allUsers, owners }] = (await pool.query(`select count(*)::int as users, count(*) filter (where role = 'owner')::int as owners from workspace_members`)).rows as [{ users: number; owners: number }];
    expect(body.users).toMatchObject({ total: allUsers, new7: allUsers, new30: allUsers });
    expect(body.workspaces).toMatchObject({ total: owners, new7: owners, new30: owners });
    expect(body.runs30).toMatchObject({ succeeded: 1, failed: 1, needs_review: 1 });
    expect(body.attention).toEqual({ runsFailed: 1, runsNeedsReview: 1, deliveriesFailed: 1, deliveriesNeedsReview: 1 });
    expect(body.usage).toEqual({ ai: 7, sms: 2 });

    const rowA = body.workspaces.rows.find((r: { id: string }) => r.id === a.id);
    const rowB = body.workspaces.rows.find((r: { id: string }) => r.id === b.id);
    expect(rowA).toMatchObject({ email: a.email, plan: null, members: 2, runs30: 2, failed: 1, needsReview: 0, ai: 3, sms: 0, sharedMailDailyLimit: null });
    expect(rowB).toMatchObject({ email: b.email, plan: "pilot", members: 1, runs30: 1, failed: 0, needsReview: 1, ai: 4, sms: 2 });
    // Members are not workspaces.
    expect(body.workspaces.rows).toHaveLength(owners);
  });

  it("shows run metadata and never the payload, step data or error text", async () => {
    const all = (await admin.get("/admin/runs").expect(200)).body;
    expect(all.length).toBeGreaterThanOrEqual(3);
    const failed = (await admin.get("/admin/runs?state=failed").expect(200)).body;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({
      id: expect.any(String), workspaceId: a.id, email: a.email, workflow: "Order follow-up", version: 1, state: "failed", test: false, live: false,
      createdAt: expect.any(String), finishedAt: expect.any(String), hasError: true, steps: { failed: 1 },
    });
    const overview = JSON.stringify((await admin.get("/admin/overview").expect(200)).body);
    for (const text of [JSON.stringify(all), overview]) {
      expect(text).not.toContain("maria");
      expect(text).not.toContain("Maria");
    }
    await admin.get("/admin/runs?state=nope").expect(400);
    await admin.get("/admin/runs?limit=101").expect(400);
    expect((await admin.get("/admin/runs?limit=1").expect(200)).body).toHaveLength(1);
  });
});

describe("plan override and shared mail approval", () => {
  let admin: Agent;
  let owner: { agent: Agent; id: string };

  beforeAll(async () => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, ADMIN));
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    admin = request.agent(server).set("Cookie", `daloy_session=${token}`);
    owner = await signUp();
  });

  it("sets the plan, moves the cycle anchor and records who did it", async () => {
    const res = await admin.put(`/admin/workspaces/${owner.id}/plan`).send({ plan: "business", startedOn: "2026-11-03" }).expect(200);
    expect(res.body).toMatchObject({ plan: "business", planStartedOn: "2026-11-03" });
    const summary = await usageSummary(db, owner.id, new Date("2026-11-20T00:00:00Z"));
    expect(summary).toMatchObject({ plan: "business", ai: { limit: 500, resetsOn: "2026-12-03" } });
    const [log] = await db.select().from(adminActions).where(eq(adminActions.workspaceId, owner.id));
    expect(log).toMatchObject({ adminEmail: ADMIN, action: "plan", before: { plan: null, planStartedOn: null }, after: { plan: "business", planStartedOn: "2026-11-03" } });
  });

  it("starts the new plan today when no date is given, and removes it with null", async () => {
    await admin.put(`/admin/workspaces/${owner.id}/plan`).send({ plan: "pilot" }).expect(200);
    expect((await owner.agent.get("/usage").expect(200)).body).toMatchObject({ plan: "pilot" });
    const [row] = await db.select({ startedOn: users.planStartedOn }).from(users).where(eq(users.id, owner.id));
    expect(row!.startedOn).toBe(manilaDay());
    await admin.put(`/admin/workspaces/${owner.id}/plan`).send({ plan: null }).expect(200);
    const [cleared] = await db.select({ plan: users.plan, startedOn: users.planStartedOn }).from(users).where(eq(users.id, owner.id));
    expect(cleared).toEqual({ plan: null, startedOn: null });
  });

  it("approves and withdraws the shared mail server for a workspace", async () => {
    expect((await owner.agent.get("/settings/email").expect(200)).body).toMatchObject({ installationAllowed: false });
    await admin.put(`/admin/workspaces/${owner.id}/shared-mail`).send({ dailyLimit: 50 }).expect(200);
    expect((await owner.agent.get("/settings/email").expect(200)).body).toMatchObject({ installationAllowed: true });
    await admin.put(`/admin/workspaces/${owner.id}/shared-mail`).send({ dailyLimit: null }).expect(200);
    expect((await owner.agent.get("/settings/email").expect(200)).body).toMatchObject({ installationAllowed: false });
    const log = await db.select().from(adminActions).where(eq(adminActions.action, "shared_mail"));
    expect(log.map((l) => [l.before, l.after])).toEqual([[{ sharedMailDailyLimit: null }, { sharedMailDailyLimit: 50 }], [{ sharedMailDailyLimit: 50 }, { sharedMailDailyLimit: null }]]);
    // The overview lists the latest actions first.
    const actions = (await admin.get("/admin/overview").expect(200)).body.actions;
    expect(actions[0]).toMatchObject({ adminEmail: ADMIN, action: "shared_mail", workspaceEmail: expect.any(String), after: { sharedMailDailyLimit: null } });
  });

  it("checks the body and the workspace id", async () => {
    await admin.put(`/admin/workspaces/${owner.id}/plan`).send({ plan: "gold" }).expect(400);
    await admin.put(`/admin/workspaces/${owner.id}/plan`).send({ plan: "pilot", startedOn: "soon" }).expect(400);
    await admin.put(`/admin/workspaces/${owner.id}/shared-mail`).send({ dailyLimit: 0 }).expect(400);
    await admin.put(`/admin/workspaces/${owner.id}/shared-mail`).send({ dailyLimit: 10_001 }).expect(400);
    await admin.put(`/admin/workspaces/${owner.id}/shared-mail`).send({ dailyLimit: 2.5 }).expect(400);
    await admin.put(`/admin/workspaces/not-a-uuid/plan`).send({ plan: "pilot" }).expect(400);
    await admin.put(`/admin/workspaces/${randomUUID()}/plan`).send({ plan: "pilot" }).expect(404);
    // A member's own user id is not a workspace.
    const m = await member(owner.id, "operator");
    await admin.put(`/admin/workspaces/${m.id}/shared-mail`).send({ dailyLimit: 5 }).expect(404);
    const [row] = await db.select({ limit: users.sharedMailDailyLimit }).from(users).where(eq(users.id, m.id));
    expect(row!.limit).toBeNull();
  });
});

describe("shared AI model", () => {
  let admin: Agent;
  let owner: { agent: Agent; id: string; email: string };
  const KEY = "AIza-platform-secret-9876";

  beforeAll(async () => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, ADMIN));
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    admin = request.agent(server).set("Cookie", `daloy_session=${token}`);
    owner = await signUp();
    await pool.query("delete from platform_ai");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the env default before anything is saved, without a key", async () => {
    const { body } = await admin.get("/admin/ai").expect(200);
    expect(body.current).toMatchObject({ source: "env", thinking: "off" });
    expect(body.presets.gemini).toMatchObject({ needsKey: true });
    expect(JSON.stringify(body)).not.toMatch(/apiKey|secret/i);
  });

  it("saves the shared model, keeps the key when none is sent, and never returns it", async () => {
    await admin.put("/admin/ai").send({ preset: "gemini", model: "gemini-3.8-flash", apiKey: KEY, thinking: "low" }).expect(200);
    const saved = (await admin.get("/admin/ai").expect(200)).body;
    expect(saved.current).toMatchObject({ source: "platform", preset: "gemini", model: "gemini-3.8-flash", thinking: "low", hasKey: true, keyLast4: "9876" });
    await admin.put("/admin/ai").send({ preset: "gemini", model: "gemini-3.6-flash" }).expect(200);
    const kept = (await admin.get("/admin/ai").expect(200)).body;
    expect(kept.current).toMatchObject({ model: "gemini-3.6-flash", thinking: "low", hasKey: true, keyLast4: "9876" });
    expect(JSON.stringify([saved, kept])).not.toContain(KEY);
    // Bad input is refused at the boundary, and a hosted provider with no key is a 400.
    await admin.put("/admin/ai").send({ preset: "nope", model: "x" }).expect(400);
    await admin.put("/admin/ai").send({ preset: "gemini", model: "" }).expect(400);
    await admin.put("/admin/ai").send({ preset: "gemini", model: "x", thinking: "max" }).expect(400);
    await admin.put("/admin/ai").send({ preset: "openai", model: "gpt-x" }).expect(400);
  });

  it("writes one audit row per save, never with the key", async () => {
    const log = await db.select().from(adminActions).where(eq(adminActions.action, "ai"));
    expect(log).toHaveLength(2);
    expect(log.every((l) => l.adminEmail === ADMIN && l.workspaceId === null)).toBe(true);
    expect(JSON.stringify(log)).not.toContain("secret");
    expect(log.map((l) => (l.after as { keyChanged: boolean }).keyChanged).sort()).toEqual([false, true]);
  });

  it("sets and clears a workspace's thinking override, and audits it", async () => {
    const res = await admin.put(`/admin/workspaces/${owner.id}/ai-thinking`).send({ level: "high" }).expect(200);
    expect(res.body).toEqual({ aiThinking: "high" });
    // The admin console's AI tab shows the override from the overview rows (A3).
    const rows = (await admin.get("/admin/overview").expect(200)).body.workspaces.rows as { id: string; aiThinking: string | null }[];
    expect(rows.find((r) => r.id === owner.id)?.aiThinking).toBe("high");
    await admin.put(`/admin/workspaces/${owner.id}/ai-thinking`).send({ level: null }).expect(200);
    const [row] = await db.select({ t: users.aiThinking }).from(users).where(eq(users.id, owner.id));
    expect(row!.t).toBeNull();
    const log = await db.select().from(adminActions).where(eq(adminActions.action, "ai_thinking"));
    expect(log.map((l) => [l.workspaceId, l.adminEmail, l.before, l.after])).toEqual([
      [owner.id, ADMIN, { aiThinking: null }, { aiThinking: "high" }],
      [owner.id, ADMIN, { aiThinking: "high" }, { aiThinking: null }],
    ]);
    await admin.put(`/admin/workspaces/${owner.id}/ai-thinking`).send({ level: "max" }).expect(400);
    await admin.put(`/admin/workspaces/${randomUUID()}/ai-thinking`).send({ level: "low" }).expect(404);
  });

  it("runs the sample classify call on the shared model with a stubbed provider, and is rate limited", async () => {
    vi.stubEnv("SHARED_LLM_KEY", "open");
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"billing"}' } }], usage: { prompt_tokens: 30, completion_tokens: 4 } }));
    });
    const { body } = await admin.post("/admin/ai/test").expect(200);
    expect(body).toMatchObject({ ok: true, model: "gemini-3.6-flash", label: "billing" });
    expect(seen[0]!.url).toContain("generativelanguage.googleapis.com");
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(body)).not.toContain(KEY);
    // A provider refusal comes back as a plain reason, not as a server error.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    expect((await admin.post("/admin/ai/test").expect(200)).body).toMatchObject({ ok: false, error: "The provider rejected the API key." });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await admin.post("/admin/ai/test")).status);
    expect(statuses).toContain(429);
    vi.unstubAllEnvs();
  });

  it("gives a workspace on a plan the shared model through its own AI test", async () => {
    // The shared model now applies where the env vars did: a plan-less workspace's test goes to the shared provider without the key.
    vi.stubEnv("SHARED_LLM_KEY", "open");
    const seen: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"billing"}' } }] }));
    });
    await owner.agent.post("/settings/ai/test").expect(200);
    expect(seen[0]).toBeNull();
    await admin.put(`/admin/workspaces/${owner.id}/plan`).send({ plan: "pilot" }).expect(200);
    await owner.agent.post("/settings/ai/test").expect(200);
    expect(seen[1]).toBe(`Bearer ${KEY}`);
    vi.unstubAllEnvs();
  });
});
