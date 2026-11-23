import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connections, readUpload, runDueDeliveries, runs, uploads, users, workflowVersions, type Db } from "@daloy/db";
import type { FileRef } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createExecutor } from "../../worker/src/steps";
import { createApp } from "./app";

const PAGE_ID = "100200300400";
const IG_ID = "900800700600";
const PAGE_TOKEN = "meta_api_page_token_synthetic_001"; // gitleaks:allow
const APP_SECRET = "meta_api_app_secret_synthetic_001"; // gitleaks:allow
const VERIFY_TOKEN = "meta_api_verify_token_synthetic_001"; // gitleaks:allow
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let aiServer: Server;
let seq = 0;
const secretsKey = randomBytes(32);
const aiResponseJson = JSON.stringify({
  is_receipt: "yes",
  provider: "GCash",
  reference: "1002-5555-8888",
  amount: "500.00",
  sender_name: "Maria Santos",
  date: "2026-11-20",
});

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  aiServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { role: "assistant", content: aiResponseJson }, prompt_eval_count: 10, eval_count: 20 }));
    });
  });
  await new Promise<void>((r) => aiServer.listen(0, "127.0.0.1", r));
  vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${(aiServer.address() as AddressInfo).port}`);
  vi.stubEnv("LLM_VISION", "on");

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
  vi.unstubAllEnvs();
  aiServer?.closeAllConnections();
  aiServer?.close();
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

beforeEach(() => {
  fake.meta.token = PAGE_TOKEN;
  fake.meta.pageId = PAGE_ID;
  fake.meta.pageName = "Sari-Sari ni Ana";
  fake.meta.revoked = false;
  fake.meta.messages.length = 0;
  fake.meta.cdnFiles.clear();
  fake.meta.cdnFiles.set("receipt.png", { contentType: "image/png", data: PNG_BYTES });
  fake.meta.cdnFiles.set("fake.png", { contentType: "image/png", data: Buffer.from("<html><body>bad</body></html>") });
  fake.meta.cdnFiles.set("huge.png", { contentType: "image/png", data: Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024 + 32, 1)]) });
});

type Agent = ReturnType<typeof request.agent>;

async function owner() {
  const email = `meta-api-${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201); // gitleaks:allow
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id };
}

async function connectMeta(agent: Agent, userId: string, overrides: Record<string, unknown> = {}) {
  const res = await agent
    .put("/settings/connections/meta-messenger")
    .send({
      pageId: PAGE_ID,
      instagramAccountId: IG_ID,
      pageAccessToken: PAGE_TOKEN,
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      ...overrides,
    })
    .expect(200);
  const [c] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, "meta_messenger")));
  return { res: res.body, webhookPath: (c!.destination as { webhookPath: string }).webhookPath };
}

