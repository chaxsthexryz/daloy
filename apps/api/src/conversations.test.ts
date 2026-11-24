import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { TEMPLATES } from "@daloy/engine";
import { connections, conversationMessages, conversations, createDue, decideClaim, deleteCustomer, digestCounts, expireDue, exportCustomer, joinWorkspace, mailDeps, paymentClaims, paymentDues, purgeConversations, receiptReferences, runDueDeliveries, runs, sessions, stepRuns, submitTransferClaim, users, windowOpen, workflowVersions, type Db, type MailDeps } from "@daloy/db";
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
import { sha256 } from "./http";

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
const mailSent: { to: string; subject: string; text: string }[] = [];
const mail: MailDeps = {
  ...mailDeps(),
  installation: {
    from: "Daloy <daloy@localhost>",
    transport: {
      sendMail: async (msg: { to?: unknown; subject?: unknown; text?: unknown }) => {
        mailSent.push({ to: String(msg.to ?? ""), subject: String(msg.subject ?? ""), text: String(msg.text ?? "") });
        return { messageId: `m-${mailSent.length}` };
      },
    } as MailDeps["installation"]["transport"],
  },
};

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  app = await createApp({ db, boss, secretsKey, secureCookies: false, mail, publicUrl: "https://daloy.test", providers: { ...fake.urls, timeoutMs: 2000 } });
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
  fake.telegram.messages.length = 0;
  fake.telegram.token = "";
  mailSent.length = 0;
  fake.meta.cdnFiles.clear();
  fake.meta.cdnFiles.set("receipt.png", { contentType: "image/png", data: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex") });
  fake.meta.cdnFiles.set("receipt2.png", { contentType: "image/png", data: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex") });
});

const deps = () => ({ db, executor: createExecutor({ db, secretsKey, mail, urls: fake.urls }), owner: "c1", leaseMs: 5000, retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, enqueue: async () => {} });

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
  return { agent, userId: u!.id, workflowId: wf.body.id as string, path: (c!.destination as { webhookPath: string }).webhookPath };
}

// nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
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

describe("DM receipt photo claims on open due (C6)", () => {
  const photoMsg = (psid: string, mid: string, text: string, files: string[] = ["receipt.png"]) => ({
    sender: { id: psid },
    recipient: { id: PAGE_ID },
    timestamp: Date.now(),
    message: {
      mid,
      text,
      attachments: files.map((f) => ({ type: "image", payload: { url: `${fake.urls.metaCdn}/meta-cdn/${f}` } })),
    },
  });

  it("payment_due step sets open_due_id, DM photo creates one claim in Receipts to review and never marks paid, replay creates no second claim, and confirm clears open_due_id", async () => {
    const s = await setup([
      { id: "due", type: "payment_due", config: { reference: "RES-6001", kind: "deposit", amount: "1500", channel: "messenger", to: "{{trigger.senderId}}" } },
    ]);
    // 1. First DM triggers payment_due, which sets conversations.open_due_id.
    await post(s.path, [inbound("psid-pay-1", "m_pay_ask", "Ready to pay deposit")]);
    const [askRun] = await runsOf(s.workflowId);
    expect(await drive(askRun!.id)).toBe("succeeded");
    const c = await conversationOf(s.userId, "psid-pay-1");
    expect(c.openDueId).not.toBeNull();
    const dueId = c.openDueId!;

    // 2. Guest sends a DM receipt photo (even with 2 attachments in one message): creates ONE claim and leaves due pending.
    const msg = photoMsg("psid-pay-1", "m_pay_photo_1", "Here is my GCash receipt Ref: 7001 8888 9999", ["receipt.png", "receipt2.png"]);
    await post(s.path, [msg]);
    const claims = await db.select().from(paymentClaims).where(eq(paymentClaims.dueId, dueId));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ channel: "transfer", status: "open", transferRef: "7001 8888 9999", imageType: "png", sourceMid: "m_pay_photo_1", flags: [] });
    expect((await db.select().from(paymentDues).where(eq(paymentDues.id, dueId)))[0]!.status).toBe("pending");

    // Visible in Receipts to review with downloadable receipt image.
    const review = (await s.agent.get("/payments/review").expect(200)).body as { claimId: string; reference: string; hasImage: boolean; flags: string[]; version: number }[];
    const item = review.find((r) => r.claimId === claims[0]!.id)!;
    expect(item).toMatchObject({ reference: "RES-6001", hasImage: true, flags: [] });
    expect((await s.agent.get(`/payments/claims/${item.claimId}/image`).expect(200)).headers["content-type"]).toBe("image/png");

    // 3. Replaying the exact same webhook mid creates NO second claim.
    await post(s.path, [msg]);
    expect(await db.select().from(paymentClaims).where(eq(paymentClaims.dueId, dueId))).toHaveLength(1);

    // 4. Reviewer confirms the claim -> clears conversations.open_due_id.
    await decideClaim(db, { workspaceId: s.userId, actor: { id: s.userId, role: "owner" }, claimId: item.claimId, version: item.version, decision: "confirm" });
    expect((await conversationOf(s.userId, "psid-pay-1")).openDueId).toBeNull();

    // 5. A DM photo sent AFTER confirmation creates NO claim.
    await post(s.path, [photoMsg("psid-pay-1", "m_pay_photo_after", "Sending again")]);
    expect(await db.select().from(paymentClaims).where(eq(paymentClaims.dueId, dueId))).toHaveLength(1);
  });

  it("handles Instagram DM receipt photos on an open due even when no workflow matches", async () => {
    const s = await setup();
    const IG_ID = "900800700601";
    await s.agent
      .put("/settings/connections/meta-messenger")
      .send({ pageId: PAGE_ID, instagramAccountId: IG_ID, pageAccessToken: PAGE_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN })
      .expect(200);
    await s.agent.post(`/workflows/${s.workflowId}/pause`).expect(204);
    const [c] = await db.insert(conversations).values({ userId: s.userId, channel: "instagram", externalId: "igsid-pay-1" }).returning();
    const [v] = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, s.workflowId));
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
    const d = await createDue(db, { userId: s.userId, test: false, workflowId: s.workflowId, runId: r!.id, stepId: "ig_due", reference: "RES-IG-1", kind: "deposit", amountCentavos: 100000, conversationId: c!.id });

    const body = JSON.stringify({
      object: "instagram",
      entry: [{ id: IG_ID, messaging: [{ sender: { id: "igsid-pay-1" }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid: "m_ig_receipt_1", text: "Ref IG99887766", attachments: [{ type: "image", payload: { url: `${fake.urls.metaCdn}/meta-cdn/receipt.png` } }] } }] }],
    });
    await request(server).post(`/hooks/meta/${s.path}`).set("content-type", "application/json").set("x-hub-signature-256", sign(body)).send(body).expect(200);
    const claims = await db.select().from(paymentClaims).where(eq(paymentClaims.dueId, d.id));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ transferRef: "IG99887766", imageType: "png", sourceMid: "m_ig_receipt_1", status: "open" });
    expect((await db.select().from(paymentDues).where(eq(paymentDues.id, d.id)))[0]!.status).toBe("pending");
  });

  it("flags duplicate reference on a DM receipt photo against earlier claims and receipt_references", async () => {
    const s = await setup();
    await post(s.path, [inbound("psid-dup", "m_dup_hello", "Hi")]);
    const c = await conversationOf(s.userId, "psid-dup");
    const [firstRun] = await runsOf(s.workflowId);

    // Seed an earlier pay-page claim with reference DUP555111222 on another due, plus a receipt_references entry.
    const otherDue = await createDue(db, { userId: s.userId, test: false, workflowId: s.workflowId, runId: firstRun!.id, stepId: "other_due", reference: "RES-OLD", kind: "deposit", amountCentavos: 50000 });
    await submitTransferClaim(db, otherDue.token, { transferRef: "DUP 5551 11222" });
    await db.insert(receiptReferences).values({ userId: s.userId, normalizedRef: "AISEEN444333", firstRunId: firstRun!.id });

    const openDue = await createDue(db, { userId: s.userId, test: false, workflowId: s.workflowId, runId: firstRun!.id, stepId: "open_due", reference: "RES-NEW", kind: "deposit", amountCentavos: 50000, conversationId: c.id });

    await post(s.path, [photoMsg("psid-dup", "m_dup_1", "Ref DUP-5551-11222")]);
    await post(s.path, [photoMsg("psid-dup", "m_dup_2", "Ref AISEEN444333")]);
    const claims = await db.select().from(paymentClaims).where(eq(paymentClaims.dueId, openDue.id));
    expect(claims).toHaveLength(2);
    expect(claims.every((cl) => cl.flags.includes("duplicate_reference"))).toBe(true);
    expect((await db.select().from(paymentDues).where(eq(paymentDues.id, openDue.id)))[0]!.status).toBe("pending");
  });

  it("creates no claim when the conversation has no open due or its due expired", async () => {
    const s = await setup();
    // No open due at all.
    await post(s.path, [photoMsg("psid-nodue", "m_nodue_1", "Here is a photo of my dog")]);
    expect(await db.select().from(paymentClaims).where(eq(paymentClaims.userId, s.userId))).toHaveLength(0);

    // Create a due, expire it (clears open_due_id), then send a photo -> no claim.
    const c = await conversationOf(s.userId, "psid-nodue");
    const [run] = await runsOf(s.workflowId);
    const d = await createDue(db, { userId: s.userId, test: false, workflowId: s.workflowId, runId: run!.id, stepId: "exp_due", reference: "RES-EXP", kind: "deposit", amountCentavos: 50000, conversationId: c.id });
    expect((await conversationOf(s.userId, "psid-nodue")).openDueId).toBe(d.id);
    await expireDue(db, { userId: s.userId, runId: run!.id, stepId: "expire", dueStepId: "exp_due" });
    expect((await conversationOf(s.userId, "psid-nodue")).openDueId).toBeNull();
    await post(s.path, [photoMsg("psid-nodue", "m_nodue_2", "Late receipt photo")]);
    expect(await db.select().from(paymentClaims).where(eq(paymentClaims.dueId, d.id))).toHaveLength(0);
  });

  it("R6 export and delete cover a due linked through conversations.open_due_id and its DM receipt image", async () => {
    const s = await setup();
    await post(s.path, [inbound("psid-r6-due", "m_r6d_1", "Email me at guest.r6@resort.test")]);
    const c = await conversationOf(s.userId, "psid-r6-due");
    // Due created by a separate run (no email in trigger payload) linked only via conversations.open_due_id.
    const [v] = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, s.workflowId));
    const [staffRun] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: { staff: true } }).returning();
    const d = await createDue(db, { userId: s.userId, test: false, workflowId: s.workflowId, runId: staffRun!.id, stepId: "ask_dep", reference: "RES-R6", kind: "deposit", amountCentavos: 50000, conversationId: c.id });
    await post(s.path, [photoMsg("psid-r6-due", "m_r6d_2", "Ref R6RECEIPT99")]);

    const exp = await exportCustomer(db, s.userId, s.userId, { email: "guest.r6@resort.test" });
    expect(exp.counts).toMatchObject({ conversations: 1, dues: 1, claims: 1 });
    expect(exp.claims[0]!.imageBase64).not.toBeNull();

    const del = await deleteCustomer(db, s.userId, s.userId, { email: "guest.r6@resort.test" });
    expect(del.kept.map((k) => k.item)).toContain("payment_dues");
    const [claimAfter] = await db.select().from(paymentClaims).where(eq(paymentClaims.dueId, d.id));
    expect(claimAfter!.image).toBeNull();
    expect(claimAfter!.transferRef).toBeNull();
  });
});

