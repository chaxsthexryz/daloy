import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { BOOKING_CHANGED, bookings, connections, deliveries, queueDelivery, requests, resources, runs, users, workflowVersions, type Db } from "@daloy/db";
import { defaultAnswers, officeRequestDefinition } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";

// Apps (was Business and email), connections: Google Sheets and Slack (roadmap phase 3, decision 0021). Fake providers only.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let seq = 0;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, providers: { ...fake.urls, timeoutMs: 2000 } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

async function signedIn() {
  const email = `owner${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: user!.id };
}

function keyFile(email: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fake.addServiceAccount(email, publicKey.export({ type: "spki", format: "pem" }).toString());
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { pem, json: JSON.stringify({ type: "service_account", project_id: "office", private_key_id: "abc", private_key: pem, client_email: email }) };
}

describe("Google Sheets", () => {
  it("connects with a key file and a sheet link, and never shows or stores the key in the clear", async () => {
    const { agent, userId } = await signedIn();
    const email = `sheets${seq}@office.iam.gserviceaccount.com`;
    const rows = fake.addSheet(`sheet-${seq}-abcdefghij`, "Office requests", "Requests", [email]).tabs.get("Requests")!;
    const key = keyFile(email);
    const res = await agent
      .put("/settings/connections/google-sheets")
      .send({ serviceAccount: key.json, sheet: `https://docs.google.com/spreadsheets/d/sheet-${seq}-abcdefghij/edit#gid=0`, tab: "Requests" })
      .expect(200);
    expect(res.body.connections).toEqual([expect.objectContaining({ provider: "google_sheets", status: "active", account: email, destination: { spreadsheetId: `sheet-${seq}-abcdefghij`, tab: "Requests", title: "Office requests" } })]);
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE KEY");
    const [row] = await db.select().from(connections).where(eq(connections.userId, userId));
    expect(JSON.stringify(row)).not.toContain("PRIVATE KEY");

    const test = await agent.post("/settings/connections/google-sheets/test").expect(200);
    expect(test.body).toMatchObject({ ok: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toMatch(/^TEST-/);
  });

  it("refuses a key file that is not a service account key, or a sheet nobody shared", async () => {
    const { agent } = await signedIn();
    await agent.put("/settings/connections/google-sheets").send({ serviceAccount: "{not json", sheet: "abcdefghijkl", tab: "Sheet1" }).expect(400);
    const email = `unshared${seq}@office.iam.gserviceaccount.com`;
    fake.addSheet(`sheet-${seq}-unshared00`, "Private", "Sheet1", []);
    const res = await agent.put("/settings/connections/google-sheets").send({ serviceAccount: keyFile(email).json, sheet: `sheet-${seq}-unshared00`, tab: "Sheet1" }).expect(400);
    expect(res.body.message).toContain(email);
  });

  it("names the tabs when the chosen one does not exist", async () => {
    const { agent } = await signedIn();
    const email = `tabs${seq}@office.iam.gserviceaccount.com`;
    fake.addSheet(`sheet-${seq}-tabs000000`, "Office", "Requests", [email]);
    const res = await agent.put("/settings/connections/google-sheets").send({ serviceAccount: keyFile(email).json, sheet: `sheet-${seq}-tabs000000`, tab: "Sheet1" }).expect(400);
    expect(res.body.message).toContain("Requests");
  });
});

describe("Telegram", () => {
  it("validates the token and chat at the boundary, never returns the token, and sends a test message", async () => {
    const { agent } = await signedIn();
    fake.telegram.token = `${100000000 + seq}:abcdefghijklmnopqrstuvwxyzABCDEF_-0`;
    const good = { token: fake.telegram.token, chatId: "-1001234567890" };
    await agent.put("/settings/connections/telegram").send({ ...good, token: "not-a-token" }).expect(400);
    await agent.put("/settings/connections/telegram").send({ ...good, chatId: "my chat" }).expect(400);
    await agent.put("/settings/connections/telegram").send({ ...good, extra: 1 }).expect(400);
    await agent.put("/settings/connections/telegram").send({ ...good, token: "123456789:wrongwrongwrongwrongwrongwrongwrong" }).expect(400);
    await agent.put("/settings/connections/telegram").send({ ...good, chatId: "-1000000000001" }).expect(400);
    const res = await agent.put("/settings/connections/telegram").send(good).expect(200);
    expect(res.body.connections[0]).toMatchObject({ provider: "telegram", status: "active", account: "@daloy_test_bot", destination: { chatId: "-1001234567890", chatTitle: "Office team" } });
    expect(JSON.stringify(res.body)).not.toContain(good.token);
    const before = fake.telegram.messages.length;
    expect((await agent.post("/settings/connections/telegram/test").expect(200)).body).toMatchObject({ ok: true });
    expect(fake.telegram.messages.length).toBe(before + 1);
    await agent.delete("/settings/connections/telegram").expect(204);
  });
});

