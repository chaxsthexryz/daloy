import { createHmac, randomBytes } from "node:crypto";
import { connections, conversationMessages, conversations, deleteCustomer, exportCustomer, purgeConversations, runDueDeliveries, runs, stepRuns, users, windowOpen, workflowVersions, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { advance } from "../../worker/src/advance";
import { createExecutor } from "../../worker/src/steps";
import { createApp } from "./app";

// C1 (decision 0115): conversation state for Messenger and Instagram guests.
const PAGE_ID = "100200300401";
const PAGE_TOKEN = "meta_c1_page_token_synthetic_001"; // gitleaks:allow
const APP_SECRET = "meta_c1_app_secret_synthetic_001"; // gitleaks:allow
const VERIFY_TOKEN = "meta_c1_verify_token_synthetic_001"; // gitleaks:allow
const HOUR = 3600_000;
const MINUTE = 60_000;

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
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "https://daloy.test", providers: { ...fake.urls, timeoutMs: 2000 } });
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
  fake.meta.token = PAGE_TOKEN;
  fake.meta.pageId = PAGE_ID;
  fake.meta.pageName = "Bahay Kubo Resort";
  fake.meta.revoked = false;
  fake.meta.messages.length = 0;
});

const deps = () => ({ db, executor: createExecutor({ db, secretsKey, mail: {} as never, urls: fake.urls }), owner: "c1", leaseMs: 5000, retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, enqueue: async () => {} });

/** Advances a run until it finishes or waits. */
async function drive(runId: string) {
  for (let i = 0; i < 20; i++) {
    const [r] = await db.select({ state: runs.state }).from(runs).where(eq(runs.id, runId));
    if (!r || !["pending", "running"].includes(r.state)) return r?.state;
    await advance(deps(), runId);
  }
  throw new Error("run did not settle");
}

async function setup(steps?: unknown[], edges?: unknown[]) {
  const email = `c1-${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201); // gitleaks:allow
  const [u] = await db.select().from(users).where(eq(users.email, email));
  await agent.put("/settings/connections/meta-messenger").send({ pageId: PAGE_ID, pageAccessToken: PAGE_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN }).expect(200);
  const wf = await agent.post("/workflows").send({ name: `C1 ${seq}`, slug: `c1-${seq}` }).expect(201);
  const definition = { trigger: { type: "meta_dm", config: {} }, steps: steps ?? [{ id: "reply", type: "meta_reply", config: { text: "Salamat! {{trigger.text}}" } }], edges: edges ?? [] };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  const [c] = await db.select().from(connections).where(and(eq(connections.userId, u!.id), eq(connections.provider, "meta_messenger")));
  return { userId: u!.id, workflowId: wf.body.id as string, path: (c!.destination as { webhookPath: string }).webhookPath };
}

const sign = (body: string) => `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
const post = (path: string, messaging: unknown[]) => {
  const body = JSON.stringify({ object: "page", entry: [{ id: PAGE_ID, messaging }] });
  return request(server).post(`/hooks/meta/${path}`).set("content-type", "application/json").set("x-hub-signature-256", sign(body)).send(body).expect(200);
};
const inbound = (psid: string, mid: string, text: string, at = Date.now()) => ({ sender: { id: psid }, recipient: { id: PAGE_ID }, timestamp: at, message: { mid, text } });
const echo = (psid: string, mid: string, text: string, metadata?: string) => ({ sender: { id: PAGE_ID }, recipient: { id: psid }, timestamp: Date.now(), message: { mid, text, is_echo: true, ...(metadata ? { metadata } : {}) } });

const runsOf = async (workflowId: string) => {
  const vs = await db.select({ id: workflowVersions.id }).from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId));
  return db.select().from(runs).where(inArray(runs.workflowVersionId, vs.map((v) => v.id))).orderBy(asc(runs.createdAt));
};
const conversationOf = async (userId: string, psid: string) => (await db.select().from(conversations).where(and(eq(conversations.userId, userId), eq(conversations.externalId, psid))))[0]!;
const messagesOf = (conversationId: string) => db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId)).orderBy(asc(conversationMessages.createdAt));

