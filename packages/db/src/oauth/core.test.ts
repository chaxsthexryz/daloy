import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../../test/fake-providers";
import { fakeOAuthProvider } from "../../../../test/oauth-provider";
import { connectionCredential, readConnections, setDestination } from "../connections";
import { decryptSecret } from "../crypto";
import { queueDelivery, runDueDeliveries } from "../deliveries";
import type { Db } from "../index";
import { ProviderError, type ProviderUrls } from "../providers";
import { connections, deliveries, oauthFlows, runs, users, workflows, workflowVersions } from "../schema";
import { consumeFlow, deleteOldFlows, disconnectOAuth, finishFlow, freshToken, keepOAuthAlive, oauthEnvProblem, pkceChallenge, readTokenBlob, startFlow, withFreshToken, type OAuthProvider } from "./core";

// Decision 0058: the shared OAuth core against the generic fake app. Synthetic secrets only; nothing leaves the machine.
const key = randomBytes(32);
const PUBLIC = "http://localhost:3000";
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let def: ReturnType<typeof fakeOAuthProvider>;

const newUser = async () => (await db.insert(users).values({ email: `u${randomBytes(4).toString("hex")}@test.local`, passwordHash: "x" }).returning())[0]!.id;
const app = () => fake.oauth.test!;

/** The whole consent dance: start, the fake's consent page, then the callback's consume and finish. */
async function consent(ws: string, member = ws, d = def) {
  const url = new URL(await startFlow(db, key, urls, PUBLIC, d, { workspaceId: ws, memberId: member }));
  const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
  const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: ws, memberId: member });
  if (!flow) throw new Error("flow not found");
  if (back.searchParams.get("error")) return d.outcome(back.searchParams.get("error")!, back.searchParams.get("error_description") ?? "");
  return finishFlow(db, key, urls, PUBLIC, d, ws, back.searchParams.get("code")!, flow.verifier);
}
const held = async (ws: string) => (await connectionCredential(db, key, ws, def.provider))!;
const row = async (ws: string) => (await db.select().from(connections).where(and(eq(connections.userId, ws), eq(connections.provider, def.provider))))[0]!;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  urls = { ...fake.urls, timeoutMs: 1000 };
  def = fakeOAuthProvider(fake);
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

beforeEach(() => {
  Object.assign(app(), { consent: "grant", rotation: "strict", keepPrevious: false, expiresIn: 3600, revokeStatus: 200, tokenCalls: 0 });
  app().revoked.length = 0;
  app().user = { id: "test-user-1", email: "ana@test.example" };
});