describe("Google Calendar", () => {
  it("connects with a key file and a calendar id, never returns the key, and makes and removes a test event", async () => {
    const { agent, userId } = await signedIn();
    const email = `cal${seq}@office.iam.gserviceaccount.com`;
    const id = `clinic${seq}@group.calendar.google.com`;
    const cal = fake.addCalendar(id, "Clinic bookings", [email]);
    const key = keyFile(email);
    await agent.put("/settings/connections/google-calendar").send({ serviceAccount: "{not json", calendar: id }).expect(400);
    await agent.put("/settings/connections/google-calendar").send({ serviceAccount: key.json, calendar: "https://calendar.google.com/x" }).expect(400);
    await agent.put("/settings/connections/google-calendar").send({ serviceAccount: key.json, calendar: id, extra: 1 }).expect(400);
    const res = await agent.put("/settings/connections/google-calendar").send({ serviceAccount: key.json, calendar: id }).expect(200);
    expect(res.body.connections[0]).toMatchObject({ provider: "google_calendar", status: "active", account: email, destination: { calendarId: id, title: "Clinic bookings" } });
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE KEY");
    const [row] = await db.select().from(connections).where(eq(connections.userId, userId));
    expect(JSON.stringify(row)).not.toContain(key.pem.slice(40, 80));
    expect((await agent.post("/settings/connections/google-calendar/test").expect(200)).body).toMatchObject({ ok: true });
    // The test event is removed again: Google keeps it as cancelled, and nothing is left confirmed.
    expect([...cal.events.values()].map((e) => e.status)).toEqual(["cancelled"]);
    await agent.delete("/settings/connections/google-calendar").expect(204);
  });

  it("says to share the calendar when the service account cannot see it", async () => {
    const { agent } = await signedIn();
    const email = `calno${seq}@office.iam.gserviceaccount.com`;
    fake.addCalendar(`private${seq}@group.calendar.google.com`, "Private", []);
    const res = await agent.put("/settings/connections/google-calendar").send({ serviceAccount: keyFile(email).json, calendar: `private${seq}@group.calendar.google.com` }).expect(400);
    expect(res.body.message).toContain(email);
  });
});

