import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connectionCredential, connections, deliveries, joinWorkspace, keepOAuthAlive, oauthFlows, queueDelivery, readTokenBlob, requests, runDueDeliveries, runs, sessions, slack, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";
import { sha256 } from "./http";

// Decision 0061: "Connect Slack" on the shared OAuth core, against the fake Slack install (the "v2" app in test/fake-providers.ts).
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
let urls: Parameters<typeof runDueDeliveries>[2];

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  urls = { ...fake.urls, timeoutMs: 2000, slackClient: { clientId: fake.oauth.v2!.clientId, clientSecret: fake.oauth.v2!.clientSecret } };
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000", providers: urls, ask: true });
  await app.init();
  server = app.getHttpServer();
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
  Object.assign(fake.oauth.v2!, { consent: "grant", revokeStatus: 200 });
  fake.oauth.v2!.user = { id: "T0INSTALL1", email: "Acme Dental" };
  fake.slack.token = "xoxb-pasted-0000000000-abcdefabcdef";
  fake.slack.revoked = false;
  fake.slack.channels[0]!.is_member = true;
});

async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `slack${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}
async function member(workspaceId: string, role: "operator" | "approver" | "requester") {
  const [u] = await db.insert(users).values({ email: `${role}${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return { agent: request.agent(server).set("Cookie", `daloy_session=${token}`), id: u!.id };
}
/** kymavo's start, then Slack's consent page; returns the callback path Slack sends the browser to. */
async function consentBack(agent: Agent) {
  const { body } = await agent.post("/settings/connections/slack/oauth/start").expect(200);
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  return back.pathname + back.search;
}
const land = async (agent: Agent | ReturnType<typeof request>, path: string) => (await agent.get(path).expect(302)).headers.location as string;
const install = async (agent: Agent) => land(agent, await consentBack(agent));
const rows = (ws: string) => db.select().from(connections).where(eq(connections.userId, ws));
const team = (id: string, name: string) => (fake.oauth.v2!.user = { id, email: name });
const pick = (agent: Agent) => agent.put("/settings/connections/slack/channel").send({ channelId: "C0REQ" }).expect(204);
/** A run with a Slack step, and a delivery queued for it now (so it is pinned to the connection as it is). */
async function queueNote(workspaceId: string, text = "REQ-1 Aircon") {
  const [wf] = await db.insert(workflows).values({ userId: workspaceId, name: "Office", slug: `o-${++seq}` }).returning();
  const definition = { trigger: { type: "manual", config: {} }, steps: [{ id: "tell", type: "slack", config: {} }], edges: [] };
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "succeeded" }).returning();
  const reference = `REQ-SL${++seq}Z`;
  await db.insert(requests).values({ userId: workspaceId, workflowId: wf!.id, runId: r!.id, reference, submissionKey: randomUUID(), subject: "Aircon" });
  await queueDelivery(db, { userId: workspaceId, runId: r!.id, stepId: "tell", provider: "slack", reference, payload: { text } });
  return { runId: r!.id, reference, wf: wf! };
}
const delivery = async (runId: string) => (await db.select().from(deliveries).where(eq(deliveries.runId, runId)))[0]!;
const send = () => runDueDeliveries(db, secretsKey, urls);

