import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { bookings, connections, consumeFlow, conversationMessages, conversations, createDue, deliveries, ensureCalendar, finishFlow, googleCalendar, mailDeps, readUpload, resources, runDueDeliveries, runs, startFlow, telegramWebhookSecret, users, workflowVersions, type Db, type ProviderUrls } from "@daloy/db";
import { dayBounds, FILE_MAX_BYTES, StepError, TEMPLATES, type FileRef } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { advance } from "../../worker/src/advance";
import { createExecutor } from "../../worker/src/steps";
import { createApp } from "./app";

// nosemgrep: generic.secrets.security.detected-telegram-bot-api-key.detected-telegram-bot-api-key
const TOKEN = "123456789:AAsyntheticTelegramTokenForTests_0001"; // gitleaks:allow
const OWNER_CHAT = -1001234567890;
const STRANGER_CHAT = 777000111;
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex");
const PDF = Buffer.from("%PDF-1.4\n%synthetic\n");

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let providers: ProviderUrls;
let seq = 0;
const secretsKey = randomBytes(32);

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  const googleApp = fake.addOAuthApp("google", { rotation: "none" });
  providers = { ...fake.urls, timeoutMs: 2000, googleOAuth: { clientId: googleApp.clientId, clientSecret: googleApp.clientSecret, ...fake.oauthUrls("google") } };
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "https://daloy.test", providers });
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
  fake.telegram.token = TOKEN;
  fake.telegram.revoked = false;
  fake.telegram.webhook = false;
  fake.telegram.webhookUrl = "";
  fake.telegram.webhookSecret = "";
  fake.telegram.messages.length = 0;
  fake.telegram.files.clear();
  fake.telegram.files.set("photo-ok", { path: "photos/file_1.jpg", data: JPEG });
  fake.telegram.files.set("pdf-ok", { path: "documents/file_2.pdf", data: PDF });
  fake.telegram.files.set("html-as-jpg", { path: "photos/file_3.jpg", data: Buffer.from("<html>not a photo</html>") });
  fake.telegram.files.set("too-big", { path: "documents/file_4.pdf", data: Buffer.concat([PDF, Buffer.alloc(FILE_MAX_BYTES, 1)]), hideSize: true });
  if (!fake.telegram.chats.some((c) => c.id === STRANGER_CHAT)) fake.telegram.chats.push({ id: STRANGER_CHAT, title: "Customer" });
});

type Agent = ReturnType<typeof request.agent>;