describe("Airtable, Notion and Trello", () => {
  it("Airtable: checks the shape and the table, never returns the token, and re-checks on test", async () => {
    const { agent } = await signedIn();
    fake.airtable.token = "patTESTTOKEN12345.0123456789abcdef0123456789abcdef";
    const good = { token: fake.airtable.token, baseId: fake.airtable.base, tableId: fake.airtable.table };
    await agent.put("/settings/connections/airtable").send({ ...good, token: "nope" }).expect(400);
    await agent.put("/settings/connections/airtable").send({ ...good, baseId: "base1" }).expect(400);
    await agent.put("/settings/connections/airtable").send({ ...good, extra: 1 }).expect(400);
    // A name the table answers to is still refused: a renamed table could be replaced by another with that name.
    fake.airtable.table = "Requests";
    await agent.put("/settings/connections/airtable").send({ ...good, tableId: "Requests" }).expect(400);
    fake.airtable.table = good.tableId;
    await agent.put("/settings/connections/airtable").send({ ...good, tableId: "tblOTHERTABLE0001" }).expect(400);
    await agent.put("/settings/connections/airtable").send({ ...good, token: "patTESTTOKEN12345.ffffffffffffffffffffffffffff" }).expect(400);
    const res = await agent.put("/settings/connections/airtable").send(good).expect(200);
    expect(res.body.connections[0]).toMatchObject({ provider: "airtable", status: "active", destination: { baseId: good.baseId, tableId: good.tableId } });
    expect(JSON.stringify(res.body)).not.toContain(good.token);
    expect((await agent.post("/settings/connections/airtable/test").expect(200)).body).toMatchObject({ ok: true });
    await agent.delete("/settings/connections/airtable").expect(204);
  });

  it("Notion: takes a database link, finds the title property, and adds a test page", async () => {
    const { agent } = await signedIn();
    fake.notion.token = "ntn_TESTTOKEN0123456789abcdefghijkl";
    const link = `https://www.notion.so/workspace/Office-requests-${fake.notion.database}?v=abc`;
    await agent.put("/settings/connections/notion").send({ token: fake.notion.token, database: "not a database" }).expect(400);
    await agent.put("/settings/connections/notion").send({ token: fake.notion.token, database: "f".repeat(32) }).expect(400);
    const res = await agent.put("/settings/connections/notion").send({ token: fake.notion.token, database: link }).expect(200);
    expect(res.body.connections[0]).toMatchObject({ provider: "notion", account: "Office requests", destination: { databaseId: fake.notion.database, titleProperty: "Name" } });
    expect(JSON.stringify(res.body)).not.toContain(fake.notion.token);
    const before = fake.notion.pages.length;
    expect((await agent.post("/settings/connections/notion/test").expect(200)).body).toMatchObject({ ok: true });
    expect(fake.notion.pages.length).toBe(before + 1);
  });

  it("Trello: saves key and token as one secret and adds a test card", async () => {
    const { agent } = await signedIn();
    Object.assign(fake.trello, { key: "0123456789abcdef0123456789abcdef", token: "ATTAtesttoken0123456789abcdefghijklmnop" });
    const good = { key: fake.trello.key, token: fake.trello.token, listId: fake.trello.list };
    await agent.put("/settings/connections/trello").send({ ...good, key: "short" }).expect(400);
    await agent.put("/settings/connections/trello").send({ ...good, listId: "ffffffffffffffffffffffff" }).expect(400);
    await agent.put("/settings/connections/trello").send({ ...good, token: "ATTAwrongtoken0123456789abcdefghijklmn" }).expect(400);
    const res = await agent.put("/settings/connections/trello").send(good).expect(200);
    expect(res.body.connections[0]).toMatchObject({ provider: "trello", account: "@daloy_tester", destination: { listId: good.listId, listName: "To do" } });
    expect(JSON.stringify(res.body)).not.toContain(good.token);
    const before = fake.trello.cards.length;
    expect((await agent.post("/settings/connections/trello/test").expect(200)).body).toMatchObject({ ok: true });
    expect(fake.trello.cards.length).toBe(before + 1);
  });
});

describe("Slack", () => {
  it("connects with a bot token, lists channels, saves the chosen one and posts a test message", async () => {
    const { agent } = await signedIn();
    fake.slack.token = `xoxb-${seq}-1111111111-abcdefabcdef`;
    await agent.put("/settings/connections/slack").send({ token: "xoxb-wrong-0000000000-zzzz" }).expect(400);
    const res = await agent.put("/settings/connections/slack").send({ token: fake.slack.token }).expect(200);
    expect(res.body.connections[0]).toMatchObject({ provider: "slack", status: "active", account: "Lim Dental", destination: null });
    expect(JSON.stringify(res.body)).not.toContain(fake.slack.token);

    const channels = await agent.get("/settings/connections/slack/channels").expect(200);
    expect(channels.body).toEqual([{ id: "C0REQ", name: "office-requests", isMember: true }]);
    await agent.put("/settings/connections/slack/channel").send({ channelId: "C0NOPE" }).expect(400);
    await agent.put("/settings/connections/slack/channel").send({ channelId: "C0REQ" }).expect(204);

    const before = fake.slack.messages.length;
    expect((await agent.post("/settings/connections/slack/test").expect(200)).body).toMatchObject({ ok: true, channel: "C0REQ" });
    expect(fake.slack.messages.length).toBe(before + 1);

    await agent.delete("/settings/connections/slack").expect(204);
    expect((await agent.get("/settings/connections").expect(200)).body.connections).toEqual([]);
    await agent.delete("/settings/connections/slack").expect(404);
  });

  it("keeps connection settings behind sign-in", async () => {
    await request(server).get("/settings/connections").expect(401);
    await request(server).put("/settings/connections/slack").send({ token: "xoxb-1-2-3" }).expect(401);
  });
});