describe("connect", () => {
  it("starts with bot scopes only, no user scope and no code challenge, and connects through the shared callback", async () => {
    const { agent, id } = await owner();
    expect((await agent.get("/settings/connections").expect(200)).body.oauth).toEqual(["slack"]);
    const { body } = await agent.post("/settings/connections/slack/oauth/start").expect(200);
    const q = new URL(body.url as string).searchParams;
    expect(new URL(body.url as string).pathname).toBe("/oauth/v2/authorize");
    expect(q.get("scope")).toBe("chat:write,channels:read");
    expect(q.has("user_scope")).toBe(false);
    expect(q.has("code_challenge")).toBe(false);
    expect(q.get("redirect_uri")).toBe("http://localhost:3000/settings/connections/oauth/callback");
    expect((await db.select().from(oauthFlows).where(eq(oauthFlows.workspaceId, id)))[0]!.verifierCiphertext).toBeNull();

    const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
    const res = await agent.get(back.pathname + back.search).expect(302);
    expect(res.headers.location).toBe("/#/apps/slack-connected");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    const [row] = await rows(id);
    expect(row).toMatchObject({ provider: "slack", authMethod: "oauth", account: "Acme Dental", externalId: "T0INSTALL1", scopes: "chat:write,channels:read", status: "active", destination: null, accessExpiresAt: null });
    const blob = readTokenBlob((await connectionCredential(db, secretsKey, id, "slack"))!.credential);
    expect(blob).toMatchObject({ v: 1, accessExpiresAt: null, scope: "chat:write,channels:read" });
    expect(blob.accessToken).toMatch(/^xoxb-fake-install-/);
    expect(blob.refreshToken).toBeUndefined();
    expect(JSON.stringify((await agent.get("/settings/connections").expect(200)).body)).not.toContain("xoxb-");
  });

  it("lists channels, saves one and sends a test message with the OAuth token", async () => {
    const { agent, id } = await owner();
    await install(agent);
    expect((await agent.get("/settings/connections/slack/channels").expect(200)).body).toEqual([{ id: "C0REQ", name: "office-requests", isMember: true }]);
    await pick(agent);
    const before = fake.slack.messages.length;
    expect((await agent.post("/settings/connections/slack/test").expect(200)).body).toMatchObject({ ok: true, channel: "C0REQ" });
    expect(fake.slack.messages).toHaveLength(before + 1);
    expect((await rows(id))[0]).toMatchObject({ status: "active", destination: { channelId: "C0REQ", channelName: "office-requests" } });
    // Slack's own hint stays: an app that was never invited cannot post (chat:write.public is not asked for).
    fake.slack.channels[0]!.is_member = false;
    expect((await agent.post("/settings/connections/slack/test").expect(200)).body).toEqual({ ok: false, error: expect.stringContaining("/invite") });
  });

  it("lands a decline, a narrower grant and a failed exchange on fixed outcomes, saving nothing", async () => {
    const { agent, id } = await owner();
    fake.oauth.v2!.consent = "declined";
    expect(await install(agent)).toBe("/#/apps/slack-declined");
    // A grant without channels:read, or without chat:write: nothing is saved.
    Object.assign(fake.oauth.v2!, { consent: "narrow", grantScopes: ["chat:write"] });
    expect(await install(agent)).toBe("/#/apps/slack-missing_scope");
    fake.oauth.v2!.grantScopes = ["channels:read"];
    expect(await install(agent)).toBe("/#/apps/slack-missing_scope");
    fake.oauth.v2!.consent = "grant";
    // Slack answers 200 with ok: false for a bad code, and 5xx when it is down.
    let path = await consentBack(agent);
    fake.once("/api/oauth.v2.access", { status: 200, body: { ok: false, error: "invalid_code" } });
    expect(await land(agent, path)).toBe("/#/apps/slack-failed");
    path = await consentBack(agent);
    fake.once("/api/oauth.v2.access", { status: 503, body: {} });
    expect(await land(agent, path)).toBe("/#/apps/slack-failed");
    // An answer that is not a bot token is refused.
    path = await consentBack(agent);
    fake.once("/api/oauth.v2.access", { status: 200, body: { ok: true, access_token: "xoxp-user-token", token_type: "user", scope: "chat:write,channels:read" } });
    expect(await land(agent, path)).toBe("/#/apps/slack-failed");
    expect(await rows(id)).toEqual([]);
  });

  it("uses the state once and only for the member who started it", async () => {
    const ana = await owner();
    const ben = await owner();
    const path = await consentBack(ana.agent);
    expect(await land(ben.agent, path)).toBe("/#/apps/oauth-expired");
    expect(await land(request(server), path)).toBe("/#/apps/oauth-expired");
    expect(await land(ana.agent, path)).toBe("/#/apps/slack-connected");
    const calls = fake.oauth.v2!.tokenCalls;
    expect(await land(ana.agent, path)).toBe("/#/apps/oauth-expired");
    expect(fake.oauth.v2!.tokenCalls).toBe(calls);
    expect(await rows(ben.id)).toEqual([]);
  });
});

