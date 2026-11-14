import { randomBytes } from "node:crypto";
import { connectionCredential, connections, users, type Db } from "@daloy/db";
import { defaultPurchaseAnswers, purchaseRequestDefinition } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";
import { signState } from "./connections";

// Roadmap phase 5 (decision 0023): Outlook consent, Teams workflow links, and the purchase request template. Fakes only.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
const secretsKey = randomBytes(32);
let seq = 0;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  const microsoft = { clientId: fake.microsoft.clientId, clientSecret: fake.microsoft.clientSecret, tenant: "organizations" };
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000", providers: { ...fake.urls, timeoutMs: 2000, microsoft } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

beforeEach(() => {
  fake.microsoft.consent = "grant";
  fake.microsoft.mailboxEnabled = true;
});

async function signedIn() {
  const email = `owner${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: user!.id };
}

/** Start in Daloy, follow Microsoft's answer back to the callback, and return where the callback sends the browser. */
async function consent(agent: ReturnType<typeof request.agent>) {
  const { body } = await agent.post("/settings/connections/outlook/start").expect(200);
  const back = (await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!;
  const res = await agent.get(new URL(back).pathname + new URL(back).search).expect(302);
  return res.headers.location as string;
}

describe("Outlook", () => {
  it("shows the administrator link before the owner leaves Daloy, and connects the consenting mailbox", async () => {
    const { agent, userId } = await signedIn();
    const before = await agent.get("/settings/connections").expect(200);
    expect(before.body.outlook.configured).toBe(true);
    expect(before.body.outlook.adminConsentUrl).toContain("/v2.0/adminconsent?client_id=fake-client-id");
    const start = await agent.post("/settings/connections/outlook/start").expect(200);
    const url = new URL(start.body.url as string);
    expect(url.searchParams.get("scope")).toBe("offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    expect(await consent(agent)).toBe("/#/settings/business/outlook-connected");
    const after = await agent.get("/settings/connections").expect(200);
    expect(after.body.connections).toEqual([expect.objectContaining({ provider: "outlook", status: "active", account: "ana@contoso.example", destination: { mailbox: "ana@contoso.example" } })]);
    const [row] = await db.select().from(connections).where(eq(connections.userId, userId));
    expect(JSON.stringify(row)).not.toContain("ms-refresh-");
    expect(JSON.stringify(after.body)).not.toContain("ms-refresh-");
  });

  it("reports an administrator requirement and a refusal apart, and stores nothing", async () => {
    const { agent, userId } = await signedIn();
    fake.microsoft.consent = "admin_required";
    expect(await consent(agent)).toBe("/#/settings/business/outlook-admin_required");
    fake.microsoft.consent = "declined";
    expect(await consent(agent)).toBe("/#/settings/business/outlook-declined");
    expect(await db.select().from(connections).where(eq(connections.userId, userId))).toEqual([]);
  });

  it("lets an administrator approve without a Daloy session", async () => {
    const res = await request(server).get("/settings/connections/outlook/callback?admin_consent=True&tenant=contoso").expect(302);
    expect(res.headers.location).toBe("/#/settings/business/outlook-admin_approved");
  });

  it("refuses a code that comes back to someone other than the owner who started, or after the state expired", async () => {
    const ana = await signedIn();
    const ben = await signedIn();
    const { body } = await ana.agent.post("/settings/connections/outlook/start").expect(200);
    const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
    expect((await ben.agent.get(back.pathname + back.search).expect(302)).headers.location).toBe("/#/settings/business/outlook-expired");
    expect((await request(server).get(back.pathname + back.search).expect(302)).headers.location).toBe("/#/settings/business/outlook-expired");
    const old = signState(secretsKey, { w: ana.userId, m: ana.userId, e: Date.now() - 1, n: "x" });
    expect((await ana.agent.get(`/settings/connections/outlook/callback?code=abc&state=${old}`).expect(302)).headers.location).toBe("/#/settings/business/outlook-expired");
    const forged = `${old.split(".")[0]}.${"A".repeat(43)}`;
    expect((await ana.agent.get(`/settings/connections/outlook/callback?code=abc&state=${forged}`).expect(302)).headers.location).toBe("/#/settings/business/outlook-expired");
    expect(await db.select().from(connections).where(eq(connections.userId, ana.userId))).toEqual([]);
  });

  it("tests by sending to the mailbox itself, marks a revoked connection, and Reconnect makes it active again", async () => {
    const { agent } = await signedIn();
    await consent(agent);
    fake.microsoft.sent.length = 0;
    expect((await agent.post("/settings/connections/outlook/test").expect(200)).body).toMatchObject({ ok: true });
    expect(fake.microsoft.sent).toEqual([expect.objectContaining({ to: "ana@contoso.example", subject: "Test email from Daloy" })]);
    // The test rotated the refresh token; the success is still recorded (Astra, 283fa1a).
    expect((await agent.get("/settings/connections").expect(200)).body.connections[0].lastTestedAt).not.toBeNull();

    fake.microsoft.refreshTokens.clear();
    fake.microsoft.accessTokens.clear();
    const failed = await agent.post("/settings/connections/outlook/test").expect(200);
    expect(failed.body).toMatchObject({ ok: false, error: expect.stringMatching(/Reconnect Outlook/) });
    expect((await agent.get("/settings/connections").expect(200)).body.connections[0]).toMatchObject({ status: "failed" });

    expect(await consent(agent)).toBe("/#/settings/business/outlook-connected");
    expect((await agent.get("/settings/connections").expect(200)).body.connections[0]).toMatchObject({ status: "active", lastError: null });
    await agent.delete("/settings/connections/outlook").expect(204);
    await agent.delete("/settings/connections/outlook").expect(404);
  });
});

describe("Outlook credential revisions (Astra, 283fa1a)", () => {
  it("a late token refresh for the old mailbox never overwrites the credential saved by Reconnect", async () => {
    const { agent, userId } = await signedIn();
    await consent(agent);
    let release!: () => void;
    fake.once("/oauth2/v2.0/token", { heldUntil: new Promise<void>((r) => (release = r)) });
    const tokenCalls = () => fake.calls.filter((c) => c.endsWith("/oauth2/v2.0/token")).length;
    const before = tokenCalls();
    const oldTest = agent.post("/settings/connections/outlook/test").then((r) => r); // refreshes with the old token
    for (let i = 0; i < 300 && tokenCalls() === before; i++) await new Promise((r) => setTimeout(r, 10));
    expect(tokenCalls()).toBe(before + 1);

    await consent(agent); // Reconnect while the old refresh answer is held
    const saved = (await connectionCredential(db, secretsKey, userId, "outlook"))!.credential;
    release();
    await oldTest;
    expect((await connectionCredential(db, secretsKey, userId, "outlook"))!.credential).toBe(saved);
  });
});

describe("Teams", () => {
  it("accepts only a Workflows link, keeps it out of responses, and tests by posting a card", async () => {
    const { agent } = await signedIn();
    await agent.put("/settings/connections/teams").send({ url: "https://hooks.example.com/teams", channelName: "Purchasing" }).expect(400);
    await agent.put("/settings/connections/teams").send({ url: "http://169.254.169.254/latest", channelName: "Purchasing" }).expect(400);
    const res = await agent.put("/settings/connections/teams").send({ url: fake.teamsUrl("flow-purchasing"), channelName: "Purchasing" }).expect(200);
    expect(res.body.connections).toEqual([expect.objectContaining({ provider: "teams", status: "active", account: "Purchasing", destination: { channelName: "Purchasing" } })]);
    expect(JSON.stringify(res.body)).not.toContain("flow-purchasing");
    expect((await agent.post("/settings/connections/teams/test").expect(200)).body).toMatchObject({ ok: true, accepted: true });

    fake.teams.flows.delete("flow-purchasing");
    expect((await agent.post("/settings/connections/teams/test").expect(200)).body).toMatchObject({ ok: false, error: expect.stringMatching(/deleted or turned off/) });
    fake.teams.flows.add("flow-purchasing");
  });
});

describe("purchase request template", () => {
  it("saves its setup and is refused on Turn on until Outlook and Teams are connected", async () => {
    const { agent } = await signedIn();
    const [me] = await db.select().from(users).where(eq(users.id, (await agent.get("/auth/me").expect(200)).body.id));
    const answers = { ...defaultPurchaseAnswers(me!.email), outlook: true, teams: true };
    const wf = (await agent.post("/workflows").send({ name: "Purchase requests", slug: "purchase-requests" }).expect(201)).body;
    await agent.patch(`/workflows/${wf.id}/setup`).send({ template: "purchase-request", step: "approver", answers }).expect(200);
    expect((await agent.get(`/workflows/${wf.id}`).expect(200)).body.setup).toMatchObject({ template: "purchase-request", step: "approver" });
    await agent.patch(`/workflows/${wf.id}/setup`).send({ template: "purchase-request", step: "fields", answers }).expect(400);

    const definition = purchaseRequestDefinition(answers);
    const refused = await agent.post(`/workflows/${wf.id}/versions`).send({ definition, publish: true }).expect(400);
    expect(refused.body.message).toMatch(/Connect (Outlook|Microsoft Teams) in Settings/);
    await consent(agent);
    await agent.put("/settings/connections/teams").send({ url: fake.teamsUrl("flow-purchasing"), channelName: "Purchasing" }).expect(200);
    await agent.post(`/workflows/${wf.id}/versions`).send({ definition, publish: true }).expect(201);
  });
});