describe("turning on and retrying", () => {
  it("refuses to turn on an office request that posts to Slack while Slack is not connected", async () => {
    const { agent } = await signedIn();
    const wf = (await agent.post("/workflows").send({ name: "Office requests", slug: `office-${seq}` }).expect(201)).body as { id: string };
    const definition = officeRequestDefinition({ ...defaultAnswers("office@example.com"), slack: true });
    const res = await agent.post(`/workflows/${wf.id}/versions`).send({ definition, publish: true }).expect(400);
    expect(res.body.message).toMatch(/connect slack/i);
    // Saving a draft is fine; only turning it on needs the connection.
    await agent.post(`/workflows/${wf.id}/versions`).send({ definition, publish: false }).expect(201);
  });

  it("lists each request's deliveries, and lets only the owner retry one", async () => {
    const { agent, userId } = await signedIn();
    const other = await signedIn();
    const wf = (await agent.post("/workflows").send({ name: "Office requests", slug: `office-${seq}` }).expect(201)).body as { id: string };
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf.id, version: 9, definition: {} }).returning();
    const [run] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
    await db.insert(requests).values({ userId, workflowId: wf.id, runId: run!.id, reference: `REQ-T${seq}`, submissionKey: randomUUID(), subject: "Printer jammed" });
    const d = await queueDelivery(db, { userId, runId: run!.id, stepId: "post_to_slack", provider: "slack", reference: `REQ-T${seq}`, payload: { text: "hi" } });
    await db.update(deliveries).set({ state: "failed", lastError: "Slack is not connected." }).where(eq(deliveries.id, d.id));

    const list = await agent.get(`/workflows/${wf.id}/requests`).expect(200);
    expect(list.body[0].deliveries).toEqual([expect.objectContaining({ id: d.id, provider: "slack", state: "failed", lastError: "Slack is not connected." })]);
    expect(JSON.stringify(list.body)).not.toContain('"payload"');

    await other.agent.post(`/deliveries/${d.id}/retry`).send({}).expect(404);
    await agent.post(`/deliveries/${d.id}/retry`).send({}).expect(204);
    await agent.post(`/deliveries/${d.id}/retry`).send({}).expect(409); // already queued
    await agent.post(`/deliveries/${d.id}/confirm`).expect(409); // only a delivery that needs review can be marked posted
    expect((await db.select().from(deliveries).where(eq(deliveries.id, d.id)))[0]!.state).toBe("queued");
    await agent.get(`/deliveries?runId=${run!.id}`).expect(200);
    await other.agent.get(`/deliveries?runId=${run!.id}`).expect(200).expect([]);

    // Once the run's booking moved on (decision 0032), Retry is refused and says why.
    const [res] = await db.insert(resources).values({ userId, name: `Chair ${seq}` }).returning();
    const [b] = await db
      .insert(bookings)
      .values({ userId, test: false, reference: `B-T${seq}`, resourceId: res!.id, during: sql`tstzrange(now(), now() + interval '1 hour')` as unknown as string, timezone: "Asia/Manila", version: 2 })
      .returning();
    await db.update(runs).set({ bookingId: b!.id, bookingVersion: 1 }).where(eq(runs.id, run!.id));
    await db.update(deliveries).set({ state: "failed" }).where(eq(deliveries.id, d.id));
    const refused = await agent.post(`/deliveries/${d.id}/retry`).send({ postAgain: true }).expect(409);
    expect(refused.body.message).toBe(BOOKING_CHANGED);
    await other.agent.post(`/deliveries/${d.id}/retry`).send({}).expect(404);
  });

  it("answers 404 for an unknown delivery and 400 for a malformed id", async () => {
    const { agent } = await signedIn();
    await agent.post(`/deliveries/00000000-0000-0000-0000-000000000000/retry`).send({}).expect(404);
    await agent.post(`/deliveries/not-a-uuid/retry`).send({}).expect(400);
  });
});