describe("flows", () => {
  it("stores only the state's hash and an encrypted verifier, and sends an S256 challenge", async () => {
    const ws = await newUser();
    const url = new URL(await startFlow(db, key, urls, PUBLIC, def, { workspaceId: ws, memberId: ws }));
    const state = url.searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/settings/connections/oauth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const [flow] = await db.select().from(oauthFlows).where(eq(oauthFlows.workspaceId, ws));
    expect(JSON.stringify(flow)).not.toContain(state);
    const verifier = decryptSecret(key, ws, `oauth-flow:${flow!.id}`, { ciphertext: flow!.verifierCiphertext!, iv: flow!.verifierIv!, authTag: flow!.verifierAuthTag! });
    expect(pkceChallenge(verifier)).toBe(url.searchParams.get("code_challenge"));
    expect(flow!.expiresAt.getTime() - flow!.createdAt.getTime()).toBeCloseTo(10 * 60_000, -3);
  });

  it("is used once, even by many callbacks at the same moment", async () => {
    const ws = await newUser();
    const state = new URL(await startFlow(db, key, urls, PUBLIC, def, { workspaceId: ws, memberId: ws })).searchParams.get("state")!;
    const got = await Promise.all(Array.from({ length: 10 }, () => consumeFlow(db, key, state, { workspaceId: ws, memberId: ws })));
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(await consumeFlow(db, key, state, { workspaceId: ws, memberId: ws })).toBeNull();
  });

  it("answers another member, another workspace, an expired, an empty or an unknown state with nothing, and leaves the flow usable", async () => {
    const ws = await newUser();
    const other = await newUser();
    const state = new URL(await startFlow(db, key, urls, PUBLIC, def, { workspaceId: ws, memberId: ws })).searchParams.get("state")!;
    expect(await consumeFlow(db, key, state, { workspaceId: ws, memberId: other })).toBeNull();
    expect(await consumeFlow(db, key, state, { workspaceId: other, memberId: ws })).toBeNull();
    expect(await consumeFlow(db, key, state, { workspaceId: other, memberId: other })).toBeNull();
    expect(await consumeFlow(db, key, "", { workspaceId: ws, memberId: ws })).toBeNull();
    expect(await consumeFlow(db, key, randomBytes(32).toString("base64url"), { workspaceId: ws, memberId: ws })).toBeNull();
    expect(await consumeFlow(db, key, state, { workspaceId: ws, memberId: ws })).toMatchObject({ provider: def.provider });

    const late = new URL(await startFlow(db, key, urls, PUBLIC, def, { workspaceId: ws, memberId: ws })).searchParams.get("state")!;
    await db.update(oauthFlows).set({ expiresAt: sql`now() - interval '1 second'` }).where(and(eq(oauthFlows.workspaceId, ws), sql`${oauthFlows.consumedAt} is null`));
    expect(await consumeFlow(db, key, late, { workspaceId: ws, memberId: ws })).toBeNull();
  });

  it("refuses a verifier copied from another flow, and the provider refuses a code with the wrong verifier", async () => {
    const ws = await newUser();
    await startFlow(db, key, urls, PUBLIC, def, { workspaceId: ws, memberId: ws });
    await startFlow(db, key, urls, PUBLIC, def, { workspaceId: ws, memberId: ws });
    const [a, b] = await db.select().from(oauthFlows).where(eq(oauthFlows.workspaceId, ws));
    expect(() => decryptSecret(key, ws, `oauth-flow:${b!.id}`, { ciphertext: a!.verifierCiphertext!, iv: a!.verifierIv!, authTag: a!.verifierAuthTag! })).toThrow();

    const url = new URL(await startFlow(db, key, urls, PUBLIC, def, { workspaceId: ws, memberId: ws }));
    const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
    await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: ws, memberId: ws });
    await expect(finishFlow(db, key, urls, PUBLIC, def, ws, back.searchParams.get("code")!, "wrong-verifier-wrong-verifier-wrong-verifier")).rejects.toMatchObject({ kind: "auth" });
    expect(await readConnections(db, ws)).toEqual([]);
  });

  it("deletes flows a day after they expire", async () => {
    const ws = await newUser();
    await startFlow(db, key, urls, PUBLIC, def, { workspaceId: ws, memberId: ws });
    await startFlow(db, key, urls, PUBLIC, def, { workspaceId: ws, memberId: ws });
    const [old] = await db.select().from(oauthFlows).where(eq(oauthFlows.workspaceId, ws));
    await db.update(oauthFlows).set({ expiresAt: sql`now() - interval '25 hours'` }).where(eq(oauthFlows.id, old!.id));
    expect(await deleteOldFlows(db)).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(oauthFlows).where(eq(oauthFlows.workspaceId, ws))).toHaveLength(1);
  });
});

