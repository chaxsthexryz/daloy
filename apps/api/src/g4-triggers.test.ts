import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { runs, workflowVersions, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

// G4 (decision 0133): monitor status route, signing secret publish checks, webhook rotation,
// and signed inbound webhooks for Slack, Microsoft Teams, and Discord.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
const secretsKey = randomBytes(32);
let seq = 0;
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000" });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `g4api${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}

async function createAndPublish(agent: Agent, trigger: object) {
  const wf = await agent.post("/workflows").send({ name: `G4 ${++seq}`, slug: `g4-${seq}` }).expect(201);
  const wfId = wf.body.id as string;
  await agent
    .post(`/workflows/${wfId}/versions`)
    .send({ definition: { trigger, steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }], edges: [] }, publish: true })
    .expect(201);
  const loaded = await agent.get(`/workflows/${wfId}`).expect(200);
  return { wfId, webhookPath: loaded.body.trigger?.webhookPath as string | null };
}

async function workflowRuns(wfId: string) {
  const [v] = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wfId));
  return db.select().from(runs).where(eq(runs.workflowVersionId, v!.id));
}

describe("GET /triggers/monitor", () => {
  it("requires sign-in and returns watching state and daily http usage", async () => {
    await request(server).get("/triggers/monitor").expect(401);
    const { agent } = await owner();
    const { wfId } = await createAndPublish(agent, { type: "page_changed", config: { mode: "page", url: "https://example.com/prices", maxChars: 4000 } });
    const res = await agent.get(`/triggers/monitor?workflowId=${wfId}`).expect(200);
    expect(res.body).toMatchObject({ watching: null, http: { used: 0 } });
  });
});

describe("Slack trigger webhook (/hooks/slack/:path)", () => {
  it("checks signingSecret on publish, verifies signatures, answers challenges, filters, deduplicates, and rotates URLs", async () => {
    const { agent } = await owner();
    const wf = await agent.post("/workflows").send({ name: "Slack watch", slug: `slack-${++seq}` }).expect(201);
    const trigger = { type: "slack_message", config: { signingSecret: "slack_sign", channelId: "C012345", textContains: "urgent", ignoreBots: true } };

    // Publishing before the secret exists fails.
    await agent
      .post(`/workflows/${wf.body.id}/versions`)
      .send({ definition: { trigger, steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }], edges: [] }, publish: true })
      .expect(400);

    await agent.put("/secrets/slack_sign").send({ value: "slack-secret-123" }).expect(204);
    await agent
      .post(`/workflows/${wf.body.id}/versions`)
      .send({ definition: { trigger, steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }], edges: [] }, publish: true })
      .expect(201);

    const loaded = await agent.get(`/workflows/${wf.body.id}`).expect(200);
    const path = loaded.body.trigger.webhookPath as string;
    expect(path).toBeTruthy();

    const signSlack = (raw: string, ts = Math.floor(Date.now() / 1000)) => ({
      ts: String(ts),
      sig: `v0=${createHmac("sha256", "slack-secret-123").update(`v0:${ts}:${raw}`).digest("hex")}`,
    });

    // Unsigned or wrong signature -> 401.
    await request(server).post(`/hooks/slack/${path}`).send({ type: "url_verification", challenge: "c1" }).expect(401);

    // Verified challenge -> 200 { challenge }.
    const chBody = JSON.stringify({ type: "url_verification", challenge: "chal-99" });
    const chSig = signSlack(chBody);
    await request(server)
      .post(`/hooks/slack/${path}`)
      .set("content-type", "application/json")
      .set("x-slack-request-timestamp", chSig.ts)
      .set("x-slack-signature", chSig.sig)
      .send(chBody)
      .expect(200, { challenge: "chal-99" });

    // Bot message ignored.
    const botBody = JSON.stringify({ type: "event_callback", event_id: "EvBot", event: { type: "message", channel: "C012345", bot_id: "B1", text: "urgent bot", ts: "1" } });
    const botSig = signSlack(botBody);
    const botRes = await request(server)
      .post(`/hooks/slack/${path}`)
      .set("content-type", "application/json")
      .set("x-slack-request-timestamp", botSig.ts)
      .set("x-slack-signature", botSig.sig)
      .send(botBody)
      .expect(200);
    expect(botRes.body).toEqual({ ok: true, started: 0 });

    // Valid matching message starts run; duplicate event_id is idempotent.
    const msgBody = JSON.stringify({ type: "event_callback", event_id: "EvOK1", event: { type: "message", channel: "C012345", user: "U1", text: "Urgent order", ts: "173000.1" } });
    const msgSig = signSlack(msgBody);
    const first = await request(server)
      .post(`/hooks/slack/${path}`)
      .set("content-type", "application/json")
      .set("x-slack-request-timestamp", msgSig.ts)
      .set("x-slack-signature", msgSig.sig)
      .send(msgBody)
      .expect(200);
    expect(first.body).toMatchObject({ ok: true, started: 1 });
    expect(first.body.duplicate).toBeUndefined();

    const second = await request(server)
      .post(`/hooks/slack/${path}`)
      .set("content-type", "application/json")
      .set("x-slack-request-timestamp", msgSig.ts)
      .set("x-slack-signature", msgSig.sig)
      .send(msgBody)
      .expect(200);
    expect(second.body).toMatchObject({ ok: true, duplicate: true, runId: first.body.runId });
    expect(await workflowRuns(wf.body.id)).toHaveLength(1);

    // Rotate URL invalidates old path.
    const rotated = await agent.post(`/workflows/${wf.body.id}/webhook-url`).expect(201);
    expect(rotated.body.webhookPath).not.toBe(path);
    await request(server)
      .post(`/hooks/slack/${path}`)
      .set("content-type", "application/json")
      .set("x-slack-request-timestamp", msgSig.ts)
      .set("x-slack-signature", msgSig.sig)
      .send(msgBody)
      .expect(404);
  });
});