describe("conversation window", () => {
  it("is open at 23:59 after the guest's last message and closed at 24:01", () => {
    const now = Date.parse("2031-01-02T12:00:00Z");
    expect(windowOpen(new Date(now - 23 * HOUR - 59 * MINUTE), now)).toBe(true);
    expect(windowOpen(new Date(now - 24 * HOUR - MINUTE), now)).toBe(false);
    expect(windowOpen(null, now)).toBe(false);
  });
});

describe("Meta webhook conversations", () => {
  it("records one conversation per guest, and a replayed mid adds no message, version or run", async () => {
    const s = await setup();
    const msg = inbound("psid-replay", "m_replay_1", "May room pa kayo sa Dec 20?");
    await post(s.path, [msg]);
    await post(s.path, [msg]);
    const c = await conversationOf(s.userId, "psid-replay");
    expect(c).toMatchObject({ channel: "messenger", status: "bot", version: 1 });
    expect(await messagesOf(c.id)).toHaveLength(1);
    const list = await runsOf(s.workflowId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ conversationId: c.id, conversationVersion: 1 });
    const payload = list[0]!.triggerPayload as { conversation: { id: string; history: { direction: string; text: string }[] } };
    expect(payload.conversation).toMatchObject({ id: c.id, history: [{ direction: "in", text: "May room pa kayo sa Dec 20?" }] });
  });

  it("gives one reply, to the newer message, when two messages arrive within a second", async () => {
    const s = await setup();
    const t = Date.now();
    await post(s.path, [inbound("psid-burst", "m_burst_1", "Hi", t)]);
    await post(s.path, [inbound("psid-burst", "m_burst_2", "2 adults, Dec 20 to 22", t + 800)]);
    const [first, second] = await runsOf(s.workflowId);
    expect(await drive(first!.id)).toBe("cancelled");
    expect(await drive(second!.id)).toBe("succeeded");
    await runDueDeliveries(db, secretsKey, fake.urls);
    expect(fake.meta.messages).toHaveLength(1);
    expect(fake.meta.messages[0]!.text).toContain("Salamat! 2 adults, Dec 20 to 22");
    const [stopped] = await db.select().from(runs).where(eq(runs.id, first!.id));
    expect(stopped!.error).toMatch(/newer message/);
  });

  it("ends the older run's follow-up when the guest writes again", async () => {
    const s = await setup(
      [
        { id: "reply", type: "meta_reply", config: { text: "Salamat!" } },
        { id: "wait", type: "delay", config: { seconds: 72_000 } },
        { id: "follow_up", type: "meta_reply", config: { text: "Interested pa po kayo?" } },
      ],
      [{ from: "reply", to: "wait" }, { from: "wait", to: "follow_up" }],
    );
    await post(s.path, [inbound("psid-follow", "m_follow_1", "Rates po?")]);
    const [older] = await runsOf(s.workflowId);
    expect(await drive(older!.id)).toBe("waiting");
    await post(s.path, [inbound("psid-follow", "m_follow_2", "Sige, Dec 20 po")]);
    // The 20 hours pass: the older run wakes up and stops instead of sending its follow-up.
    await db.update(runs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(runs.id, older!.id));
    await advance(deps(), older!.id);
    expect(await drive(older!.id)).toBe("cancelled");
    const steps = await db.select({ stepId: stepRuns.stepId }).from(stepRuns).where(eq(stepRuns.runId, older!.id));
    expect(steps.map((r) => r.stepId)).not.toContain("follow_up");
  });

  it("sends the privacy notice with the first reply only", async () => {
    const s = await setup();
    await post(s.path, [inbound("psid-notice", "m_notice_1", "Hello")]);
    const [one] = await runsOf(s.workflowId);
    await drive(one!.id);
    await runDueDeliveries(db, secretsKey, fake.urls);
    await post(s.path, [inbound("psid-notice", "m_notice_2", "Rates?")]);
    const [, two] = await runsOf(s.workflowId);
    await drive(two!.id);
    await runDueDeliveries(db, secretsKey, fake.urls);
    expect(fake.meta.messages).toHaveLength(2);
    expect(fake.meta.messages[0]!.text).toMatch(/automated assistant.*90 days/s);
    expect(fake.meta.messages[0]!.text).toContain("Salamat! Hello");
    expect(fake.meta.messages[1]!.text).toBe("Salamat! Rates?");
    expect((await conversationOf(s.userId, "psid-notice")).noticeSentAt).not.toBeNull();
  });

  it("pauses the bot when staff reply from the Page inbox, but not for its own echo", async () => {
    const s = await setup([{ id: "reply", type: "meta_reply", config: { text: "Auto reply" } }], []);
    await post(s.path, [inbound("psid-echo", "m_echo_1", "Hi")]);
    const [one] = await runsOf(s.workflowId);
    await drive(one!.id);
    await runDueDeliveries(db, secretsKey, fake.urls);
    const sent = fake.meta.messages[0]!.text;
    // Daloy's own reply comes back marked, and once more without the mark (Instagram may drop it): neither pauses.
    await post(s.path, [echo("psid-echo", "m_own_1", sent, "daloy"), echo("psid-echo", "m_own_2", sent)]);
    let c = await conversationOf(s.userId, "psid-echo");
    expect(c.status).toBe("bot");
    expect((await messagesOf(c.id)).map((m) => m.direction)).toEqual(["in", "out"]);

    // A person answers from the Page inbox: stored as a staff message, and the bot is quiet for 12 hours.
    await post(s.path, [echo("psid-echo", "m_staff_1", "Hello po, si Ana ito ng front desk")]);
    c = await conversationOf(s.userId, "psid-echo");
    expect(c.status).toBe("staff");
    expect(c.staffUntil!.getTime()).toBeGreaterThan(Date.now() + 11 * HOUR);
    await post(s.path, [inbound("psid-echo", "m_echo_2", "Salamat Ana")]);
    const [, two] = await runsOf(s.workflowId);
    expect(await drive(two!.id)).toBe("succeeded");
    const [reply] = await db.select().from(stepRuns).where(and(eq(stepRuns.runId, two!.id), eq(stepRuns.stepId, "reply")));
    expect(reply).toMatchObject({ state: "succeeded", branch: "paused" });
    await runDueDeliveries(db, secretsKey, fake.urls);
    expect(fake.meta.messages).toHaveLength(1);
  });

  it("takes the outside_window edge 24:01 after the guest's last message, and replies at 23:59", async () => {
    const s = await setup(
      [
        { id: "reply", type: "meta_reply", config: { text: "Late reply" } },
        { id: "fallback", type: "delay", config: { seconds: 60 } },
      ],
      [{ from: "reply", to: "fallback", on: "outside_window" }],
    );
    await post(s.path, [inbound("psid-window", "m_window_1", "Hi")]);
    const c = await conversationOf(s.userId, "psid-window");
    const [open] = await runsOf(s.workflowId);
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 23 * HOUR - 59 * MINUTE) }).where(eq(conversations.id, c.id));
    await drive(open!.id);
    const [sent] = await db.select().from(stepRuns).where(and(eq(stepRuns.runId, open!.id), eq(stepRuns.stepId, "reply")));
    expect(sent!.branch).toBeNull();

    await post(s.path, [inbound("psid-window", "m_window_2", "Hello?")]);
    const [, closed] = await runsOf(s.workflowId);
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 24 * HOUR - MINUTE) }).where(eq(conversations.id, c.id));
    await drive(closed!.id);
    const steps = await db.select().from(stepRuns).where(eq(stepRuns.runId, closed!.id));
    expect(steps.find((r) => r.stepId === "reply")).toMatchObject({ branch: "outside_window" });
    expect(steps.map((r) => r.stepId)).toContain("fallback");
  });

  it("fails the reply with the window message when there is no outside_window edge", async () => {
    const s = await setup();
    await post(s.path, [inbound("psid-window-2", "m_window_3", "Hi")]);
    const c = await conversationOf(s.userId, "psid-window-2");
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 25 * HOUR) }).where(eq(conversations.id, c.id));
    const [run] = await runsOf(s.workflowId);
    expect(await drive(run!.id)).toBe("failed");
    expect((await db.select().from(runs).where(eq(runs.id, run!.id)))[0]!.error).toMatch(/24-hour reply window/);
  });

  it("saves guest details with conversation_update for the next message's run", async () => {
    const s = await setup(
      [{ id: "save", type: "conversation_update", config: { fields: { guests: "2", check_in: "{{trigger.text}}", name: "" } } }],
      [],
    );
    await post(s.path, [inbound("psid-fields", "m_fields_1", "2031-12-20")]);
    const [one] = await runsOf(s.workflowId);
    expect(await drive(one!.id)).toBe("succeeded");
    expect((await conversationOf(s.userId, "psid-fields")).fields).toEqual({ guests: "2", check_in: "2031-12-20" });
    await post(s.path, [inbound("psid-fields", "m_fields_2", "Maria po")]);
    const [, two] = await runsOf(s.workflowId);
    expect((two!.triggerPayload as { conversation: { fields: unknown } }).conversation.fields).toEqual({ guests: "2", check_in: "2031-12-20" });
  });
});