describe("saving a grant", () => {
  it("keeps the tokens encrypted with the account, scopes and client in plain columns", async () => {
    const ws = await newUser();
    expect(await consent(ws)).toBe("connected");
    const r = await row(ws);
    expect(r).toMatchObject({ status: "active", authMethod: "oauth", account: "ana@test.example", externalId: "test-user-1", scopes: "read write offline_access", oauthClientId: "test-client-id", destination: null });
    expect(r.accessExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 3000_000);
    expect(JSON.stringify(r)).not.toMatch(/test-(access|refresh)-/);
    const blob = readTokenBlob((await held(ws)).credential);
    expect(blob).toMatchObject({ v: 1, accessToken: expect.stringMatching(/^test-access-/), refreshToken: expect.stringMatching(/^test-refresh-/) });
  });

  it("saves nothing when the person granted less than Daloy needs", async () => {
    const ws = await newUser();
    Object.assign(app(), { consent: "narrow", grantScopes: ["read"] });
    expect(await consent(ws)).toBe("missing_scope");
    expect(await readConnections(db, ws)).toEqual([]);
  });

  it("keeps the destination on a reconnect to the same account and clears it for another account", async () => {
    const ws = await newUser();
    await consent(ws);
    await setDestination(db, ws, def.provider, { listId: "list-1" });
    await consent(ws);
    expect((await row(ws)).destination).toEqual({ listId: "list-1" });
    app().user = { id: "test-user-2", email: "ben@test.example" };
    await consent(ws);
    expect(await row(ws)).toMatchObject({ externalId: "test-user-2", account: "ben@test.example", destination: null });
  });
});