describe("Teams and Discord trigger webhooks (/hooks/teams/:path, /hooks/discord/:path)", () => {
  it("verifies Teams Authorization HMAC and X-Daloy-Signature and deduplicates by message id", async () => {
    const { agent } = await owner();
    const secretB64 = Buffer.from("teams-shared-secret-key").toString("base64");
    await agent.put("/secrets/teams_key").send({ value: secretB64 }).expect(204);
    const { wfId, webhookPath } = await createAndPublish(agent, { type: "teams_message", config: { signingSecret: "teams_key", textContains: "restock" } });

    const raw = JSON.stringify({ id: "t-msg-1", text: "<at>kymavo</at> Restock milk", from: { id: "u1", name: "Ana" }, channelData: { channel: { id: "19:c1", name: "Ops" } } });
    const auth = `HMAC ${createHmac("sha256", Buffer.from(secretB64, "base64")).update(raw).digest("base64")}`;

    await request(server).post(`/hooks/teams/${webhookPath}`).set("content-type", "application/json").set("authorization", "HMAC bad").send(raw).expect(401);
    const ok = await request(server).post(`/hooks/teams/${webhookPath}`).set("content-type", "application/json").set("authorization", auth).send(raw).expect(200);
    expect(ok.body).toMatchObject({ ok: true, started: 1 });
    expect(ok.body.duplicate).toBeUndefined();

    const dup = await request(server).post(`/hooks/teams/${webhookPath}`).set("content-type", "application/json").set("authorization", auth).send(raw).expect(200);
    expect(dup.body).toMatchObject({ ok: true, duplicate: true, runId: ok.body.runId });
    expect(await workflowRuns(wfId)).toHaveLength(1);
  });

  it("verifies Discord Ed25519 PING and slash commands, and HMAC relay calls", async () => {
    const { agent } = await owner();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    await agent.put("/secrets/discord_relay").send({ value: "relay-secret-9" }).expect(204);
    const { wfId, webhookPath } = await createAndPublish(agent, {
      type: "discord_message",
      config: { publicKey: pubHex, signingSecret: "discord_relay", commandName: "order" },
    });

    const signEd = (raw: string, ts = Math.floor(Date.now() / 1000)) => ({
      ts: String(ts),
      sig: sign(null, Buffer.concat([Buffer.from(String(ts)), Buffer.from(raw)]), privateKey).toString("hex"),
    });

    // PING verification -> { type: 1 }
    const pingRaw = JSON.stringify({ id: "p-1", type: 1 });
    const pingSig = signEd(pingRaw);
    await request(server)
      .post(`/hooks/discord/${webhookPath}`)
      .set("content-type", "application/json")
      .set("x-signature-ed25519", "00".repeat(64))
      .set("x-signature-timestamp", pingSig.ts)
      .send(pingRaw)
      .expect(401);

    await request(server)
      .post(`/hooks/discord/${webhookPath}`)
      .set("content-type", "application/json")
      .set("x-signature-ed25519", pingSig.sig)
      .set("x-signature-timestamp", pingSig.ts)
      .send(pingRaw)
      .expect(200, { type: 1 });

    // Slash command -> starts run and returns ephemeral confirmation.
    const cmdRaw = JSON.stringify({
      id: "cmd-77",
      type: 2,
      channel_id: "123456789012345678",
      member: { user: { id: "u1", username: "ana" } },
      data: { name: "order", options: [{ name: "ref", value: "ORD-9" }] },
    });
    const cmdSig = signEd(cmdRaw);
    const cmdRes = await request(server)
      .post(`/hooks/discord/${webhookPath}`)
      .set("content-type", "application/json")
      .set("x-signature-ed25519", cmdSig.sig)
      .set("x-signature-timestamp", cmdSig.ts)
      .send(cmdRaw)
      .expect(200);
    expect(cmdRes.body).toMatchObject({ type: 4, data: { content: "Received by kymavo.", flags: 64 } });
    expect(await workflowRuns(wfId)).toHaveLength(1);

    // Relay webhook signed with X-Daloy-Signature (when commandName not set).
    const relayWf = await createAndPublish(agent, { type: "discord_message", config: { signingSecret: "discord_relay" } });
    const relayRaw = JSON.stringify({ id: "msg-55", channel_id: "123456789012345678", content: "Hello team", author: { id: "u2", username: "ben" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const hmacSig = `sha256=${createHmac("sha256", "relay-secret-9").update(`${ts}.${relayRaw}`).digest("hex")}`;
    const relayRes = await request(server)
      .post(`/hooks/discord/${relayWf.webhookPath}`)
      .set("content-type", "application/json")
      .set("x-daloy-timestamp", ts)
      .set("x-daloy-signature", hmacSig)
      .send(relayRaw)
      .expect(200);
    expect(relayRes.body).toMatchObject({ ok: true, started: 1 });
    expect(relayRes.body.duplicate).toBeUndefined();
    expect(await workflowRuns(relayWf.wfId)).toHaveLength(1);
  });
});