async function owner() {
  const email = `telegram-api-${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201); // gitleaks:allow
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id };
}

async function connectTelegram(agent: Agent, userId: string, receive = true) {
  const res = await agent.put("/settings/connections/telegram").send({ token: TOKEN, chatId: String(OWNER_CHAT), receive });
  const [c] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, "telegram")));
  return { res, webhookPath: (c?.destination as { webhookPath?: string } | null)?.webhookPath ?? "" };
}

async function publish(agent: Agent, config: Record<string, unknown>, steps?: unknown[]) {
  const wf = await agent.post("/workflows").send({ name: `Telegram WF ${++seq}`, slug: `telegram-wf-${seq}` }).expect(201);
  const definition = { trigger: { type: "telegram_message", config }, steps: steps ?? [{ id: "wait", type: "delay", config: { seconds: 1 } }], edges: [] };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  return wf.body.id as string;
}

let updateSeq = 1000;
const message = (over: Record<string, unknown> = {}, chat = OWNER_CHAT) => ({
  update_id: ++updateSeq,
  message: { message_id: updateSeq, date: 1_763_890_000, chat: { id: chat, type: chat === OWNER_CHAT ? "group" : "private" }, from: { id: chat, first_name: "Ana" }, caption: "GCash receipt", photo: [{ file_id: "photo-ok", file_size: JPEG.length, width: 10, height: 10 }], ...over },
});
const send = (path: string, body: unknown, secret: string | null = telegramWebhookSecret(TOKEN, path)) => {
  const req = request(server).post(`/hooks/telegram/${path}`).set("content-type", "application/json");
  if (secret !== null) req.set("x-telegram-bot-api-secret-token", secret);
  return req.send(JSON.stringify(body));
};
const runsOf = async (workflowId: string) => {
  const vs = await db.select({ id: workflowVersions.id }).from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId));
  return db.select().from(runs).where(inArray(runs.workflowVersionId, vs.map((v) => v.id)));
};

describe("Telegram connection with receiving on", () => {
  it("registers the webhook with a secret token, keeps the path on reconnect, removes it when turned off or disconnected, and never echoes the token", async () => {
    const o = await owner();
    const { res, webhookPath } = await connectTelegram(o.agent, o.userId);
    expect(res.status).toBe(200);
    expect(webhookPath).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.telegram.webhookUrl).toBe(`https://daloy.test/hooks/telegram/${webhookPath}`);
    expect(fake.telegram.webhookSecret).toBe(telegramWebhookSecret(TOKEN, webhookPath));
    expect(JSON.stringify(res.body)).not.toContain(TOKEN.split(":")[1]);
    expect(JSON.stringify(res.body)).not.toContain(fake.telegram.webhookSecret);
    const conn = (res.body.connections as { provider: string; destination: Record<string, string> }[]).find((c) => c.provider === "telegram");
    expect(conn?.destination).toMatchObject({ chatId: String(OWNER_CHAT), webhook: "registered" });

    expect((await connectTelegram(o.agent, o.userId)).webhookPath).toBe(webhookPath);

    await connectTelegram(o.agent, o.userId, false);
    expect(fake.telegram.webhook).toBe(false);
    const again = (await connectTelegram(o.agent, o.userId)).webhookPath;
    expect(fake.telegram.webhookUrl).toBe(`https://daloy.test/hooks/telegram/${again}`);
    await o.agent.delete("/settings/connections/telegram").expect(204);
    expect(fake.telegram.webhook).toBe(false);
  });

  it("saves the connection and says so when Telegram refuses the address", async () => {
    const o = await owner();
    fake.telegram.denyWebhook = true;
    try {
      const { res } = await connectTelegram(o.agent, o.userId);
      expect(res.status).toBe(200);
      const conn = (res.body.connections as { provider: string; destination: Record<string, string> }[]).find((c) => c.provider === "telegram");
      expect(conn?.destination.webhook).toBe("failed");
    } finally {
      fake.telegram.denyWebhook = false;
    }
  });

  it("refuses to publish a Telegram trigger before Telegram is connected with receiving on", async () => {
    const o = await owner();
    const wf = await o.agent.post("/workflows").send({ name: `Telegram WF ${++seq}`, slug: `telegram-wf-${seq}` }).expect(201);
    const definition = { trigger: { type: "telegram_message", config: {} }, steps: [{ id: "wait", type: "delay", config: { seconds: 1 } }], edges: [] };
    expect((await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true })).status).toBe(400);
    await connectTelegram(o.agent, o.userId, false);
    const off = await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true });
    expect(off.status).toBe(400);
    expect(off.body.message).toContain("Receive messages");
  });

  it("refuses a Telegram step that sets a chat under any other trigger", async () => {
    const o = await owner();
    await connectTelegram(o.agent, o.userId);
    const wf = await o.agent.post("/workflows").send({ name: `Telegram WF ${++seq}`, slug: `telegram-wf-${seq}` }).expect(201);
    const definition = { trigger: { type: "webhook", config: {} }, steps: [{ id: "reply", type: "telegram", config: { chatId: "{{trigger.chatId}}", text: "hi" } }], edges: [] };
    expect((await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: false })).status).toBe(400);
  });
});