async function publishMetaWorkflow(agent: Agent, triggerConfig: { channel?: "messenger" | "instagram" | "both"; requireImage?: boolean } = {}, steps?: unknown[], edges?: unknown[]) {
  const wf = await agent.post("/workflows").send({ name: `Meta WF ${++seq}`, slug: `meta-wf-${seq}` }).expect(201);
  const definition = {
    trigger: { type: "meta_dm", config: triggerConfig },
    steps: steps ?? [{ id: "reply", type: "meta_reply", config: { text: "Got it: {{trigger.text}}" } }],
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

describe("Meta connection settings and secret redaction", () => {
  it("connects, preserves webhookPath across updates, tests, disconnects, and never echoes secrets", async () => {
    const o = await owner();
    const first = await connectMeta(o.agent, o.userId);
    expect(first.res.status).toBe("active");
    expect(first.res.webhookUrl).toBe(`https://daloy.test/hooks/meta/${first.webhookPath}`);
    expect(JSON.stringify(first.res)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(first.res)).not.toContain(APP_SECRET);
    expect(JSON.stringify(first.res)).not.toContain(VERIFY_TOKEN);

    // Re-saving preserves the exact webhookPath.
    const second = await connectMeta(o.agent, o.userId);
    expect(second.webhookPath).toBe(first.webhookPath);

    // Mismatched Page ID on save is rejected with 400 (M5).
    await o.agent
      .put("/settings/connections/meta-messenger")
      .send({
        pageId: "999999999999",
        pageAccessToken: PAGE_TOKEN,
        appSecret: APP_SECRET,
        verifyToken: VERIFY_TOKEN,
      })
      .expect(400);

    // Test endpoint succeeds.
    const tested = await o.agent.post("/settings/connections/meta-messenger/test").expect(200);
    expect(tested.body).toMatchObject({ ok: true, pageId: PAGE_ID, pageName: "Sari-Sari ni Ana" });

    // Mismatched Page ID on test marks connection failed (M5).
    fake.once("/v21.0/me", { status: 200, body: { id: "888888888888", name: "Other Page" } });
    const mismatchTest = await o.agent.post("/settings/connections/meta-messenger/test").expect(200);
    expect(mismatchTest.body.ok).toBe(false);
    await connectMeta(o.agent, o.userId);

    // Even if Meta returns an error echoing the token, test and settings redact it.
    fake.once("/v21.0/me", { status: 401, body: { error: { code: 190, message: `Bad token ${PAGE_TOKEN}` } } });
    const badTest = await o.agent.post("/settings/connections/meta-messenger/test").expect(200);
    expect(badTest.body.ok).toBe(false);
    expect(JSON.stringify(badTest.body)).not.toContain(PAGE_TOKEN);

    const listed = await o.agent.get("/settings/connections").expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(listed.body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(listed.body)).not.toContain(VERIFY_TOKEN);

    await o.agent.delete("/settings/connections/meta-messenger").expect(204);
  });
});

describe("Meta webhook challenge verification and HMAC intake", () => {
  it("answers hub.challenge as text/plain on valid verify token and 403 otherwise", async () => {
    const o = await owner();
    const { webhookPath } = await connectMeta(o.agent, o.userId);

    const ok = await request(server)
      .get(`/hooks/meta/${webhookPath}`)
      .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "challenge_12345" })
      .expect(200);
    expect(ok.headers["content-type"]).toContain("text/plain");
    expect(ok.text).toBe("challenge_12345");

    await request(server)
      .get(`/hooks/meta/${webhookPath}`)
      .query({ "hub.mode": "subscribe", "hub.verify_token": "wrong_token", "hub.challenge": "challenge_12345" })
      .expect(403);

    await request(server)
      .get(`/hooks/meta/${webhookPath}`)
      .query({ "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "challenge_12345" })
      .expect(403);

    await request(server)
      .get("/hooks/meta/unknown-path-does-not-exist")
      .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "challenge_12345" })
      .expect(403);
  });

  it("rejects missing or tampered X-Hub-Signature-256 and ignores echoes, receipts, and wrong pageId", async () => {
    const o = await owner();
    const { webhookPath } = await connectMeta(o.agent, o.userId);
    const wfId = await publishMetaWorkflow(o.agent, { channel: "both", requireImage: false });

    const payload = JSON.stringify({
      object: "page",
      entry: [{ id: PAGE_ID, messaging: [{ sender: { id: "psid-1" }, timestamp: 1700000000000, message: { mid: "m_bad_sig", text: "hi" } }] }],
    });

    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").send(payload).expect(401);
    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(payload, "wrong")).send(payload).expect(401);

    const ignored = JSON.stringify({
      object: "page",
      entry: [
        { id: "other_page", messaging: [{ sender: { id: "psid-x" }, timestamp: 1700000000001, message: { mid: "m_wrong_page", text: "hi" } }] },
        {
          id: PAGE_ID,
          messaging: [
            { sender: { id: "psid-echo" }, timestamp: 1700000000002, message: { mid: "m_echo", is_echo: true, text: "my echo" } },
            { sender: { id: "psid-dlv" }, timestamp: 1700000000003, delivery: { mids: ["m_1"] } },
          ],
        },
      ],
    });
    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(ignored)).send(ignored).expect(200);
    expect(await runsOf(wfId)).toHaveLength(0);
  });

  it("deduplicates concurrent duplicate webhooks by mid into a single run and supports Instagram DMs", async () => {
    const o = await owner();
    const { webhookPath } = await connectMeta(o.agent, o.userId);
    const messengerWf = await publishMetaWorkflow(o.agent, { channel: "messenger", requireImage: false });
    const igWf = await publishMetaWorkflow(o.agent, { channel: "instagram", requireImage: false });

    const msgBody = JSON.stringify({
      object: "page",
      entry: [{ id: PAGE_ID, messaging: [{ sender: { id: "psid-race" }, timestamp: 1700000001000, message: { mid: "m_race_1", text: "Order 1" } }] }],
    });
    const sig = sign(msgBody);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sig).send(msgBody).expect(200),
      ),
    );
    expect(await runsOf(messengerWf)).toHaveLength(1);
    expect(await runsOf(igWf)).toHaveLength(0);

    const igBody = JSON.stringify({
      object: "instagram",
      entry: [{ id: IG_ID, messaging: [{ sender: { id: "igsid-1" }, timestamp: 1700000002000, message: { mid: "m_ig_1", text: "IG order" } }] }],
    });
    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(igBody)).send(igBody).expect(200);
    expect(await runsOf(igWf)).toHaveLength(1);
  });

  it("downloads verified receipt images to uploads, rejects bad images/non-Meta hosts, runs AI vision with duplicate-ref flagging, and redacts secrets on read", async () => {
    const o = await owner();
    const { webhookPath } = await connectMeta(o.agent, o.userId);
    const wfId = await publishMetaWorkflow(
      o.agent,
      { channel: "both", requireImage: true },
      [
        {
          id: "read_receipt",
          type: "ai",
          config: {
            task: "extract",
            input: "{{trigger.text}}",
            files: ["image"],
            fields: {
              is_receipt: "yes or no",
              provider: "GCash or bank",
              reference: "Reference number",
              amount: "Amount",
              sender_name: "Sender",
              date: "Date",
            },
          },
        },
        { id: "reply", type: "meta_reply", config: { text: "Received {{steps.read_receipt.output.reference}}" } },
      ],
      [{ from: "read_receipt", to: "reply" }],
    );

    // 1. Non-Meta URL and fake HTML-as-PNG are rejected -> requireImage workflow starts 0 runs.
    const badImgs = JSON.stringify({
      object: "page",
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            {
              sender: { id: "psid-bad" },
              timestamp: 1700000003000,
              message: {
                mid: "m_bad_img",
                text: "receipt",
                attachments: [
                  { type: "image", payload: { url: "https://evil.example/steal.png" } },
                  { type: "image", payload: { url: `${fake.urls.metaCdn}/meta-cdn/fake.png` } },
                  { type: "image", payload: { url: `${fake.urls.metaCdn}/meta-cdn/huge.png` } },
                ],
              },
            },
          ],
        },
      ],
    });
    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(badImgs)).send(badImgs).expect(200);
    expect(await runsOf(wfId)).toHaveLength(0);

    // 2. Valid receipt PNG is downloaded, stored in uploads, referenced only by metadata in triggerPayload, and readable by AI vision.
    const goodBody = (mid: string, text: string) =>
      JSON.stringify({
        object: "page",
        entry: [
          {
            id: PAGE_ID,
            messaging: [
              {
                sender: { id: "psid-good" },
                timestamp: Date.now(),
                message: {
                  mid,
                  text,
                  attachments: [{ type: "image", payload: { url: `${fake.urls.metaCdn}/meta-cdn/receipt.png` } }],
                },
              },
            ],
          },
        ],
      });

    const body1 = goodBody("m_receipt_1", `Paid! token leak test ${PAGE_TOKEN} ${APP_SECRET} ${VERIFY_TOKEN}`);
    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(body1)).send(body1).expect(200);
    const list1 = await runsOf(wfId);
    expect(list1).toHaveLength(1);
    const run1 = list1[0]!;
    const payload1 = run1.triggerPayload as { image: FileRef[]; channel: string; senderId: string; messageId: string };
    expect(payload1.channel).toBe("messenger");
    expect(payload1.senderId).toBe("psid-good");
    expect(payload1.image).toHaveLength(1);
    expect(Object.keys(payload1.image[0]!).sort()).toEqual(["id", "name", "size", "type"]);
    const stored = await readUpload(db, { userId: o.userId, runId: run1.id, id: payload1.image[0]!.id });
    expect(stored?.data.equals(PNG_BYTES)).toBe(true);

    // Read-side redaction hides all three Meta secrets from GET /runs/:id!
    const runRead = await o.agent.get(`/runs/${run1.id}`).expect(200);
    expect(JSON.stringify(runRead.body)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(runRead.body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(runRead.body)).not.toContain(VERIFY_TOKEN);

    // Run the AI vision step on run1 -> not a duplicate reference.
    const exec = createExecutor({ db, secretsKey, mail: {} as never });
    const aiStep = {
      id: "read_receipt",
      type: "ai",
      config: {
        task: "extract",
        input: "{{trigger.text}}",
        files: ["image"],
        fields: { is_receipt: "yes or no", provider: "GCash or bank", reference: "Reference number", amount: "Amount", sender_name: "Sender", date: "Date" },
      },
    } as never;
    const out1 = await exec.execute({
      runId: run1.id,
      stepRunId: "00000000-0000-0000-0000-000000000001",
      userId: o.userId,
      workflowId: wfId,
      attempt: 1,
      idempotencyKey: `${run1.id}:read_receipt`,
      step: aiStep,
      ctx: { trigger: payload1, steps: {} },
      fileFields: ["image"],
    });
    expect((out1.output as Record<string, unknown>).duplicate_reference).toBe("no");

    // Second message with a DIFFERENT mid but the SAME receipt reference flags duplicate_reference = "yes"!
    const body2 = goodBody("m_receipt_2", "Same receipt sent again");
    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(body2)).send(body2).expect(200);
    const list2 = await runsOf(wfId);
    expect(list2).toHaveLength(2);
    const run2 = list2.find((r) => r.id !== run1.id)!;
    const out2 = await exec.execute({
      runId: run2.id,
      stepRunId: "00000000-0000-0000-0000-000000000002",
      userId: o.userId,
      workflowId: wfId,
      attempt: 1,
      idempotencyKey: `${run2.id}:read_receipt`,
      step: aiStep,
      ctx: { trigger: run2.triggerPayload, steps: {} },
      fileFields: ["image"],
    });
    expect((out2.output as Record<string, unknown>).duplicate_reference).toBe("yes");
    expect(String((out2.output as Record<string, unknown>).duplicate_warning)).toContain("already seen");

    // meta_reply mocked in mock mode makes zero external calls; live queues and delivers!
    const replyStep = { id: "reply", type: "meta_reply", config: { recipientId: "{{trigger.senderId}}", channel: "{{trigger.channel}}", text: "Verified!" } } as never;
    const mocked = await exec.execute({
      runId: run1.id,
      stepRunId: "00000000-0000-0000-0000-000000000003",
      userId: o.userId,
      workflowId: wfId,
      attempt: 1,
      idempotencyKey: `${run1.id}:reply:mock`,
      step: replyStep,
      ctx: { trigger: payload1, steps: {} },
      mock: true,
    });
    expect((mocked.output as Record<string, unknown>).mocked).toBe(true);
    expect(fake.meta.messages).toHaveLength(0);

    // From run2: the guest's second message superseded run1, so only the newer run replies (decision 0115).
    await exec.execute({
      runId: run2.id,
      stepRunId: "00000000-0000-0000-0000-000000000004",
      userId: o.userId,
      workflowId: wfId,
      attempt: 1,
      idempotencyKey: `${run2.id}:reply:live`,
      step: replyStep,
      ctx: { trigger: run2.triggerPayload, steps: {} },
      mock: false,
    });
    await runDueDeliveries(db, secretsKey, fake.urls);
    expect(fake.meta.messages).toHaveLength(1);
    expect(fake.meta.messages[0]).toMatchObject({ recipientId: "psid-good" });
    // The first reply of the conversation carries the privacy notice in front.
    expect(fake.meta.messages[0]!.text).toMatch(/automated assistant[\s\S]*\n\nVerified!$/);
    expect((await db.select().from(uploads).where(eq(uploads.userId, o.userId))).length).toBe(2);

    // Paused workflow starts no new run on webhook intake (returns 200 without creating a run).
    await o.agent.post(`/workflows/${wfId}/pause`).expect(204);
    const bodyPaused = goodBody("m_receipt_paused", "Sent while paused");
    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(bodyPaused)).send(bodyPaused).expect(200);
    expect(await runsOf(wfId)).toHaveLength(2);
    await o.agent.post(`/workflows/${wfId}/resume`).expect(204);

    // 3. Transient CDN 503 answers HTTP 503 so Meta retries without losing the mid to run_keys (M7).
    fake.once("/meta-cdn/receipt.png", { status: 503, body: { error: "cdn_down" } });
    const bodyTransient = goodBody("m_receipt_transient", "Retry me after CDN outage");
    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(bodyTransient)).send(bodyTransient).expect(503);
    expect(await runsOf(wfId)).toHaveLength(2);
    // Retrying the exact same webhook after CDN recovers now succeeds and creates the run.
    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(bodyTransient)).send(bodyTransient).expect(200);
    expect(await runsOf(wfId)).toHaveLength(3);

    // 4. meta_reply refuses a recipient or channel mismatch against the incoming trigger conversation (M6).
    const badRecipientStep = { id: "reply_bad", type: "meta_reply", config: { recipientId: "psid-other", channel: "{{trigger.channel}}", text: "Wrong recipient" } } as never;
    await expect(
      exec.execute({
        runId: run1.id,
        stepRunId: "00000000-0000-0000-0000-000000000005",
        userId: o.userId,
        workflowId: wfId,
        attempt: 1,
        idempotencyKey: `${run1.id}:reply:bad`,
        step: badRecipientStep,
        ctx: { trigger: payload1, steps: {} },
        mock: false,
      }),
    ).rejects.toThrow(/recipient must match/i);

    // 5. After disconnecting Meta, GET /runs/:id still redacts all three retired Meta secrets (M8).
    await o.agent.delete("/settings/connections/meta-messenger").expect(204);
    const runReadAfterDisconnect = await o.agent.get(`/runs/${run1.id}`).expect(200);
    expect(JSON.stringify(runReadAfterDisconnect.body)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(runReadAfterDisconnect.body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(runReadAfterDisconnect.body)).not.toContain(VERIFY_TOKEN);
  });

  it("does not touch receipt_references on unrelated AI file extractions without is_receipt (L2)", async () => {
    const o = await owner();
    const { webhookPath } = await connectMeta(o.agent, o.userId);
    const wfId = await publishMetaWorkflow(o.agent, { channel: "both", requireImage: true });
    const body = JSON.stringify({
      object: "page",
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            {
              sender: { id: "psid-invoice" },
              timestamp: Date.now(),
              message: {
                mid: "m_unrelated_extract",
                text: "invoice",
                attachments: [{ type: "image", payload: { url: `${fake.urls.metaCdn}/meta-cdn/receipt.png` } }],
              },
            },
          ],
        },
      ],
    });
    await request(server).post(`/hooks/meta/${webhookPath}`).set("content-type", "application/json").set("x-hub-signature-256", sign(body)).send(body).expect(200);
    const [run] = await runsOf(wfId);
    const exec = createExecutor({ db, secretsKey, mail: {} as never });
    const nonReceiptAiStep = {
      id: "extract_invoice",
      type: "ai",
      config: {
        task: "extract",
        input: "{{trigger.text}}",
        files: ["image"],
        fields: { reference: "Invoice reference", amount: "Amount" },
      },
    } as never;
    const out = await exec.execute({
      runId: run!.id,
      stepRunId: "00000000-0000-0000-0000-000000000009",
      userId: o.userId,
      workflowId: wfId,
      attempt: 1,
      idempotencyKey: `${run!.id}:extract_invoice`,
      step: nonReceiptAiStep,
      ctx: { trigger: run!.triggerPayload, steps: {} },
      fileFields: ["image"],
    });
    expect((out.output as Record<string, unknown>).duplicate_reference).toBeUndefined();
  });
});