describe("C7 conversations inbox, alerts, digest, and privacy", () => {
  async function memberAgent(workspaceId: string, role: "operator" | "approver" | "requester") {
    const [u] = await db.insert(users).values({ email: `c7-${role}-${++seq}@test.local`, passwordHash: "x" }).returning();
    await joinWorkspace(db, u!.id, workspaceId, role);
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    return request.agent(server).set("Cookie", `daloy_session=${token}`);
  }

  it("orders Needs staff first, updates fields, starts deposit requests, and enforces role access", async () => {
    const s = await setup();
    await post(s.path, [inbound("psid-bot", "m_c7_1", "Bot active conversation")]);
    await new Promise((r) => setTimeout(r, 10));
    await post(s.path, [inbound("psid-staff", "m_c7_2", "Needs staff conversation")]);

    const botConvo = await conversationOf(s.userId, "psid-bot");
    const staffConvo = await conversationOf(s.userId, "psid-staff");

    // Take over staffConvo and make botConvo newer -> Needs staff must still sort first.
    await s.agent.post(`/conversations/${staffConvo.id}/take-over`).expect(200);
    await post(s.path, [inbound("psid-bot", "m_c7_3", "Newer message")]);

    const listRes = await s.agent.get("/conversations").expect(200);
    expect(listRes.body.conversations.map((c: { id: string }) => c.id)).toEqual([staffConvo.id, botConvo.id]);
    expect((await digestCounts(db, s.userId)).conversationsWaiting).toBe(1);

    // Edit and clear fields
    const patched = await s.agent.put(`/conversations/${staffConvo.id}/fields`).send({ name: "Marco Santos", check_in: "2027-02-10", nights: "2", guests: "2" }).expect(200);
    expect(patched.body.fields).toEqual({ name: "Marco Santos", check_in: "2027-02-10", guests: "2" });

    // Deposit request refuses with 409 until a manual payment_due workflow is published
    await s.agent.post(`/conversations/${staffConvo.id}/deposit-request`).send({ checkIn: "2027-02-10", nights: 2 }).expect(409);

    const depWf = await s.agent.post("/workflows").send({ name: "Deposit and stay", slug: `dep-${++seq}` }).expect(201);
    const depDef = {
      trigger: { type: "manual", config: {} },
      steps: [{ id: "ask", type: "payment_due", config: { reference: "DEP-{{trigger.name}}", kind: "deposit", amount: "1500", checkout: false } }],
      edges: [],
    };
    await s.agent.post(`/workflows/${depWf.body.id}/versions`).send({ definition: depDef, publish: true }).expect(201);

    const depRes = await s.agent.post(`/conversations/${staffConvo.id}/deposit-request`).send({ room: "Garden room", checkIn: "2027-02-10", nights: 2, guests: 2 }).expect(202);
    expect(depRes.body.runId).toBeTruthy();

    // Operator can manage conversations & deposit requests, but gets 403 on settings and R6 export/delete; approver/requester get 403 everywhere.
    const op = await memberAgent(s.userId, "operator");
    await op.get("/conversations").expect(200);
    await op.post(`/conversations/${staffConvo.id}/hand-back`).expect(200);
    expect((await digestCounts(db, s.userId)).conversationsWaiting).toBe(0);
    await op.put("/conversations/settings").send({ staffQuietHours: 6 }).expect(403);
    await op.post(`/conversations/${staffConvo.id}/export`).send({}).expect(403);
    await op.post(`/conversations/${staffConvo.id}/delete`).send({ confirm: "DELETE" }).expect(403);

    for (const denied of [await memberAgent(s.userId, "approver"), await memberAgent(s.userId, "requester")]) {
      await denied.get("/conversations").expect(403);
      await denied.post(`/conversations/${staffConvo.id}/take-over`).expect(403);
    }

    // Guest without email or phone can still be exported and deleted by conversationId, and POST /privacy/customer/export works (L2).
    const exp = await s.agent.post(`/conversations/${staffConvo.id}/export`).send({}).expect(200);
    expect(exp.body.counts).toMatchObject({ conversations: 1 });
    await s.agent.post(`/conversations/${staffConvo.id}/delete`).send({ confirm: "DELETE" }).expect(200);
    await s.agent.get(`/conversations/${staffConvo.id}`).expect(404);
    await s.agent.post("/privacy/customer/export").send({ email: "nobody@resort.test" }).expect(200);
  });

  it("alerts staff on Messenger while their 24h window is open, then falls back to Telegram and email without leaking guest text", async () => {
    const s = await setup();
    await post(s.path, [inbound("psid-guest", "m_alert_1", "SECRET_MESSAGE_DO_NOT_LEAK_TO_ALERT")]);
    const guest = await conversationOf(s.userId, "psid-guest");
    await s.agent.put(`/conversations/${guest.id}/fields`).send({ name: "Lia Cruz", check_in: "2027-03-01", check_out: "2027-03-03", guests: "3" }).expect(200);

    // 1. No Messenger staff PSID, no Telegram -> falls back to installation email
    const emailAlert = await s.agent.post(`/conversations/${guest.id}/alert`).send({ reason: "Price question" }).expect(200);
    expect(emailAlert.body.channel).toBe("email");
    expect(mailSent).toHaveLength(1);
    expect(mailSent[0]!.text).toContain("Lia (Messenger, 2027-03-01 to 2027-03-03, 3 guests)");
    expect(mailSent[0]!.text).toContain("https://daloy.test/#/conversations");
    expect(mailSent[0]!.text).not.toContain("SECRET_MESSAGE_DO_NOT_LEAK_TO_ALERT");

    // 2. Connect Telegram -> falls back to Telegram
    const tgToken = "123456789:TestTelegramBotToken_1234567890abcdef"; // gitleaks:allow
    fake.telegram.token = tgToken;
    await s.agent.put("/settings/connections/telegram").send({ token: tgToken, chatId: "-1001234567890" }).expect(200);
    const tgAlert = await s.agent.post(`/conversations/${guest.id}/alert`).send({}).expect(200);
    expect(tgAlert.body.channel).toBe("telegram");
    expect(fake.telegram.messages).toHaveLength(1);
    expect(fake.telegram.messages[0]!.text).not.toContain("SECRET_MESSAGE_DO_NOT_LEAK_TO_ALERT");

    // 3. Configure staff PSID whose 24h Messenger window is open -> uses Messenger directly
    await post(s.path, [inbound("psid-staff-owner", "m_staff_in", "Hi bot")]);
    await s.agent.put("/conversations/settings").send({ staffAlertPsid: "psid-staff-owner" }).expect(200);
    const metaAlert = await s.agent.post(`/conversations/${guest.id}/alert`).send({}).expect(200);
    expect(metaAlert.body.channel).toBe("messenger");
    expect(fake.meta.messages.some((m) => m.recipientId === "psid-staff-owner")).toBe(true);

    // 4. Close staff PSID window (> 24h ago) -> status reports fallback and alert uses Telegram
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 25 * HOUR) }).where(and(eq(conversations.userId, s.userId), eq(conversations.externalId, "psid-staff-owner")));
    const statusRes = await s.agent.get("/conversations").expect(200);
    expect(statusRes.body.alertStatus).toMatchObject({ staffWindowOpen: false, activeChannel: "telegram" });
    const fallbackAlert = await s.agent.post(`/conversations/${guest.id}/alert`).send({}).expect(200);
    expect(fallbackAlert.body.channel).toBe("telegram");
  });
});