describe("Telegram webhook", () => {
  it("refuses an unknown path, a missing secret and a wrong secret before reading the body", async () => {
    const o = await owner();
    const { webhookPath } = await connectTelegram(o.agent, o.userId);
    const wfId = await publish(o.agent, { from: "anyone" });
    await send("unknown-path-000000000000000000000000000000000", message()).expect(403);
    await send(webhookPath, message(), null).expect(401);
    await send(webhookPath, message(), "wrong").expect(401);
    await send(webhookPath, message(), telegramWebhookSecret(TOKEN, "another-path")).expect(401);
    expect(await runsOf(wfId)).toHaveLength(0);
  });

  it("starts one run for an update sent twice, even at the same time", async () => {
    const o = await owner();
    const { webhookPath } = await connectTelegram(o.agent, o.userId);
    const wfId = await publish(o.agent, { from: "anyone" });
    const m = message();
    const answers = await Promise.all([send(webhookPath, m), send(webhookPath, m), send(webhookPath, m)]);
    for (const a of answers) expect(a.status).toBe(200);
    await send(webhookPath, m).expect(200);
    expect(await runsOf(wfId)).toHaveLength(1);
  });

  it("with my chat only, ignores other chats; with anyone, takes them", async () => {
    const o = await owner();
    const { webhookPath } = await connectTelegram(o.agent, o.userId);
    const mine = await publish(o.agent, { from: "my_chat" });
    const open = await publish(o.agent, { from: "anyone" });
    await send(webhookPath, message({}, STRANGER_CHAT)).expect(200);
    expect(await runsOf(mine)).toHaveLength(0);
    expect(await runsOf(open)).toHaveLength(1);
    await send(webhookPath, message()).expect(200);
    expect(await runsOf(mine)).toHaveLength(1);
    expect(await runsOf(open)).toHaveLength(2);
  });

  it("stores a photo or PDF as an upload and refuses fakes, files over the cap and other types", async () => {
    const o = await owner();
    const { webhookPath } = await connectTelegram(o.agent, o.userId);
    const wfId = await publish(o.agent, { from: "my_chat", requireFile: true });

    await send(webhookPath, message()).expect(200);
    await send(webhookPath, message({ photo: undefined, document: { file_id: "pdf-ok", file_name: "resibo.pdf", mime_type: "application/pdf", file_size: PDF.length } })).expect(200);
    const stored = await runsOf(wfId);
    expect(stored).toHaveLength(2);
    for (const [run, bytes, type] of [[stored.find((r) => (r.triggerPayload as { file: FileRef[] }).file[0]?.type === "jpeg"), JPEG, "jpeg"], [stored.find((r) => (r.triggerPayload as { file: FileRef[] }).file[0]?.type === "pdf"), PDF, "pdf"]] as const) {
      expect(run, type).toBeDefined();
      const p = run!.triggerPayload as { file: FileRef[]; chatId: string; text: string; fromName: string };
      expect(p).toMatchObject({ chatId: String(OWNER_CHAT), fromName: "Ana" });
      expect(Object.keys(p.file[0]!).sort()).toEqual(["id", "name", "size", "type"]);
      const up = await readUpload(db, { userId: o.userId, runId: run!.id, id: p.file[0]!.id });
      expect(up?.data.equals(bytes)).toBe(true);
    }

    // HTML named .jpg, a file whose bytes run past the cap, a Word file, and a text message: no file, so no run.
    await send(webhookPath, message({ photo: [{ file_id: "html-as-jpg", file_size: 30, width: 1, height: 1 }] })).expect(200);
    await send(webhookPath, message({ photo: undefined, document: { file_id: "too-big", file_name: "big.pdf", mime_type: "application/pdf" } })).expect(200);
    await send(webhookPath, message({ photo: undefined, document: { file_id: "pdf-ok", file_name: "a.docx", mime_type: "application/msword", file_size: 10 } })).expect(200);
    await send(webhookPath, message({ photo: undefined, caption: undefined, text: "hello" })).expect(200);
    expect(await runsOf(wfId)).toHaveLength(2);
  });

  it("starts a run with no file when a file is not required", async () => {
    const o = await owner();
    const { webhookPath } = await connectTelegram(o.agent, o.userId);
    const wfId = await publish(o.agent, { from: "my_chat", requireFile: false });
    await send(webhookPath, message({ photo: undefined, caption: undefined, text: "hello" })).expect(200);
    const [run] = await runsOf(wfId);
    expect(run?.triggerPayload).toMatchObject({ text: "hello", file: [] });
  });

  it("answers 503 so Telegram retries when the file server is down", async () => {
    const o = await owner();
    const { webhookPath } = await connectTelegram(o.agent, o.userId);
    const wfId = await publish(o.agent, { from: "my_chat", requireFile: true });
    fake.telegram.fileDown = true;
    try {
      await send(webhookPath, message()).expect(503);
    } finally {
      fake.telegram.fileDown = false;
    }
    expect(await runsOf(wfId)).toHaveLength(0);
  });
});

