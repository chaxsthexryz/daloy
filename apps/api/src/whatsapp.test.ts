import { createHmac, randomBytes } from "node:crypto";
import { connections, conversations, paymentClaims, paymentDues, readUpload, runDueDeliveries, runs, users, workflowVersions, type Db } from "@daloy/db";
import type { FileRef } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createExecutor } from "../../worker/src/steps";
import { createApp } from "./app";

const PHONE_NUMBER_ID = "9988776655";
const WABA_ID = "1122334455";
const ACCESS_TOKEN = "wa_system_user_token_synthetic_api_001"; // gitleaks:allow
const APP_SECRET = "wa_app_secret_synthetic_api_001"; // gitleaks:allow
const VERIFY_TOKEN = "wa_verify_token_synthetic_api_001"; // gitleaks:allow
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let seq = 0;
const secretsKey = randomBytes(32);

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  app = await createApp({
    db,
    boss,
    secretsKey,
    secureCookies: false,
    publicUrl: "https://daloy.test",
    providers: { ...fake.urls, timeoutMs: 2000 },
  });
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
  fake.whatsapp.token = ACCESS_TOKEN;
  fake.whatsapp.phoneNumberId = PHONE_NUMBER_ID;
  fake.whatsapp.displayPhone = "+63 917 000 0999";
  fake.whatsapp.verifiedName = "kymavo Resort";
  fake.whatsapp.revoked = false;
  fake.whatsapp.messages.length = 0;
  fake.whatsapp.media.clear();
  fake.meta.cdnFiles.set("wa-receipt.png", { contentType: "image/png", data: PNG_BYTES });
  fake.whatsapp.media.set("wa-media-1", { url: `${fake.urls.metaCdn}/meta-cdn/wa-receipt.png` });
});

type Agent = ReturnType<typeof request.agent>;

