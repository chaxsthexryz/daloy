import { randomBytes } from "node:crypto";
import { joinWorkspace, mailSenders, pollMailboxTriggers, sessions, users, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";
import { sha256 } from "./http";

// G3 (decision 0132): editor status route, publish checks, and connection usage for Gmail & Outlook mailbox triggers.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let providers: Parameters<typeof createApp>[0]["providers"];
const secretsKey = randomBytes(32);
const ANA = { id: "google-ana-g3api", email: "ana-g3api@gmail.com" };
let seq = 0;
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  const g = fake.addOAuthApp("google", { rotation: "none" });
  g.user = ANA;
  providers = {
    ...fake.urls,
    timeoutMs: 2000,
    googleOAuth: { clientId: g.clientId, clientSecret: g.clientSecret, ...fake.oauthUrls("google") },
    microsoft: { clientId: fake.microsoft.clientId, clientSecret: fake.microsoft.clientSecret, tenant: "organizations" },
  };
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000", providers });
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
  fake.microsoft.grantScopes = null;
  Object.assign(fake.oauth.google!, { consent: "grant", user: ANA, emailVerified: true, grantScopes: [] });
});

async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `g3api${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}

async function connectGmail(agent: Agent) {
  const { body } = await agent.post("/settings/connections/gmail/oauth/start").expect(200);
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  await agent.get(back.pathname + back.search).expect(302);
}

async function connectOutlook(agent: Agent, grantScopes: string[] | null = null) {
  fake.microsoft.grantScopes = grantScopes;
  const { body } = await agent.post("/settings/connections/outlook/oauth/start").expect(200);
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  await agent.get(back.pathname + back.search).expect(302);
}

async function automation(agent: Agent) {
  const { body } = await agent.post("/workflows").send({ name: "Mail triage", slug: `mail-${++seq}` }).expect(201);
  return body.id as string;
}

const gmailDef = (config: Record<string, unknown> = {}) => ({
  trigger: { type: "gmail_message", config },
  steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }],
  edges: [],
});
const outlookDef = (config: Record<string, unknown> = {}) => ({
  trigger: { type: "outlook_message", config },
  steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }],
  edges: [],
});

describe("GET /triggers/mailbox/:type", () => {
  it("reports missing connection and scope problems, then ready once read scope is granted", async () => {
    const { agent, id } = await owner();
    expect((await agent.get("/triggers/mailbox/gmail_message").expect(200)).body).toMatchObject({
      app: "gmail",
      problem: "Gmail is not connected. Connect Gmail with Google in Apps.",
      account: null,
      watching: null,
    });
    await connectGmail(agent);
    expect((await agent.get("/triggers/mailbox/gmail_message").expect(200)).body.problem).toContain("gmail.readonly");

    await db
      .update(mailSenders)
      .set({ scopes: "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly" })
      .where(eq(mailSenders.userId, id));
    expect((await agent.get("/triggers/mailbox/gmail_message").expect(200)).body).toMatchObject({
      app: "gmail",
      problem: null,
      account: ANA.email,
    });

    expect((await agent.get("/triggers/mailbox/outlook_message").expect(200)).body.problem).toBe("Outlook is not connected. Connect Outlook in Apps.");
    await connectOutlook(agent, ["Mail.Send", "User.Read"]);
    expect((await agent.get("/triggers/mailbox/outlook_message").expect(200)).body.problem).toBe("Reconnect Outlook in Apps and allow reading mail (Mail.Read).");

    await connectOutlook(agent, ["Mail.Send", "Mail.Read", "User.Read"]);
    expect((await agent.get("/triggers/mailbox/outlook_message").expect(200)).body).toMatchObject({
      app: "outlook",
      problem: null,
      account: fake.microsoft.user.mail,
    });
  });

  it("shows watcher status in the same workspace only", async () => {
    const { agent } = await owner();
    await connectOutlook(agent);
    const wf = await automation(agent);
    await agent.post(`/workflows/${wf}/versions`).send({ definition: outlookDef({ folder: "Inbox" }), publish: true }).expect(201);
    await pollMailboxTriggers({ db, secretsKey, urls: providers!, enqueue: async () => {} });

    const { body } = await agent.get(`/triggers/mailbox/outlook_message?workflowId=${wf}`).expect(200);
    expect(body.watching).toMatchObject({ problem: null, failures: 0, started: true });

    const other = await owner();
    expect((await other.agent.get(`/triggers/mailbox/outlook_message?workflowId=${wf}`).expect(200)).body.watching).toBeNull();
  });

  it("refuses unknown types, bad workflowId, and requester role", async () => {
    const { agent, id } = await owner();
    await agent.get("/triggers/mailbox/webhook").expect(400);
    await agent.get("/triggers/mailbox/gmail_message?workflowId=bad").expect(400);

    const [u] = await db.insert(users).values({ email: `reqg3-${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
    await joinWorkspace(db, u!.id, id, "requester");
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    await request.agent(server).set("Cookie", `daloy_session=${token}`).get("/triggers/mailbox/gmail_message").expect(403);
  });
});

describe("publishing mailbox triggers and connection usage", () => {
  it("refuses publish until connected with read permission, then accepts and reports usage", async () => {
    const { agent, id } = await owner();
    const wfGmail = await automation(agent);
    const wfOutlook = await automation(agent);

    await agent.post(`/workflows/${wfGmail}/versions`).send({ definition: gmailDef({ subjectContains: "Order" }), publish: false }).expect(201);
    const refusedGmail = await agent.post(`/workflows/${wfGmail}/versions`).send({ definition: gmailDef({ subjectContains: "Order" }), publish: true }).expect(400);
    expect(refusedGmail.body.message).toMatch(/Connect Gmail/);

    await connectGmail(agent);
    const sendOnlyRefused = await agent.post(`/workflows/${wfGmail}/versions`).send({ definition: gmailDef(), publish: true }).expect(400);
    expect(sendOnlyRefused.body.message).toContain("gmail.readonly");

    await db
      .update(mailSenders)
      .set({ scopes: "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly" })
      .where(eq(mailSenders.userId, id));
    await agent.post(`/workflows/${wfGmail}/versions`).send({ definition: gmailDef({ label: "INBOX" }), publish: true }).expect(201);

    const refusedOutlook = await agent.post(`/workflows/${wfOutlook}/versions`).send({ definition: outlookDef(), publish: true }).expect(400);
    expect(refusedOutlook.body.message).toMatch(/Outlook is not connected/);

    await connectOutlook(agent, ["Mail.Send", "Mail.Read", "User.Read"]);
    await agent.post(`/workflows/${wfOutlook}/versions`).send({ definition: outlookDef({ folder: "Inbox" }), publish: true }).expect(201);

    const conns = await agent.get("/settings/connections").expect(200);
    expect(conns.body.usage.gmail).toEqual(expect.arrayContaining([expect.objectContaining({ id: wfGmail })]));
    expect(conns.body.usage.outlook).toEqual(expect.arrayContaining([expect.objectContaining({ id: wfOutlook })]));
  });
});