describe("reconnect", () => {
  it("keeps the chosen channel for the same workspace and clears it for another one", async () => {
    const { agent, id } = await owner();
    await install(agent);
    await pick(agent);
    const first = (await rows(id))[0]!;
    expect(await install(agent)).toBe("/#/apps/slack-connected");
    const same = (await rows(id))[0]!;
    expect(same.destination).toEqual({ channelId: "C0REQ", channelName: "office-requests" });
    expect(same.credentialIv).not.toBe(first.credentialIv);
    team("T0OTHER99", "Other Clinic");
    expect(await install(agent)).toBe("/#/apps/slack-connected");
    expect((await rows(id))[0]).toMatchObject({ account: "Other Clinic", externalId: "T0OTHER99", destination: null });
  });

  it("keeps the pasted-token path as it was, and a pasted token replaces an OAuth grant", async () => {
    const { agent, id } = await owner();
    await agent.put("/settings/connections/slack").send({ token: fake.slack.token }).expect(200);
    expect((await rows(id))[0]).toMatchObject({ authMethod: "token", account: "Lim Dental", externalId: null });
    await pick(agent);
    expect((await agent.post("/settings/connections/slack/test").expect(200)).body).toMatchObject({ ok: true });
    await agent.delete("/settings/connections/slack").expect(204);

    await install(agent);
    await pick(agent);
    await agent.put("/settings/connections/slack").send({ token: fake.slack.token }).expect(200);
    expect((await rows(id))[0]).toMatchObject({ authMethod: "token", account: "Lim Dental", externalId: null, scopes: null, destination: { channelId: "C0REQ" } });
    expect((await agent.post("/settings/connections/slack/test").expect(200)).body).toMatchObject({ ok: true });
  });
});

describe("pinned deliveries across re-authorization (R7)", () => {
  it("sends a queued note with the new token after a reconnect to the same workspace", async () => {
    const { agent, id } = await owner();
    await install(agent);
    await pick(agent);
    const old = readTokenBlob((await connectionCredential(db, secretsKey, id, "slack"))!.credential).accessToken;
    const n = await queueNote(id, "REQ-SAME hello");
    await install(agent);
    const fresh = readTokenBlob((await connectionCredential(db, secretsKey, id, "slack"))!.credential).accessToken;
    expect(fresh).not.toBe(old);
    fake.slack.installs.delete(old);
    await send();
    expect(await delivery(n.runId)).toMatchObject({ state: "delivered", pinnedExternalId: "T0INSTALL1" });
    expect(fake.slack.messages.filter((m) => m.text === "REQ-SAME hello")).toHaveLength(1);
  });

  it("fails a queued note with no channel after a reconnect to another workspace, until a channel is picked there, and then sends it to review", async () => {
    const a = await owner();
    await install(a.agent);
    await pick(a.agent);
    const gone = await queueNote(a.id, "REQ-GONE hello");
    team("T0OTHER99", "Other Clinic");
    await install(a.agent);
    await send();
    expect(await delivery(gone.runId)).toMatchObject({ state: "failed", lastError: expect.stringContaining("No channel is chosen") });

    team("T0INSTALL1", "Acme Dental");
    const b = await owner();
    await install(b.agent);
    await pick(b.agent);
    const held = await queueNote(b.id, "REQ-HELD hello");
    team("T0OTHER99", "Other Clinic");
    await install(b.agent);
    await pick(b.agent);
    await send();
    expect(await delivery(held.runId)).toMatchObject({ state: "needs_review", lastError: expect.stringContaining("connection changed") });
    expect(fake.slack.messages.filter((m) => m.text.startsWith("REQ-GONE") || m.text.startsWith("REQ-HELD"))).toEqual([]);
  });

  it("goes on after a pasted token becomes an OAuth grant for the same-named workspace, once the channel is picked again", async () => {
    const { agent, id } = await owner();
    await agent.put("/settings/connections/slack").send({ token: fake.slack.token }).expect(200);
    await pick(agent);
    const n = await queueNote(id, "REQ-PASTE hello");
    team("T0FAKE", "Lim Dental");
    await install(agent);
    // The pasted connection had no workspace id to compare, so the channel is asked for again.
    expect((await rows(id))[0]).toMatchObject({ authMethod: "oauth", externalId: "T0FAKE", destination: null });
    await pick(agent);
    await send();
    expect(await delivery(n.runId)).toMatchObject({ state: "delivered", pinnedExternalId: null });
  });
});