async function owner() {
  const email = `wa-api-${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201); // gitleaks:allow
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id };
}

async function connectWhatsApp(agent: Agent, userId: string, overrides: Record<string, unknown> = {}) {
  const res = await agent
    .put("/settings/connections/whatsapp")
    .send({
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
      accessToken: ACCESS_TOKEN,
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      ...overrides,
    })
    .expect(200);
  const [c] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, "whatsapp")));
  return { res: res.body, webhookPath: (c!.destination as { webhookPath: string }).webhookPath };
}

async function publishWhatsAppWorkflow(agent: Agent, triggerConfig: { requireImage?: boolean } = {}, steps?: unknown[], edges?: unknown[]) {
  const wf = await agent.post("/workflows").send({ name: `WA WF ${++seq}`, slug: `wa-wf-${seq}` }).expect(201);
  const definition = {
    trigger: { type: "whatsapp_message", config: triggerConfig },
    steps: steps ?? [{ id: "reply", type: "whatsapp_reply", config: { mode: "text", to: "{{trigger.senderId}}", text: "Got it: {{trigger.text}}" } }],
    edges: edges ?? [],
  };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  return wf.body.id as string;
}

const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const runsOf = async (workflowId: string) => {
  const vs = await db.select({ id: workflowVersions.id }).from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId));
  return db.select().from(runs).where(inArray(runs.workflowVersionId, vs.map((v) => v.id)));
};

const whatsappWebhookBody = (message: Record<string, unknown>, from = "639171234567", name = "Ana Reyes") =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ wa_id: from, profile: { name } }],
              messages: [{ from, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
            },
          },
        ],
      },
    ],
  });

describe("WhatsApp connection settings, challenge, HMAC webhook and reply window", () => {
  it("connects, tests, preserves webhookPath, redacts secrets, and verifies GET hub.challenge", async () => {
    const o = await owner();
    const first = await connectWhatsApp(o.agent, o.userId);
    expect(first.res.status).toBe("active");
    expect(first.res.webhookUrl).toBe(`https://daloy.test/hooks/whatsapp/${first.webhookPath}`);
    expect(JSON.stringify(first.res)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(first.res)).not.toContain(APP_SECRET);
    expect(JSON.stringify(first.res)).not.toContain(VERIFY_TOKEN);

    const second = await connectWhatsApp(o.agent, o.userId);
    expect(second.webhookPath).toBe(first.webhookPath);

    await o.agent
      .put("/settings/connections/whatsapp")
      .send({ phoneNumberId: "0000000", accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN })
      .expect(400);

    const tested = await o.agent.post("/settings/connections/whatsapp/test").expect(200);
    expect(tested.body).toMatchObject({ ok: true, phoneNumberId: PHONE_NUMBER_ID, displayPhone: "+63 917 000 0999" });

    const listed = await o.agent.get("/settings/connections").expect(200);
    expect(listed.body.whatsappWebhookBase).toBe("https://daloy.test/hooks/whatsapp");
    expect(JSON.stringify(listed.body)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(listed.body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(listed.body)).not.toContain(VERIFY_TOKEN);

    const ok = await request(server)
      .get(`/hooks/whatsapp/${first.webhookPath}`)
      .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "wa_challenge_123" })
      .expect(200);
    expect(ok.headers["content-type"]).toContain("text/plain");
    expect(ok.text).toBe("wa_challenge_123");

    await request(server)
      .get(`/hooks/whatsapp/${first.webhookPath}`)
      .query({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "wa_challenge_123" })
      .expect(403);

    await request(server)
      .get("/hooks/whatsapp/unknown-wa-path")
      .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "wa_challenge_123" })
      .expect(403);

    await o.agent.delete("/settings/connections/whatsapp").expect(204);
  });

  it("enforces X-Hub-Signature-256, deduplicates wamid replays, sends service replies with RA 10173 notice once, branches on paused & outside_window, and sends utility templates outside 24h", async () => {
    const o = await owner();
    const { webhookPath } = await connectWhatsApp(o.agent, o.userId);
    const wfId = await publishWhatsAppWorkflow(
      o.agent,
      { requireImage: false },
      [
        { id: "reply", type: "whatsapp_reply", config: { mode: "text", to: "{{trigger.senderId}}", text: "Hi {{trigger.senderName}}!" } },
        { id: "late", type: "whatsapp_reply", config: { mode: "template", to: "{{trigger.senderId}}", templateName: "deposit_reminder", templateLanguage: "en", templateParams: ["{{trigger.senderName}}"] } },
        { id: "paused_note", type: "delay", config: { seconds: 1 } },
      ],
      [
        { from: "reply", to: "late", on: "outside_window" },
        { from: "reply", to: "paused_note", on: "paused" },
      ],
    );

    const payload1 = whatsappWebhookBody({ id: "wamid.msg_1", type: "text", text: { body: "Available po?" } });
    await request(server).post(`/hooks/whatsapp/${webhookPath}`).set("content-type", "application/json").send(payload1).expect(401);
    await request(server).post(`/hooks/whatsapp/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(payload1, "wrong")).send(payload1).expect(401);

    await Promise.all(
      Array.from({ length: 4 }, () =>
        request(server).post(`/hooks/whatsapp/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(payload1)).send(payload1).expect(200),
      ),
    );
    const createdRuns = await runsOf(wfId);
    expect(createdRuns).toHaveLength(1);
    const run1 = createdRuns[0]!;
    const exec = createExecutor({ db, secretsKey, mail: {} as never });

    // Service reply inside 24h window delivers with RA 10173 notice first time.
    const replyStep = { id: "reply", type: "whatsapp_reply", config: { mode: "text", to: "{{trigger.senderId}}", text: "Hi {{trigger.senderName}}!" } } as never;
    const res1 = await exec.execute({
      runId: run1.id,
      stepRunId: "00000000-0000-0000-0000-000000000011",
      userId: o.userId,
      workflowId: wfId,
      attempt: 1,
      idempotencyKey: `${run1.id}:reply:1`,
      step: replyStep,
      ctx: { trigger: run1.triggerPayload, steps: {} },
      mock: false,
    });
    expect(res1.branch).toBeUndefined();
    await runDueDeliveries(db, secretsKey, fake.urls);
    expect(fake.whatsapp.messages).toHaveLength(1);
    expect(fake.whatsapp.messages[0]).toMatchObject({ to: "639171234567", type: "text" });
    expect(fake.whatsapp.messages[0]!.text).toMatch(/automated assistant[\s\S]*\n\nHi Ana Reyes!$/);

    // Take over conversation -> service reply takes "paused" branch.
    const [convo] = await db.select().from(conversations).where(and(eq(conversations.userId, o.userId), eq(conversations.channel, "whatsapp"), eq(conversations.externalId, "639171234567")));
    await o.agent.post(`/conversations/${convo!.id}/take-over`).expect(200);
    const payload2 = whatsappWebhookBody({ id: "wamid.msg_2", type: "text", text: { body: "Follow up" } });
    await request(server).post(`/hooks/whatsapp/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(payload2)).send(payload2).expect(200);
    const run2 = (await runsOf(wfId)).find((r) => r.id !== run1.id)!;
    const resPaused = await exec.execute({
      runId: run2.id,
      stepRunId: "00000000-0000-0000-0000-000000000012",
      userId: o.userId,
      workflowId: wfId,
      attempt: 1,
      idempotencyKey: `${run2.id}:reply:paused`,
      step: replyStep,
      ctx: { trigger: run2.triggerPayload, steps: {} },
      mock: false,
    });
    expect(resPaused.branch).toBe("paused");

    // Hand back and push lastInboundAt older than 24h -> service reply takes "outside_window", while utility template succeeds!
    await o.agent.post(`/conversations/${convo!.id}/hand-back`).expect(200);
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(conversations.id, convo!.id));
    const resOutside = await exec.execute({
      runId: run2.id,
      stepRunId: "00000000-0000-0000-0000-000000000013",
      userId: o.userId,
      workflowId: wfId,
      attempt: 1,
      idempotencyKey: `${run2.id}:reply:outside`,
      step: replyStep,
      ctx: { trigger: run2.triggerPayload, steps: {} },
      mock: false,
    });
    expect(resOutside.branch).toBe("outside_window");

    const tmplStep = {
      id: "late",
      type: "whatsapp_reply",
      config: { mode: "template", to: "{{trigger.senderId}}", templateName: "deposit_reminder", templateLanguage: "en", templateParams: ["{{trigger.senderName}}"] },
    } as never;
    await exec.execute({
      runId: run2.id,
      stepRunId: "00000000-0000-0000-0000-000000000014",
      userId: o.userId,
      workflowId: wfId,
      attempt: 1,
      idempotencyKey: `${run2.id}:late`,
      step: tmplStep,
      ctx: { trigger: run2.triggerPayload, steps: {} },
      mock: false,
    });
    await runDueDeliveries(db, secretsKey, fake.urls);
    expect(fake.whatsapp.messages).toHaveLength(2);
    expect(fake.whatsapp.messages[1]).toMatchObject({
      to: "639171234567",
      type: "template",
      template: { name: "deposit_reminder", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ana Reyes" }] }] },
    });
  });

  it("claims WhatsApp receipt images against an open due and exports/deletes guest data by phone under R6", async () => {
    const o = await owner();
    const { webhookPath } = await connectWhatsApp(o.agent, o.userId);
    const wfId = await publishWhatsAppWorkflow(o.agent, { requireImage: true });

    // Seed open pending conversation + due so inbound WhatsApp photo attaches a C6 claim.
    const [wfVersion] = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wfId));
    const [seedRun] = await db.insert(runs).values({ workflowVersionId: wfVersion!.id, triggerPayload: {} }).returning();
    const [due] = await db
      .insert(paymentDues)
      .values({ userId: o.userId, workflowId: wfId, runId: seedRun!.id, stepId: "due", reference: "RES-101", kind: "deposit", amountCentavos: 50_000, status: "pending", test: false, token: randomBytes(16).toString("base64url") })
      .returning();
    await db.insert(conversations).values({ userId: o.userId, channel: "whatsapp", externalId: "639171234567", openDueId: due!.id });

    const imgBody = whatsappWebhookBody({ id: "wamid.receipt_1", type: "image", image: { id: "wa-media-1", caption: "GCash ref 888999000 PHP 500" } });
    await request(server).post(`/hooks/whatsapp/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(imgBody)).send(imgBody).expect(200);
    // Replaying the same wamid neither creates a second run nor a second claim.
    await request(server).post(`/hooks/whatsapp/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(imgBody)).send(imgBody).expect(200);

    const created = (await runsOf(wfId)).filter((r) => r.id !== seedRun!.id);
    expect(created).toHaveLength(1);
    const payload = created[0]!.triggerPayload as { image: FileRef[]; claimId?: string; senderId: string };
    expect(payload.senderId).toBe("639171234567");
    expect(payload.image).toHaveLength(1);
    expect(payload.claimId).toBeTruthy();

    const stored = await readUpload(db, { userId: o.userId, runId: created[0]!.id, id: payload.image[0]!.id });
    expect(stored?.data.equals(PNG_BYTES)).toBe(true);

    const claims = await db.select().from(paymentClaims).where(and(eq(paymentClaims.userId, o.userId), eq(paymentClaims.sourceMid, "wamid.receipt_1")));
    expect(claims).toHaveLength(1);

    // R6: search/export/delete by local 0917... format finds and erases the WhatsApp conversation.
    const exported = await o.agent.post("/privacy/customer/export").send({ phone: "0917 123 4567" }).expect(200);
    expect(exported.body.conversations).toHaveLength(1);
    expect(exported.body.conversations[0]).toMatchObject({ channel: "whatsapp", externalId: "639171234567" });

    const deleted = await o.agent.post("/privacy/customer/delete").send({ phone: "0917 123 4567", confirm: "DELETE" }).expect(200);
    expect(deleted.body.counts.conversations).toBe(1);
    expect(await db.select().from(conversations).where(and(eq(conversations.userId, o.userId), eq(conversations.channel, "whatsapp")))).toHaveLength(0);
  });
});