describe("conversation privacy", () => {
  it("R6 export and delete include the conversation and its messages", async () => {
    const s = await setup();
    await post(s.path, [inbound("psid-r6", "m_r6_1", "Call me at 0917 555 1234")]);
    await post(s.path, [inbound("psid-r6", "m_r6_2", "Dec 20 po")]);
    const c = await conversationOf(s.userId, "psid-r6");
    const out = await exportCustomer(db, s.userId, s.userId, { phone: "09175551234" });
    expect(out.counts).toMatchObject({ conversations: 1, conversationMessages: 2, runs: 2 });
    expect(out.conversationMessages.map((m) => m.text)).toEqual(["Call me at 0917 555 1234", "Dec 20 po"]);

    const done = await deleteCustomer(db, s.userId, s.userId, { phone: "09175551234" });
    expect(done.counts).toMatchObject({ conversations: 1, conversationMessages: 2 });
    expect(await db.select().from(conversations).where(eq(conversations.id, c.id))).toHaveLength(0);
    expect(await messagesOf(c.id)).toHaveLength(0);
    for (const r of await runsOf(s.workflowId)) expect(r.triggerPayload).toEqual({ erased: true });
  });

  it("the sweep deletes a conversation's text after the workspace's retention days", async () => {
    const s = await setup();
    await post(s.path, [inbound("psid-old", "m_old_1", "Old question")]);
    await post(s.path, [inbound("psid-new", "m_new_1", "New question")]);
    await db.update(users).set({ conversationRetentionDays: 30 }).where(eq(users.id, s.userId));
    const old = await conversationOf(s.userId, "psid-old");
    const recent = await conversationOf(s.userId, "psid-new");
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 31 * 24 * HOUR) }).where(eq(conversations.id, old.id));
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 29 * 24 * HOUR) }).where(eq(conversations.id, recent.id));
    await purgeConversations(db);
    expect(await db.select().from(conversations).where(eq(conversations.id, old.id))).toHaveLength(0);
    expect(await messagesOf(old.id)).toHaveLength(0);
    expect(await messagesOf(recent.id)).toHaveLength(1);
    const linked = (await runsOf(s.workflowId)).find((r) => (r.triggerPayload as { text?: string }).text === undefined);
    expect(linked?.triggerPayload).toEqual({ erased: true });
  });
});