describe("keepalive", () => {
  it("leaves a bot token alone: it has no refresh token, so nothing is refreshed and nothing is marked failed", async () => {
    const { agent, id } = await owner();
    await install(agent);
    await db.update(connections).set({ refreshedAt: new Date(Date.now() - 90 * 86_400_000) }).where(eq(connections.userId, id));
    const calls = fake.oauth.v2!.tokenCalls;
    expect(await keepOAuthAlive(db, secretsKey, urls, [slack])).toBe(0);
    expect(fake.oauth.v2!.tokenCalls).toBe(calls);
    expect((await rows(id))[0]!.status).toBe("active");
  });
});

describe("disconnect", () => {
  it("revokes the bot token after deleting, says when Slack did not confirm, and answers 204 for a pasted token", async () => {
    const { agent, id } = await owner();
    await install(agent);
    const token = readTokenBlob((await connectionCredential(db, secretsKey, id, "slack"))!.credential).accessToken;
    expect((await agent.delete("/settings/connections/slack").expect(200)).body).toEqual({ revoked: true });
    expect(fake.slack.revokedInstalls).toContain(token);
    expect(fake.slack.installs.has(token)).toBe(false);
    expect(await rows(id)).toEqual([]);

    // Slack answers 200 with ok: false when it did not revoke: that is not a revoke.
    await install(agent);
    fake.oauth.v2!.revokeStatus = 500;
    expect((await agent.delete("/settings/connections/slack").expect(200)).body).toEqual({ revoked: false });
    expect(await rows(id)).toEqual([]);

    // Slack down: the row is gone all the same.
    await install(agent);
    fake.once("/api/auth.revoke", { status: 503, body: {} });
    expect((await agent.delete("/settings/connections/slack").expect(200)).body).toEqual({ revoked: false });
    expect(await rows(id)).toEqual([]);
    await agent.delete("/settings/connections/slack").expect(404);

    await agent.put("/settings/connections/slack").send({ token: fake.slack.token }).expect(200);
    const revoked = fake.slack.revokedInstalls.length;
    await agent.delete("/settings/connections/slack").expect(204);
    expect(fake.slack.revokedInstalls).toHaveLength(revoked);
  });

  it("keeps a queued note and its payload when Slack is disconnected", async () => {
    const { agent, id } = await owner();
    await install(agent);
    await pick(agent);
    const n = await queueNote(id, "REQ-KEEP hello");
    await agent.delete("/settings/connections/slack").expect(200);
    await send();
    expect(await delivery(n.runId)).toMatchObject({ state: "failed", payload: { text: "REQ-KEEP hello" }, lastError: expect.stringContaining("not connected") });
  });
});