describe("UniSMS", () => {
  it("saves Secret Key encrypted and Sender ID, never returns the key, sends a test SMS, charges quota, redacts errors, and disconnects", async () => {
    const { agent, userId } = await signedIn();
    // Give the workspace a paid plan so SMS quota allows sending (preview has sms: 0).
    await db.update(users).set({ plan: "pilot", planStartedOn: "2026-11-01" }).where(eq(users.id, userId));
    const secretKey = `unisms_synth_api_key_${seq}_abcd`; // gitleaks:allow
    fake.unisms.secretKey = secretKey;
    fake.unisms.messages.length = 0;

    // Invalid Sender ID or missing key is refused.
    await agent.put("/settings/connections/unisms").send({ secretKey: "short" }).expect(400);
    await agent.put("/settings/connections/unisms").send({ secretKey, senderId: "Bad!SenderID" }).expect(400);

    const saved = await agent.put("/settings/connections/unisms").send({ secretKey, senderId: "LimDental" }).expect(200);
    expect(saved.body.connections).toEqual([expect.objectContaining({ provider: "unisms", status: "active", destination: { senderId: "LimDental" } })]);
    expect(JSON.stringify(saved.body)).not.toContain(secretKey);
    const [row] = await db.select().from(connections).where(eq(connections.userId, userId));
    expect(JSON.stringify(row)).not.toContain(secretKey);

    // Invalid phone number on test is refused with 400.
    await agent.post("/settings/connections/unisms/test").send({ to: "+14155550100" }).expect(400);

    // Valid PH number sends one test SMS and counts 1 sms unit in /usage.
    const test = await agent.post("/settings/connections/unisms/test").send({ to: "09171234567" }).expect(200);
    expect(test.body).toMatchObject({ ok: true, recipient: "+639171234567", senderId: "LimDental" });
    expect(fake.unisms.messages).toHaveLength(1);
    const usage = await agent.get("/usage").expect(200);
    expect(usage.body.sms).toMatchObject({ used: 1, limit: 50 });

    // Error echoing secret is redacted through historyHider, and 401 marks connection failed.
    fake.once("/api/sms", { status: 400, body: { error: `rejected ${secretKey}` } });
    const bad = await agent.post("/settings/connections/unisms/test").send({ to: "+639171234567" }).expect(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).not.toContain(secretKey);

    fake.once("/api/sms", { status: 401, body: { error: "unauthorized" } });
    const unauth = await agent.post("/settings/connections/unisms/test").send({ to: "+639171234567" }).expect(200);
    expect(unauth.body.ok).toBe(false);
    const after401 = await agent.get("/settings/connections").expect(200);
    expect(after401.body.connections).toEqual([expect.objectContaining({ provider: "unisms", status: "failed" })]);
    // Definite rejections (400 and 401) refund the test SMS quota claim so used stays at 1 (M2).
    const usageAfterRejections = await agent.get("/usage").expect(200);
    expect(usageAfterRejections.body.sms).toMatchObject({ used: 1, limit: 50 });

    // Disconnect via DELETE /settings/connections/unisms.
    await agent.delete("/settings/connections/unisms").expect(204);
    const afterDel = await agent.get("/settings/connections").expect(200);
    expect(afterDel.body.connections).toEqual([]);

    // Disconnecting UniSMS permanently opts the workspace out of shared operator fallback until reconnected (H1).
    const prevShared = {
      SHARED_UNISMS_KEY: process.env.SHARED_UNISMS_KEY,
      UNISMS_SECRET_KEY: process.env.UNISMS_SECRET_KEY,
      UNISMS_SENDER_ID: process.env.UNISMS_SENDER_ID,
    };
    try {
      process.env.SHARED_UNISMS_KEY = "open";
      process.env.UNISMS_SECRET_KEY = "unisms_synth_shared_op_key"; // gitleaks:allow
      process.env.UNISMS_SENDER_ID = "Daloy";
      const wf = (await agent.post("/workflows").send({ name: "SMS Alert", slug: `sms-alert-${seq}` }).expect(201)).body as { id: string };
      const smsDef = {
        trigger: { type: "manual", config: {} },
        steps: [{ id: "send_sms", type: "sms", config: { to: "+639171234567", message: "Alert" } }],
        edges: [],
      };
      await agent.post(`/workflows/${wf.id}/versions`).send({ definition: smsDef, publish: true }).expect(400);
    } finally {
      for (const [k, v] of Object.entries(prevShared)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("blocks test SMS with 429 on preview plan (sms: 0)", async () => {
    const { agent, userId } = await signedIn();
    await db.update(users).set({ plan: "preview", planStartedOn: "2026-11-01" }).where(eq(users.id, userId));
    const secretKey = `unisms_synth_prev_key_${seq}_abcd`; // gitleaks:allow
    fake.unisms.secretKey = secretKey;
    fake.unisms.messages.length = 0;
    await agent.put("/settings/connections/unisms").send({ secretKey }).expect(200);
    await agent.post("/settings/connections/unisms/test").send({ to: "09171234567" }).expect(429);
    expect(fake.unisms.messages).toHaveLength(0);
  });
});