describe("Telegram reply to the sender", () => {
  it("sends to the chat the message came from, and refuses any other chat", async () => {
    const o = await owner();
    const { webhookPath } = await connectTelegram(o.agent, o.userId);
    const wfId = await publish(o.agent, { from: "anyone" }, [{ id: "reply", type: "telegram", config: { chatId: "{{trigger.chatId}}", text: "Got your receipt, {{trigger.fromName}}." } }]);
    await send(webhookPath, message({}, STRANGER_CHAT)).expect(200);
    const [run] = await runsOf(wfId);
    const exec = createExecutor({ db, secretsKey, mail: {} as never });
    const base = { runId: run!.id, userId: o.userId, workflowId: wfId, attempt: 1, ctx: { trigger: run!.triggerPayload, steps: {} } };
    await exec.execute({ ...base, stepRunId: "00000000-0000-0000-0000-000000000011", idempotencyKey: `${run!.id}:reply`, step: { id: "reply", type: "telegram", config: { chatId: "{{trigger.chatId}}", text: "Got your receipt, {{trigger.fromName}}." } } as never });
    await runDueDeliveries(db, secretsKey, fake.urls);
    expect(fake.telegram.messages).toEqual([expect.objectContaining({ chat: String(STRANGER_CHAT), text: "Got your receipt, Ana." })]);

    await expect(exec.execute({ ...base, stepRunId: "00000000-0000-0000-0000-000000000012", idempotencyKey: `${run!.id}:other`, step: { id: "other", type: "telegram", config: { chatId: String(OWNER_CHAT), text: "x" } } as never })).rejects.toBeInstanceOf(StepError);
    const queued = await db.select().from(deliveries).where(eq(deliveries.runId, run!.id));
    expect(queued).toHaveLength(1);
  });
});