describe("role permissions", () => {
  it("lets only owners start and disconnect Slack, and sends everyone else at the callback to expired", async () => {
    const o = await owner();
    const agents: Record<string, Agent | ReturnType<typeof request>> = { owner: o.agent, signedOut: request(server) };
    for (const role of ["operator", "approver", "requester"] as const) agents[role] = (await member(o.id, role)).agent;
    const status: Record<string, number[]> = {};
    for (const [role, agent] of Object.entries(agents)) {
      status[role] = [(await (agent as Agent).post("/settings/connections/slack/oauth/start")).status, (await (agent as Agent).delete("/settings/connections/slack")).status];
    }
    expect(status).toEqual({ owner: [200, 404], operator: [403, 403], approver: [403, 403], requester: [403, 403], signedOut: [401, 401] });
    const path = await consentBack(o.agent);
    for (const role of ["operator", "approver", "requester", "signedOut"]) expect(await land(agents[role]!, path)).toBe("/#/apps/oauth-expired");
    expect(await rows(o.id)).toEqual([]);
    expect(await land(o.agent, path)).toBe("/#/apps/slack-connected");
  });
});

describe("the bot token never leaks (R3, R4)", () => {
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
      // Slack echoing the code in its error text.
      fake.once("/api/oauth.v2.access", { status: 200, body: { ok: false, error: `code ${code} was refused` } });
      seen.push(await land(agent, path));
      seen.push(await install(agent));
      await pick(agent);
      seen.push(JSON.stringify((await agent.get("/settings/connections").expect(200)).body));
      seen.push(JSON.stringify((await agent.post("/settings/connections/slack/test")).body));
      seen.push(JSON.stringify((await agent.get("/settings/connections/slack/channels")).body));
      const all = [...logged, ...seen].join("\n");
      expect(all).not.toMatch(/xoxb-fake-install-/);
      expect(all).not.toContain(state);
      expect(all).not.toContain(code);
    } finally {
      for (const s of [...spies, out, err]) s.mockRestore();
    }
  });

  it("hides the bot token in run history, Activity, CSV, the delivery list and the explain and Ask prompts", async () => {
    const { agent, id } = await owner();
    await install(agent);
    await pick(agent);
    const token = readTokenBlob((await connectionCredential(db, secretsKey, id, "slack"))!.credential).accessToken;
    const n = await queueNote(id, "REQ-LEAK hello");
    // Run text that holds the token under keys the key-name mask would not catch, and a Slack error that echoes it.
    await db.update(runs).set({ state: "failed", triggerPayload: { note: `see ${token}` }, error: `failed with ${token}` }).where(eq(runs.id, n.runId));
    await db.insert(stepRuns).values({ runId: n.runId, stepId: "tell", attempt: 1, state: "failed", error: `refused ${token}`, input: { note: token }, output: { note: token }, outcome: "rejected" });
    fake.once("/api/chat.postMessage", { status: 200, body: { ok: false, error: `bad_${token}` } });
    await send();
    const [stored] = await db.select({ lastError: deliveries.lastError }).from(deliveries).where(eq(deliveries.runId, n.runId));
    expect(stored!.lastError).toContain(token);

    wires.length = 0;
    const out = [
      (await agent.get("/runs").expect(200)).text,
      (await agent.get(`/runs/${n.runId}`).expect(200)).text,
      (await agent.get(`/runs/export.csv?workflowId=${n.wf.id}`).expect(200)).text,
      (await agent.get(`/deliveries?runId=${n.runId}`).expect(200)).text,
      (await agent.get(`/runs/${n.runId}/explanation`).expect(200)).text,
      (await agent.post("/runs/ask/reword").send({ reference: n.reference, question: "why" }).expect(200)).text,
      ...wires,
    ];
    expect(wires.length).toBeGreaterThan(0);
    for (const text of out) expect(text).not.toContain(token);
    expect(out[3]).toContain("[secret]");
    expect(out[0]).toContain("[secret]");
  });
});
