import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { joinWorkspace, sessions, users, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";
import { sha256 } from "./http";

// Guided paste setups (P7): Telegram chat discovery, the Teams test after saving, PayMongo key first and secret second. Fake providers only.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let stub: Server;
let seq = 0;
const SK = "sk_test_synthetic_guided_key";
const WHSK = "whsk_synthetic_guided_secret";

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  stub = createServer((req, res) => {
    const ok = req.headers.authorization === `Basic ${Buffer.from(`${SK}:`).toString("base64")}`;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ok ? { data: [] } : { errors: [{ detail: "bad key" }] }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const paymongo = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, publicUrl: "https://daloy.test", providers: { ...fake.urls, paymongo, timeoutMs: 2000 } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  stub?.close();
  await pool?.end();
});

async function owner() {
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email: `guided${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return agent;
}

/** A member of the owner's workspace with a live session. */
async function member(ownerAgent: ReturnType<typeof request.agent>, role: "operator" | "approver" | "requester") {
  const workspaceId = (await ownerAgent.get("/auth/me").expect(200)).body.workspaceId as string;
  const [u] = await db.insert(users).values({ email: `guided-m${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}

const setBot = () => {
  const token = `${200000000 + ++seq}:abcdefghijklmnopqrstuvwxyzABCDEF_-0`;
  fake.telegram.token = token;
  fake.telegram.webhook = false;
  fake.telegram.updates = [];
  return token;
};

describe("Telegram chat discovery", () => {
  it("lists only the chats the bot has seen, newest first, with id, type and title and never message text", async () => {
    const agent = await owner();
    const token = setBot();
    fake.telegram.updates = [
      { update_id: 1, message: { chat: { id: -1001, type: "supergroup", title: "Office team" }, text: "PRIVATE-ONE" } },
      { update_id: 2, message: { chat: { id: 555, type: "private", first_name: "Ana", last_name: "Cruz" }, text: "PRIVATE-TWO", from: { id: 555 } } },
      { update_id: 3, channel_post: { chat: { id: -1002, type: "channel", title: "Updates" }, text: "PRIVATE-THREE" } },
      { update_id: 4, message: { chat: { id: -1001, type: "supergroup", title: "Office team" }, text: "PRIVATE-FOUR" } },
      { update_id: 5, poll: { id: "no chat here" } },
    ];
    const res = await agent.post("/settings/connections/telegram/chats").send({ token }).expect(200);
    expect(res.body).toEqual({
      bot: "@daloy_test_bot",
      webhookSet: false,
      chats: [
        { id: "-1001", type: "supergroup", title: "Office team" },
        { id: "-1002", type: "channel", title: "Updates" },
        { id: "555", type: "private", title: "Ana Cruz" },
      ],
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain(token);
    // Looking is not saving: no connection exists until the owner connects.
    expect((await agent.get("/settings/connections").expect(200)).body.connections).toEqual([]);
  });

  it("answers with an empty list when the bot has seen nothing, and with a plain flag when a webhook is set", async () => {
    const agent = await owner();
    const token = setBot();
    expect((await agent.post("/settings/connections/telegram/chats").send({ token }).expect(200)).body).toMatchObject({ chats: [], webhookSet: false });
    fake.telegram.webhook = true;
    fake.telegram.updates = [{ update_id: 1, message: { chat: { id: -1001, type: "group", title: "Hidden" }, text: "x" } }];
    const res = await agent.post("/settings/connections/telegram/chats").send({ token }).expect(200);
    expect(res.body).toEqual({ bot: "@daloy_test_bot", chats: [], webhookSet: true });
  });

  it("refuses a bad token without echoing it, and rejects other fields", async () => {
    const agent = await owner();
    setBot();
    const wrong = "123456789:wrongwrongwrongwrongwrongwrongwrong";
    const res = await agent.post("/settings/connections/telegram/chats").send({ token: wrong }).expect(400);
    expect(JSON.stringify(res.body)).not.toContain(wrong);
    await agent.post("/settings/connections/telegram/chats").send({ token: "nope" }).expect(400);
    await agent.post("/settings/connections/telegram/chats").send({ token: wrong, chatId: "1" }).expect(400);
  });

  it("is owner only, like the other connection routes", async () => {
    const o = await owner();
    const token = setBot();
    await request(server).post("/settings/connections/telegram/chats").send({ token }).expect(401);
    for (const role of ["operator", "approver", "requester"] as const) {
      await (await member(o, role)).post("/settings/connections/telegram/chats").send({ token }).expect(403);
    }
    await o.post("/settings/connections/telegram/chats").send({ token }).expect(200);
  });

  it("connects with a tapped chat id and keeps the token out of every answer", async () => {
    const agent = await owner();
    const token = setBot();
    const res = await agent.put("/settings/connections/telegram").send({ token, chatId: "-1001234567890" }).expect(200);
    expect(JSON.stringify(res.body)).not.toContain(token);
  });
});

describe("Teams guided setup", () => {
  it("saves the link, then the test message the console sends goes through; a deleted workflow gives the specific hint", async () => {
    const agent = await owner();
    const url = fake.teamsUrl("flow-purchasing");
    await agent.put("/settings/connections/teams").send({ url, channelName: "Purchasing" }).expect(200);
    const before = fake.teams.posts.length;
    expect((await agent.post("/settings/connections/teams/test").expect(200)).body).toMatchObject({ ok: true });
    expect(fake.teams.posts.length).toBe(before + 1);
    const gone = fake.teamsUrl("flow-deleted");
    await agent.put("/settings/connections/teams").send({ url: gone, channelName: "Purchasing" }).expect(200);
    const res = await agent.post("/settings/connections/teams/test").expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("deleted or turned off");
    expect(JSON.stringify(res.body)).not.toContain(gone);
    await agent.put("/settings/connections/teams").send({ url: "https://example.com/x/y/z/abc", channelName: "Purchasing" }).expect(400);
  });
});

describe("PayMongo guided setup", () => {
  it("saves the key first, shows the webhook address, refuses payment events until the secret is saved, then keeps the path", async () => {
    const agent = await owner();
    await agent.put("/settings/connections/paymongo").send({ secretKey: "sk_test_wrong" }).expect(400);
    const first = await agent.put("/settings/connections/paymongo").send({ secretKey: SK }).expect(200);
    const conn = first.body.connections.find((c: { provider: string }) => c.provider === "paymongo");
    expect(conn.destination).toMatchObject({ mode: "test", webhookPending: "true" });
    expect(JSON.stringify(first.body)).not.toContain(SK);
    // No secret yet: a signed-looking event is refused, not accepted with an empty key.
    await request(server).post(`/hooks/paymongo/${conn.destination.webhookPath}`).set("content-type", "application/json").set("paymongo-signature", "t=1,te=abc,li=").send("{}").expect(401);
    const second = await agent.put("/settings/connections/paymongo").send({ secretKey: SK, webhookSecret: WHSK }).expect(200);
    const done = second.body.connections.find((c: { provider: string }) => c.provider === "paymongo");
    expect(done.destination.webhookPath).toBe(conn.destination.webhookPath);
    expect(done.destination.webhookPending).toBeUndefined();
    expect(JSON.stringify(second.body)).not.toContain(WHSK);
    // Replacing only the key keeps the saved secret.
    const third = await agent.put("/settings/connections/paymongo").send({ secretKey: SK }).expect(200);
    expect(third.body.connections.find((c: { provider: string }) => c.provider === "paymongo").destination.webhookPending).toBeUndefined();
    await agent.put("/settings/connections/paymongo").send({ secretKey: SK, webhookSecret: "bad" }).expect(400);
  });
});