describe("J1 Telegram conversations, assistant template and R6 privacy", () => {
  const driveRun = async (runId: string) => {
    const exec = createExecutor({ db, secretsKey, mail: mailDeps(), urls: providers });
    const deps = { db, executor: exec, owner: "j1-test", leaseMs: 5000, retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, enqueue: async () => {} };
    for (let i = 0; i < 20; i++) {
      const [r] = await db.select({ state: runs.state }).from(runs).where(eq(runs.id, runId));
      if (!r || !["pending", "running"].includes(r.state)) return r?.state;
      await advance(deps, runId);
    }
    throw new Error("run did not settle");
  };

  it("wires Telegram messages into C1 conversations with replay dedup and supersedes stale waiting runs on rapid follow-up", async () => {
    const o = await owner();
    const { webhookPath } = await connectTelegram(o.agent, o.userId);
    const wf = await o.agent.post("/workflows").send({ name: `TG Convo ${++seq}`, slug: `tg-convo-${seq}` }).expect(201);
    const definition = {
      trigger: { type: "telegram_message", config: { from: "my_chat", requireFile: false } },
      steps: [
        { id: "wait", type: "delay", config: { seconds: 30 } },
        { id: "reply", type: "telegram", config: { chatId: "{{trigger.chatId}}", text: "Delayed answer" } },
      ],
      edges: [{ from: "wait", to: "reply" }],
    };
    await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);

    const firstMsg = message({ photo: undefined, caption: undefined, text: "First question" });
    await send(webhookPath, firstMsg).expect(200);
    // Replaying the exact same Telegram message_id is deduplicated by mid and creates no second message or run.
    const replayRes = await send(webhookPath, firstMsg).expect(200);
    expect(replayRes.body).toEqual({ ok: true, started: 0 });

    const [convo] = await db.select().from(conversations).where(and(eq(conversations.userId, o.userId), eq(conversations.channel, "telegram")));
    expect(convo).toMatchObject({ channel: "telegram", externalId: String(OWNER_CHAT), version: 1 });
    expect(await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, convo!.id))).toHaveLength(1);

    const listRes = await o.agent.get("/conversations").expect(200);
    expect(listRes.body.conversations).toEqual([expect.objectContaining({ id: convo!.id, channel: "telegram", externalId: String(OWNER_CHAT) })]);
    const detailRes = await o.agent.get(`/conversations/${convo!.id}`).expect(200);
    expect(detailRes.body).toMatchObject({ id: convo!.id, channel: "telegram" });

    const [run1] = await runsOf(wf.body.id);
    expect(run1).toMatchObject({ conversationId: convo!.id, conversationVersion: 1 });
    expect(await driveRun(run1!.id)).toBe("waiting");

    // Rapid follow-up increments conversation version and supersedes run1 when it wakes from delay.
    await send(webhookPath, message({ photo: undefined, caption: undefined, text: "Actually, what about payments?" })).expect(200);
    await db.update(runs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(runs.id, run1!.id));
    const exec = createExecutor({ db, secretsKey, mail: mailDeps(), urls: providers });
    await advance({ db, executor: exec, owner: "j1-test", leaseMs: 5000, retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, enqueue: async () => {} }, run1!.id);
    expect(await driveRun(run1!.id)).toBe("cancelled");
    expect(fake.telegram.messages).toHaveLength(0);
  });

  it("runs the telegram-assistant template end-to-end with Google Calendar, bookings, unpaid dues and multi-turn follow-up memory", async () => {
    const assistantTemplate = TEMPLATES.find((t) => t.slug === "telegram-assistant")!;
    expect(assistantTemplate).toBeDefined();

    const prompts: string[] = [];
    const aiQueue: Record<string, unknown>[] = [];
    const aiServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        prompts.push(raw);
        const next = aiQueue.shift() ?? { draft: "Nothing scheduled." };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: { role: "assistant", content: JSON.stringify(next) }, prompt_eval_count: 12, eval_count: 12 }));
      });
    });
    await new Promise<void>((r) => aiServer.listen(0, "127.0.0.1", r));
    vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${(aiServer.address() as AddressInfo).port}`);

    try {
      const o = await owner();
      const { webhookPath } = await connectTelegram(o.agent, o.userId);

      // Connect Google Calendar OAuth for this workspace and populate an event today.
      Object.assign(fake.oauth.google!, { consent: "grant", user: { id: `g-${seq}`, email: "owner@assistant.test" } });
      const back = new URL((await fetch(await startFlow(db, secretsKey, providers, "https://daloy.test", googleCalendar, { workspaceId: o.userId, memberId: o.userId }), { redirect: "manual" })).headers.get("location")!);
      const flow = await consumeFlow(db, secretsKey, back.searchParams.get("state")!, { workspaceId: o.userId, memberId: o.userId });
      expect(await finishFlow(db, secretsKey, providers, "https://daloy.test", googleCalendar, o.userId, back.searchParams.get("code")!, flow!.verifier)).toBe("connected");
      const cal = await ensureCalendar(db, secretsKey, providers, o.userId);

      const { start } = dayBounds(new Date(), "Asia/Manila");
      const evStart = new Date(start.getTime() + 2 * 3600_000);
      const evEnd = new Date(evStart.getTime() + 3600_000);
      fake.calendar(cal.calendarId)!.events.set("asst-ev-1", {
        id: "asst-ev-1",
        status: "confirmed",
        summary: "Supplier Call",
        start: { dateTime: evStart.toISOString() },
        end: { dateTime: evEnd.toISOString() },
        created: start.toISOString(),
        updated: start.toISOString(),
      });

      const wf = await o.agent.post("/workflows").send({ name: "My Assistant", slug: `tg-asst-${++seq}` }).expect(201);
      await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: assistantTemplate.definition, publish: true }).expect(201);

      const [room] = await db.insert(resources).values({ userId: o.userId, name: "Cabana 1" }).returning();
      const [seedRun] = await db.insert(runs).values({ workflowVersionId: (await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf.body.id)))[0]!.id, state: "succeeded" }).returning();
      await db.insert(bookings).values({
        userId: o.userId,
        test: false,
        reference: "B-ASST-1",
        resourceId: room!.id,
        during: `[${evStart.toISOString()},${evEnd.toISOString()})`,
        timezone: "Asia/Manila",
        workflowId: wf.body.id,
        runId: seedRun!.id,
      });
      await createDue(db, { userId: o.userId, test: false, workflowId: wf.body.id, runId: seedRun!.id, stepId: "ask", reference: "PAY-ASST-1", kind: "deposit", amountCentavos: 180_000 });

      // Turn 1: owner asks for today's overview.
      aiQueue.push({ label: "all" }, { draft: "Today you have Supplier Call, booking B-ASST-1 on Cabana 1, and open payment PAY-ASST-1 for PHP 1800.00." });
      await send(webhookPath, message({ photo: undefined, caption: undefined, text: "What is on my plate today?" })).expect(200);
      const turn1Runs = (await runsOf(wf.body.id)).filter((r) => r.id !== seedRun!.id);
      expect(turn1Runs).toHaveLength(1);
      expect(await driveRun(turn1Runs[0]!.id)).toBe("succeeded");
      await runDueDeliveries(db, secretsKey, providers);

      expect(fake.telegram.messages).toHaveLength(1);
      expect(fake.telegram.messages[0]?.text).toBe("kymavo assistant:\nToday you have Supplier Call, booking B-ASST-1 on Cabana 1, and open payment PAY-ASST-1 for PHP 1800.00.");
      expect(fake.telegram.messages[0]?.text).not.toContain("Data Privacy Act");
      // The draft prompt received the live snapshot including calendar event, booking, and unpaid due.
      expect(prompts[1]).toContain("Supplier Call");
      expect(prompts[1]).toContain("B-ASST-1");
      expect(prompts[1]).toContain("PAY-ASST-1");

      // Turn 2: follow-up question carries both the first question and the assistant's outbound answer in conversation.history.
      aiQueue.push({ label: "payments" }, { draft: "PAY-ASST-1 is PHP 1800.00 pending." });
      await send(webhookPath, message({ photo: undefined, caption: undefined, text: "How much was that unpaid balance again?" })).expect(200);
      const turn2Runs = (await runsOf(wf.body.id)).filter((r) => r.id !== seedRun!.id && r.id !== turn1Runs[0]!.id);
      expect(turn2Runs).toHaveLength(1);
      expect(await driveRun(turn2Runs[0]!.id)).toBe("succeeded");
      await runDueDeliveries(db, secretsKey, providers);

      expect(prompts[2]).toContain("What is on my plate today?");
      expect(prompts[2]).toContain("Today you have Supplier Call");
      const [convo] = await db.select().from(conversations).where(and(eq(conversations.userId, o.userId), eq(conversations.channel, "telegram")));
      const storedMsgs = await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, convo!.id)).orderBy(asc(conversationMessages.createdAt), asc(conversationMessages.id));
      expect(storedMsgs.map((m) => m.direction)).toEqual(["in", "out", "in", "out"]);
    } finally {
      vi.unstubAllEnvs();
      aiServer.closeAllConnections();
      await new Promise<void>((r) => aiServer.close(() => r()));
    }
  });

  it("supports R6 conversation export/delete and customer privacy delete for Telegram threads", async () => {
    const o = await owner();
    const { webhookPath } = await connectTelegram(o.agent, o.userId);
    await publish(o.agent, { from: "anyone", requireFile: false });

    await send(webhookPath, message({ photo: undefined, caption: undefined, text: "Hi, my email is tg.guest@privacy.test" }, STRANGER_CHAT)).expect(200);
    const [convo] = await db.select().from(conversations).where(and(eq(conversations.userId, o.userId), eq(conversations.channel, "telegram"), eq(conversations.externalId, String(STRANGER_CHAT))));
    expect(convo).toBeDefined();

    // Direct conversation export works even without saved fields.
    const exportedByConvo = await o.agent.post(`/conversations/${convo!.id}/export`).send({}).expect(200);
    expect(exportedByConvo.body.counts).toMatchObject({ conversations: 1, conversationMessages: 1 });

    // Customer privacy export and delete match Telegram messages and remove the conversation.
    const exportedByEmail = await o.agent.post("/privacy/customer/export").send({ email: "tg.guest@privacy.test" }).expect(200);
    expect(exportedByEmail.body.counts).toMatchObject({ conversations: 1, conversationMessages: 1 });

    const deletedByEmail = await o.agent.post("/privacy/customer/delete").send({ email: "tg.guest@privacy.test", confirm: "DELETE" }).expect(200);
    expect(deletedByEmail.body.counts).toMatchObject({ conversations: 1 });
    await o.agent.get(`/conversations/${convo!.id}`).expect(404);

    // Direct /conversations/:id/delete also removes a Telegram thread cleanly.
    await send(webhookPath, message({ photo: undefined, caption: undefined, text: "No email or phone here" }, STRANGER_CHAT)).expect(200);
    const [convo2] = await db.select().from(conversations).where(and(eq(conversations.userId, o.userId), eq(conversations.channel, "telegram"), eq(conversations.externalId, String(STRANGER_CHAT))));
    await o.agent.post(`/conversations/${convo2!.id}/delete`).send({ confirm: "DELETE" }).expect(200);
    await o.agent.get(`/conversations/${convo2!.id}`).expect(404);
  });
});