describe("C8 resort concierge template on fake providers", () => {
  it("handles a menu tap, priced knowledge answer, guarded handoff, and superseded follow-up", async () => {
    const dmTemplate = TEMPLATES.find((t) => t.slug === "resort-concierge-dm")!;
    let nextAiReply: Record<string, unknown> = {};
    const aiServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: { role: "assistant", content: JSON.stringify(nextAiReply) }, prompt_eval_count: 10, eval_count: 10 }));
      });
    });
    await new Promise<void>((r) => aiServer.listen(0, "127.0.0.1", r));
    vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${(aiServer.address() as AddressInfo).port}`);

    try {
      const email = `c8-${++seq}@test.local`;
      const agent = request.agent(server);
      await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201); // gitleaks:allow
      const [u] = await db.select().from(users).where(eq(users.email, email));
      await agent.put("/settings/connections/meta-messenger").send({ pageId: PAGE_ID, pageAccessToken: PAGE_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN }).expect(200);

      const entry = (await agent.post("/knowledge/entries").send({ kind: "room", title: "Garden room", body: "Fan cottage near the beach.", fields: { price: 3500, unit: "night", capacity: 4, deposit: { mode: "percent", value: 30 } } }).expect(201)).body;
      await agent.post("/knowledge/publish").expect(201);

      const wf = await agent.post("/workflows").send({ name: "Resort Concierge", slug: `c8-dm-${seq}` }).expect(201);
      await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: dmTemplate.definition, publish: true }).expect(201);
      const [c] = await db.select().from(connections).where(and(eq(connections.userId, u!.id), eq(connections.provider, "meta_messenger")));
      const webhookPath = (c!.destination as { webhookPath: string }).webhookPath;

      // 1. Menu tap ("rates") + priced knowledge answer -> sends guarded rate reply + schedules 20h follow-up.
      nextAiReply = {
        reply: "Our Garden room is 3,500 pesos per night for up to 4 guests.",
        entryIds: [entry.id],
        intent: "rates",
        needsHuman: false,
        fields: { guests: "2", name: "Ana Reyes" },
      };
      await post(webhookPath, [{ sender: { id: "psid-c8-guest" }, recipient: { id: PAGE_ID }, timestamp: Date.now(), message: { mid: "m_c8_1", text: "Rates", quick_reply: { payload: "rates" } } }]);
      const [run1] = await runsOf(wf.body.id);
      expect(await drive(run1!.id)).toBe("waiting");
      await runDueDeliveries(db, secretsKey, fake.urls);
      expect(fake.meta.messages).toHaveLength(1);
      expect(fake.meta.messages[0]!.text).toContain("3,500 pesos");
      expect(fake.meta.messages[0]!.quickReplies).toHaveLength(6);
      expect((await conversationOf(u!.id, "psid-c8-guest")).fields).toMatchObject({ guests: "2", name: "Ana Reyes" });

      // 2. Guest sends a newer message before the 20h follow-up -> run1 supersedes cleanly without sending follow-up,
      //    and an unsafe AI price triggers guardReply swap + handoff reply + Needs staff status + staff email alert.
      nextAiReply = {
        reply: "Special deal: 1,999 pesos per night! Check-in Dec 20.",
        entryIds: [entry.id],
        intent: "question",
        needsHuman: false,
        fields: { check_in: "2027-12-20" },
      };
      await post(webhookPath, [inbound("psid-c8-guest", "m_c8_2", "May promo ba sa Dec 20? Text +63 917 555 0101")]);

      // Advancing wait_followup on superseded run1 must cancel it cleanly rather than firing send_followup.
      await db.update(runs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(runs.id, run1!.id));
      await advance(deps(), run1!.id);
      expect(await drive(run1!.id)).toBe("cancelled");

      const [, run2] = await runsOf(wf.body.id);
      expect(await drive(run2!.id)).toBe("succeeded");
      await runDueDeliveries(db, secretsKey, fake.urls);

      expect(fake.meta.messages).toHaveLength(2);
      expect(fake.meta.messages[1]!.text).toContain("Our team will confirm the rate and reply here shortly.");
      expect(fake.meta.messages[1]!.text).not.toContain("1,999");

      const convo = await conversationOf(u!.id, "psid-c8-guest");
      expect(convo.status).toBe("staff");
      expect(convo.fields).toMatchObject({ check_in: "2027-12-20", phone: "+639175550101" });
      expect(mailSent.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.unstubAllEnvs();
      aiServer.closeAllConnections();
      aiServer.close();
    }
  });
});

describe("C9 conversations security hardening", () => {
  it("handles empty settings updates cleanly, sanitizes alert header characters, and isolates workspaces", async () => {
    const a = await setup();
    const b = await setup();

    // Finding #3: empty body on PUT /conversations/settings must return 200 without attempting empty Drizzle .set({})
    const emptyPut = await a.agent.put("/conversations/settings").send({}).expect(200);
    expect(emptyPut.body.settings).toMatchObject({ conversationRetentionDays: 90, staffQuietHours: 12 });

    // Create a guest conversation in workspace A with control characters and oversized fields
    await post(a.path, [inbound("psid-sec-a", "m_sec_1", "Hello there")]);
    const convoA = await conversationOf(a.userId, "psid-sec-a");
    await a.agent.put(`/conversations/${convoA.id}/fields`).send({ name: "Evil\r\nBcc: victim@test.local" }).expect(200);

    await a.agent.post(`/conversations/${convoA.id}/alert`).send({ reason: "Line1\r\nLine2\tExtra" }).expect(200);
    expect(mailSent).toHaveLength(1);
    expect(mailSent[0]!.subject).not.toMatch(/[\r\n]/);
    expect(mailSent[0]!.text).not.toMatch(/[\r\n]/);

    // Cross-workspace reads, field edits, alerts, deposits, exports and deletes are denied with 404
    await b.agent.get(`/conversations/${convoA.id}`).expect(404);
    await b.agent.put(`/conversations/${convoA.id}/fields`).send({ name: "Hacker" }).expect(404);
    await b.agent.post(`/conversations/${convoA.id}/alert`).send({}).expect(404);
    await b.agent.post(`/conversations/${convoA.id}/export`).send({}).expect(404);
    await b.agent.post(`/conversations/${convoA.id}/delete`).send({ confirm: "DELETE" }).expect(404);
  });
});
