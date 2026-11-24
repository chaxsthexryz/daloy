import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connectionCredential, connections, deliveries, joinWorkspace, OAUTH_PROVIDERS, oauthFlows, queueDelivery, readTokenBlob, requests, runDueDeliveries, runs, sessions, startFlow, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { fakeOAuthProvider } from "../../../test/oauth-provider";
import { createApp } from "./app";
import { sha256 } from "./http";

// Decision 0058: the routes of the shared OAuth core, against the generic fake app (as "trello") and the Microsoft fake.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let llm: Server;
const wires: string[] = [];
const secretsKey = randomBytes(32);
let seq = 0;
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  const microsoft = { clientId: fake.microsoft.clientId, clientSecret: fake.microsoft.clientSecret, tenant: "organizations" };
  // notion: a provider definition whose client is not configured on this installation.
  const unconfigured = { ...fakeOAuthProvider(fake, { provider: "notion", slug: "notion" }), client: () => undefined };
  // trello and notion have real definitions now (decision 0062); the generic fake stands in for them here.
  const oauthProviders = [...OAUTH_PROVIDERS.filter((d) => d.provider !== "trello" && d.provider !== "notion"), fakeOAuthProvider(fake), unconfigured];
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000", providers: { ...fake.urls, timeoutMs: 2000, microsoft }, oauthProviders, ask: true });
  await app.init();
  server = app.getHttpServer();
  // A fake Ollama that records what kymavo sends it, for the Ask prompt check.
  llm = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      wires.push(raw);
      res.end(JSON.stringify({ message: { content: "Look in Activity." }, prompt_eval_count: 1, eval_count: 1 }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${(llm.address() as AddressInfo).port}`);
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  llm?.close();
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

beforeEach(() => {
  Object.assign(fake.oauth.test!, { consent: "grant", revokeStatus: 200, rotation: "strict", expiresIn: 3600 });
  fake.oauth.test!.user = { id: "test-user-1", email: "ana@test.example" };
  fake.microsoft.consent = "grant";
});

async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `oauth${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}
async function member(workspaceId: string, role: "operator" | "approver" | "requester") {
  const [u] = await db.insert(users).values({ email: `${role}${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return { agent: request.agent(server).set("Cookie", `daloy_session=${token}`), id: u!.id };
}
/** kymavo's start, then the provider's consent page; returns the callback path the provider sends the browser to. */
async function consentBack(agent: Agent, slug = "trello") {
  const { body } = await agent.post(`/settings/connections/${slug}/oauth/start`).expect(200);
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  return back.pathname + back.search;
}
const land = async (agent: Agent | ReturnType<typeof request>, path: string) => (await agent.get(path).expect(302)).headers.location as string;
const rows = (ws: string) => db.select().from(connections).where(eq(connections.userId, ws));

describe("connect", () => {
  it("connects through the shared callback, which answers no-store and no-referrer, and lists the configured providers", async () => {
    const { agent, id } = await owner();
    expect((await agent.get("/settings/connections").expect(200)).body.oauth).toEqual(["outlook", "trello"]);
    const path = await consentBack(agent);
    expect(path.startsWith("/settings/connections/oauth/callback?")).toBe(true);
    const res = await agent.get(path).expect(302);
    expect(res.headers.location).toBe("/#/apps/trello-connected");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(await rows(id)).toEqual([expect.objectContaining({ provider: "trello", authMethod: "oauth", account: "ana@test.example", externalId: "test-user-1", status: "active" })]);
    const listed = await agent.get("/settings/connections").expect(200);
    expect(JSON.stringify(listed.body)).not.toMatch(/test-(access|refresh)-/);
  });

  it("lands a refusal, an administrator requirement, a narrower grant and a failed exchange on fixed outcomes, saving nothing", async () => {
    const { agent, id } = await owner();
    fake.oauth.test!.consent = "declined";
    expect(await land(agent, await consentBack(agent))).toBe("/#/apps/trello-declined");
    fake.oauth.test!.consent = "admin_required";
    expect(await land(agent, await consentBack(agent))).toBe("/#/apps/trello-admin_required");
    Object.assign(fake.oauth.test!, { consent: "narrow", grantScopes: ["read", "offline_access"] });
    expect(await land(agent, await consentBack(agent))).toBe("/#/apps/trello-missing_scope");
    fake.oauth.test!.consent = "grant";
    const path = await consentBack(agent);
    fake.once("/oauth/test/token", { status: 503, body: { error: "temporarily_unavailable" } });
    expect(await land(agent, path)).toBe("/#/apps/trello-failed");
    expect(await rows(id)).toEqual([]);
  });

  it("starts only providers this installation has a client for", async () => {
    const { agent } = await owner();
    await agent.post("/settings/connections/notion/oauth/start").expect(400);
    await agent.post("/settings/connections/nothing/oauth/start").expect(404);
    await agent.post("/settings/connections/Bad_Slug/oauth/start").expect(400);
  });
});

describe("state", () => {
  it("is used once: a replayed callback changes nothing and swaps no second code", async () => {
    const { agent, id } = await owner();
    const path = await consentBack(agent);
    expect(await land(agent, path)).toBe("/#/apps/trello-connected");
    const before = (await rows(id))[0]!.credentialIv;
    const calls = fake.oauth.test!.tokenCalls;
    expect(await land(agent, path)).toBe("/#/apps/oauth-expired");
    expect(fake.oauth.test!.tokenCalls).toBe(calls);
    expect((await rows(id))[0]!.credentialIv).toBe(before);
  });

  it("works only for the owner who started it: another owner, a member of the same office or nobody gets expired, and the flow stays usable", async () => {
    const ana = await owner();
    const ben = await owner();
    const op = await member(ana.id, "operator");
    const path = await consentBack(ana.agent);
    expect(await land(ben.agent, path)).toBe("/#/apps/oauth-expired");
    expect(await land(op.agent, path)).toBe("/#/apps/oauth-expired");
    expect(await land(request(server), path)).toBe("/#/apps/oauth-expired");
    expect(await rows(ben.id)).toEqual([]);
    expect(await land(ana.agent, path)).toBe("/#/apps/trello-connected");
  });

  it("checks the managing role again at the callback", async () => {
    const ana = await owner();
    const op = await member(ana.id, "operator");
    // A flow that names the operator, as if they had been an owner when it started.
    const url = new URL(await startFlow(db, secretsKey, { ...fake.urls }, "http://localhost:3000", fakeOAuthProvider(fake), { workspaceId: ana.id, memberId: op.id }));
    const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
    expect(await land(op.agent, back.pathname + back.search)).toBe("/#/apps/oauth-expired");
    expect(await rows(ana.id)).toEqual([]);
    expect((await db.select().from(oauthFlows).where(eq(oauthFlows.memberId, op.id)))[0]!.consumedAt).toBeNull();
  });

  it("refuses a code moved into another flow, because its PKCE verifier does not match", async () => {
    const { agent, id } = await owner();
    const a = new URL(await consentBack(agent), "http://x");
    const b = new URL(await consentBack(agent), "http://x");
    b.searchParams.set("code", a.searchParams.get("code")!);
    expect(await land(agent, b.pathname + b.search)).toBe("/#/apps/trello-failed");
    expect(await rows(id)).toEqual([]);
  });

  it("never lets a parameter choose where the browser goes", async () => {
    const { agent } = await owner();
    const path = await consentBack(agent);
    const evil = `${path}&redirect=https://evil.example&next=//evil.example&return_to=https%3A%2F%2Fevil.example`;
    expect(await land(agent, evil)).toBe("/#/apps/trello-connected");
    expect(await land(agent, "/settings/connections/oauth/callback?redirect=https://evil.example&state=x")).toBe("/#/apps/oauth-expired");
  });
});

describe("disconnect", () => {
  it("revokes at the provider after deleting, says when the revoke failed, and answers 204 when there is nothing to revoke", async () => {
    const { agent, id } = await owner();
    await land(agent, await consentBack(agent));
    expect((await agent.delete("/settings/connections/trello").expect(200)).body).toEqual({ revoked: true });
    expect(fake.oauth.test!.revoked.at(-1)).toMatch(/^test-refresh-/);
    await land(agent, await consentBack(agent));
    fake.oauth.test!.revokeStatus = 500;
    expect((await agent.delete("/settings/connections/trello").expect(200)).body).toEqual({ revoked: false });
    expect(await rows(id)).toEqual([]);
    await agent.delete("/settings/connections/trello").expect(404);
    await agent.put("/settings/connections/teams").send({ url: fake.teamsUrl("flow-purchasing"), channelName: "Purchasing" }).expect(200);
    await agent.delete("/settings/connections/teams").expect(204);
  });
});

describe("isolation", () => {
  it("keeps two offices on the same provider account apart", async () => {
    // An account no other test connects, so the shared list below sees only these two offices.
    fake.oauth.test!.user = { id: "isolation-user", email: "iso@test.example" };
    const a = await owner();
    const b = await owner();
    await land(a.agent, await consentBack(a.agent));
    await land(b.agent, await consentBack(b.agent));
    const [ta, tb] = [await connectionCredential(db, secretsKey, a.id, "trello"), await connectionCredential(db, secretsKey, b.id, "trello")];
    expect(readTokenBlob(ta!.credential).refreshToken).not.toBe(readTokenBlob(tb!.credential).refreshToken);
    // Plan R14: each office is told the account is connected elsewhere too, without saying where.
    expect((await a.agent.get("/settings/connections").expect(200)).body.shared).toEqual(["trello"]);
    await b.agent.delete("/settings/connections/trello").expect(200);
    expect(await rows(a.id)).toHaveLength(1);
    const after = (await a.agent.get("/settings/connections").expect(200)).body;
    expect(after.connections).toEqual([expect.objectContaining({ provider: "trello", status: "active" })]);
    expect(after.shared).toEqual([]);
  });
});

describe("role permissions", () => {
  it("lets only owners start and disconnect, and sends everyone else at the callback to expired", async () => {
    const o = await owner();
    const agents: Record<string, Agent | ReturnType<typeof request>> = { owner: o.agent, signedOut: request(server) };
    for (const role of ["operator", "approver", "requester"] as const) agents[role] = (await member(o.id, role)).agent;
    const status: Record<string, number[]> = {};
    for (const [role, agent] of Object.entries(agents)) {
      status[role] = [
        (await (agent as Agent).post("/settings/connections/trello/oauth/start")).status,
        (await (agent as Agent).post("/settings/connections/outlook/start")).status,
        (await (agent as Agent).delete("/settings/connections/trello")).status,
      ];
    }
    expect(status).toEqual({ owner: [200, 200, 404], operator: [403, 403, 403], approver: [403, 403, 403], requester: [403, 403, 403], signedOut: [401, 401, 401] });
    const path = await consentBack(o.agent);
    for (const role of ["operator", "approver", "requester", "signedOut"]) expect(await land(agents[role]!, path)).toBe("/#/apps/oauth-expired");
  });
});

describe("tokens never leak (R3, R4)", () => {
  const TOKEN = /(test|ms)-(access|refresh)-\d+|test-code-\d+/;

  it("keeps codes, states and tokens out of logs, errors and redirects", async () => {
    const logged: string[] = [];
    const record = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    const spies = [vi.spyOn(console, "log").mockImplementation(record), vi.spyOn(console, "error").mockImplementation(record), vi.spyOn(console, "warn").mockImplementation(record)];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((c) => (record(c), true));
    const err = vi.spyOn(process.stderr, "write").mockImplementation((c) => (record(c), true));
    try {
      const { agent } = await owner();
      const seen: string[] = [];
      const path = await consentBack(agent);
      const state = new URL(path, "http://x").searchParams.get("state")!;
      const code = new URL(path, "http://x").searchParams.get("code")!;
      // A provider that echoes the code back in its error.
      fake.once("/oauth/test/token", { status: 400, body: { error: "invalid_grant", error_description: `code ${code} was refused` } });
      seen.push(await land(agent, path));
      seen.push(await land(agent, await consentBack(agent)));
      seen.push(JSON.stringify((await agent.get("/settings/connections").expect(200)).body));
      seen.push(JSON.stringify((await agent.post("/settings/connections/outlook/test")).body));
      const all = [...logged, ...seen].join("\n");
      expect(all).not.toMatch(TOKEN);
      expect(all).not.toContain(state);
      expect(all).not.toContain(code);
    } finally {
      for (const s of [...spies, out, err]) s.mockRestore();
    }
  });

  it("hides an active connection's tokens in run history, Activity, CSV, the delivery list and the explain and Ask prompts", async () => {
    const { agent, id } = await owner();
    // Outlook through Microsoft consent, so there is a live access and refresh token to leak.
    const { body } = await agent.post("/settings/connections/outlook/start").expect(200);
    const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
    await land(agent, back.pathname + back.search);
    const blob = readTokenBlob((await connectionCredential(db, secretsKey, id, "outlook"))!.credential);
    const [access, refresh] = [blob.accessToken, blob.refreshToken!];

    // Run text that somehow holds both tokens, under keys the key-name mask would not catch.
    const reference = `REQ-OA${++seq}Z`;
    const [wf] = await db.insert(workflows).values({ userId: id, name: "Purchases", slug: `p-${seq}` }).returning();
    const definition = { trigger: { type: "manual", config: {} }, steps: [{ id: "tell", type: "outlook", config: {} }], edges: [] };
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "failed", triggerPayload: { note: `see ${refresh}` }, error: `failed with ${access}` }).returning();
    await db.insert(stepRuns).values({ runId: r!.id, stepId: "tell", attempt: 1, state: "failed", error: `refused ${access}`, input: { note: refresh }, output: { note: access }, outcome: "rejected" });
    await db.insert(requests).values({ userId: id, workflowId: wf!.id, runId: r!.id, reference, submissionKey: randomUUID(), subject: "Chair" });
    // A provider error that echoes the token, stored as the delivery's last error.
    await queueDelivery(db, { userId: id, runId: r!.id, stepId: "tell", provider: "outlook", reference, payload: { to: "buyer@contoso.example", subject: "Chair", text: "Buy" } });
    fake.once("/me/sendMail", { status: 400, body: { error: { code: "ErrorInvalidRecipients", message: `token ${access} is not allowed here` } } });
    await runDueDeliveries(db, secretsKey, { ...fake.urls, timeoutMs: 2000, microsoft: { clientId: fake.microsoft.clientId, clientSecret: fake.microsoft.clientSecret, tenant: "organizations" } });
    const [stored] = await db.select({ lastError: deliveries.lastError }).from(deliveries).where(eq(deliveries.runId, r!.id));
    expect(stored!.lastError).toContain(access); // stored as the provider said it; hidden on every way out

    wires.length = 0;
    const out = [
      (await agent.get("/runs").expect(200)).text,
      (await agent.get(`/runs/${r!.id}`).expect(200)).text,
      (await agent.get(`/runs/export.csv?workflowId=${wf!.id}`).expect(200)).text,
      (await agent.get(`/deliveries?runId=${r!.id}`).expect(200)).text,
      (await agent.get(`/runs/${r!.id}/explanation`).expect(200)).text,
      (await agent.post("/runs/ask/reword").send({ reference, question: "why" }).expect(200)).text,
      ...wires,
    ];
    expect(wires.length).toBeGreaterThan(0);
    for (const text of out) {
      expect(text).not.toContain(access);
      expect(text).not.toContain(refresh);
    }
    expect(out[3]).toContain("[secret]");
    expect(out[0]).toContain("[secret]");
  });
});