describe("refresh", () => {
  async function stale(ws: string) {
    app().expiresIn = 60; // under the two-minute margin, so the stored token counts as expiring
    await consent(ws);
    app().expiresIn = 3600;
    app().tokenCalls = 0;
  }

  it("refreshes once for ten workers at the same moment, against a provider that refuses a reused refresh token", async () => {
    const ws = await newUser();
    await stale(ws);
    const conns = await Promise.all(Array.from({ length: 10 }, () => held(ws)));
    const tokens = await Promise.all(conns.map((c) => freshToken(db, key, urls, ws, def, c)));
    expect(app().tokenCalls).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    const r = await row(ws);
    expect(conns.every((c) => c.revision === r.credentialIv)).toBe(true);
    expect(r.refreshedAt).not.toBeNull();
    // The stored refresh token is the rotated one, and it still works.
    expect(await freshToken(db, key, urls, ws, def, await held(ws), { force: true })).toMatch(/^test-access-/);
    expect((await row(ws)).status).toBe("active");
  });

  it("loses the rotated token if the process dies after the provider answers, and then asks for a reconnect", async () => {
    const ws = await newUser();
    await stale(ws);
    const before = (await row(ws)).credentialIv;
    let release!: () => void;
    fake.once("/oauth/test/token", { heldUntil: new Promise<void>((r) => (release = r)) });
    const refreshing = freshToken(db, key, urls, ws, def, await held(ws)).catch((e: unknown) => e);
    for (let i = 0; i < 300 && app().tokenCalls === 0; i++) await new Promise((r) => setTimeout(r, 10));
    // The provider has rotated; the write that would save the new pair fails before it commits, as if the process died.
    await pool.query("create function crash_refresh() returns trigger language plpgsql as $$ begin raise exception 'crash'; end $$");
    await pool.query("create trigger crash_refresh before update on connections for each row execute function crash_refresh()");
    release();
    expect(await refreshing).toBeInstanceOf(Error);
    await pool.query("drop trigger crash_refresh on connections; drop function crash_refresh()");
    expect((await row(ws)).credentialIv).toBe(before);
    await expect(freshToken(db, key, urls, ws, def, await held(ws))).rejects.toMatchObject({ kind: "auth", message: expect.stringMatching(/Reconnect Test app/) });
    expect(await row(ws)).toMatchObject({ status: "failed", lastError: expect.stringMatching(/Reconnect Test app/) });
  });

  it("tries the previous refresh token once where the provider still accepts it", async () => {
    const ws = await newUser();
    await stale(ws);
    Object.assign(app(), { keepPrevious: true });
    await freshToken(db, key, urls, ws, def, await held(ws), { force: true }); // rotates; the old one is now "previous"
    const blob = readTokenBlob((await held(ws)).credential);
    // Make the current refresh token unusable, as if the provider never saw it.
    app().refreshTokens.delete(blob.refreshToken!);
    await expect(freshToken(db, key, urls, ws, def, await held(ws), { force: true })).rejects.toMatchObject({ kind: "auth" });

    const ws2 = await newUser();
    await stale(ws2);
    await freshToken(db, key, urls, ws2, def, await held(ws2), { force: true });
    app().refreshTokens.delete(readTokenBlob((await held(ws2)).credential).refreshToken!);
    const lenient = { ...def, previousRefreshTokenWorks: true };
    expect(await freshToken(db, key, urls, ws2, lenient, await held(ws2), { force: true })).toMatch(/^test-access-/);
    expect((await row(ws2)).status).toBe("active");
  });

  it("leaves the row as it was on 429, 5xx and a slow answer", async () => {
    const ws = await newUser();
    await stale(ws);
    const before = await row(ws);
    fake.once("/oauth/test/token", { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "20" } });
    await expect(freshToken(db, key, urls, ws, def, await held(ws))).rejects.toMatchObject({ kind: "quota", retryAfterMs: 20_000 });
    fake.once("/oauth/test/token", { status: 503, body: {} });
    await expect(freshToken(db, key, urls, ws, def, await held(ws))).rejects.toMatchObject({ kind: "unavailable" });
    fake.once("/oauth/test/token", "hang");
    await expect(freshToken(db, key, urls, ws, def, await held(ws))).rejects.toMatchObject({ kind: "unavailable" });
    expect(await row(ws)).toEqual(before);
  });

  it("marks the connection failed for the revision that was refused, and only that one", async () => {
    const ws = await newUser();
    await stale(ws);
    app().refreshTokens.clear();
    await expect(freshToken(db, key, urls, ws, def, await held(ws))).rejects.toBeInstanceOf(ProviderError);
    expect((await row(ws)).status).toBe("failed");
    await consent(ws);
    expect((await row(ws)).status).toBe("active");
  });

  it("refreshes once after the API refuses a token that should still work, and gives up after a second refusal", async () => {
    const ws = await newUser();
    await consent(ws);
    app().tokenCalls = 0;
    const seen: string[] = [];
    const out = await withFreshToken(db, key, urls, ws, def, await held(ws), async (t) => {
      seen.push(t);
      if (seen.length === 1) throw new ProviderError("refused", "auth");
      return "ok";
    });
    expect(out).toBe("ok");
    expect(app().tokenCalls).toBe(1);
    expect(seen[0]).not.toBe(seen[1]);
    await expect(withFreshToken(db, key, urls, ws, def, await held(ws), () => Promise.reject(new ProviderError("refused", "auth")))).rejects.toMatchObject({ kind: "auth" });
  });

  it("keeps idle grants alive, and marks failed only a grant the provider refused", async () => {
    const [idle, recent, revoked, down] = [await newUser(), await newUser(), await newUser(), await newUser()];
    for (const ws of [idle, recent, revoked, down]) await consent(ws);
    const ago = (days: number) => sql`now() - make_interval(days => ${days})`;
    for (const ws of [idle, revoked, down]) await db.update(connections).set({ refreshedAt: ago(40) }).where(eq(connections.userId, ws));
    await db.update(connections).set({ refreshedAt: ago(10) }).where(eq(connections.userId, recent));
    app().refreshTokens.delete(readTokenBlob((await held(revoked)).credential).refreshToken!);
    const recentBefore = await row(recent);
    // The sweep visits the oldest first; the last one finds the provider down.
    await db.update(connections).set({ refreshedAt: ago(39) }).where(eq(connections.userId, down));
    fake.once("/oauth/test/token", { status: 500, body: {} }, 2);
    await keepOAuthAlive(db, key, urls, [def]);
    expect((await row(idle)).refreshedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await row(recent)).toEqual(recentBefore);
    expect((await row(revoked)).status).toBe("failed");
    expect(await row(down)).toMatchObject({ status: "active" });
    expect((await row(down)).refreshedAt!.getTime()).toBeLessThan(Date.now() - 30 * 86_400_000);
  });
});

describe("isolation", () => {
  it("gives two workspaces on the same provider account their own tokens, which do not decrypt in each other's rows", async () => {
    const [a, b] = [await newUser(), await newUser()];
    await consent(a);
    await consent(b);
    const [ra, rb] = [await row(a), await row(b)];
    expect(ra.externalId).toBe(rb.externalId);
    expect(readTokenBlob((await held(a)).credential).accessToken).not.toBe(readTokenBlob((await held(b)).credential).accessToken);
    await db.update(connections).set({ credentialCiphertext: ra.credentialCiphertext, credentialIv: ra.credentialIv, credentialAuthTag: ra.credentialAuthTag }).where(eq(connections.userId, b));
    await expect(connectionCredential(db, key, b, def.provider)).rejects.toThrow();
  });
});

describe("disconnect", () => {
  async function newRun(userId: string) {
    const [wf] = await db.insert(workflows).values({ userId, name: "Cards", slug: `w${randomBytes(4).toString("hex")}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    return (await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning())[0]!.id;
  }

  it("deletes the row, then revokes the refresh token at the provider", async () => {
    const ws = await newUser();
    await consent(ws);
    const refresh = readTokenBlob((await held(ws)).credential).refreshToken!;
    expect(await disconnectOAuth(db, key, urls, ws, def)).toEqual({ removed: true, revoked: true });
    expect(app().revoked).toEqual([refresh]);
    expect(await readConnections(db, ws)).toEqual([]);
    expect(await disconnectOAuth(db, key, urls, ws, def)).toEqual({ removed: false, revoked: null });
  });

  it("still disconnects when the revoke fails or the provider has none, and queued deliveries keep their payload", async () => {
    const ws = await newUser();
    await consent(ws);
    await setDestination(db, ws, def.provider, { listId: "5f0000000000000000000001" });
    const d = await queueDelivery(db, { userId: ws, runId: await newRun(ws), stepId: "card", provider: def.provider, reference: "REQ-1", payload: { name: "Chair", desc: "" } });
    app().revokeStatus = 500;
    expect(await disconnectOAuth(db, key, urls, ws, def)).toEqual({ removed: true, revoked: false });
    expect(await readConnections(db, ws)).toEqual([]);
    await runDueDeliveries(db, key, urls);
    const [after] = await db.select().from(deliveries).where(eq(deliveries.id, d.id));
    expect(after).toMatchObject({ state: "failed", errorKind: "not_connected", payload: { name: "Chair", desc: "" } });

    app().revokeStatus = 200;
    await consent(ws);
    fake.once("/oauth/test/revoke", "hang");
    expect(await disconnectOAuth(db, key, urls, ws, def)).toEqual({ removed: true, revoked: false });
    await consent(ws);
    expect(await disconnectOAuth(db, key, urls, ws, fakeOAuthProvider(fake, { revoke: false }))).toEqual({ removed: true, revoked: null });
  });
});

describe("boot check (R13)", () => {
  it("refuses a development client on a public host and a production client on a local one", () => {
    expect(oauthEnvProblem({})).toBeNull();
    expect(oauthEnvProblem({ MICROSOFT_CLIENT_ID: "x", PUBLIC_URL: "https://daloy.example" })).toBeNull();
    expect(oauthEnvProblem({ GOOGLE_OAUTH_CLIENT_ID: "x", PUBLIC_URL: "https://daloy.example" })).toMatch(/Set OAUTH_ENV/);
    expect(oauthEnvProblem({ OAUTH_ENV: "staging" })).toMatch(/development or production/);
    expect(oauthEnvProblem({ OAUTH_ENV: "development", PUBLIC_URL: "http://localhost:3000" })).toBeNull();
    expect(oauthEnvProblem({ OAUTH_ENV: "development", PUBLIC_URL: "http://127.0.0.1:3100" })).toBeNull();
    expect(oauthEnvProblem({ OAUTH_ENV: "development", PUBLIC_URL: "https://daloy.example" })).toMatch(/not a local address/);
    expect(oauthEnvProblem({ OAUTH_ENV: "production", PUBLIC_URL: "https://daloy.example", SLACK_CLIENT_ID: "x" })).toBeNull();
    expect(oauthEnvProblem({ OAUTH_ENV: "production", PUBLIC_URL: "http://localhost:3000" })).toMatch(/is a local address/);
    expect(oauthEnvProblem({ OAUTH_ENV: "production" })).toMatch(/is a local address/);
  });
});
