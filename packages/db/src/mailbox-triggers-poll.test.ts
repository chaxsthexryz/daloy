import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { pollGoogleTriggers } from "./google-triggers";
import type { Db } from "./index";
import { pollMailboxTriggers } from "./mailbox-triggers";
import { consumeFlow, finishFlow, gmail, outlook, startFlow } from "./oauth";
import type { ProviderUrls } from "./providers";
import { connections, mailSenders, triggerPolls, triggers, users, workflows, workflowVersions } from "./schema";

// G3 (decision 0132): Gmail and Outlook mailbox trigger poll against fake Google / Microsoft Graph APIs.
const key = randomBytes(32);
const ANA_GMAIL = { id: "google-ana-g3", email: "ana-g3@gmail.com" };
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let seq = 0;
const enqueued: string[] = [];
const enqueue = async (runId: string) => void enqueued.push(runId);

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  const g = fake.addOAuthApp("google", { rotation: "none" });
  g.user = ANA_GMAIL;
  urls = {
    ...fake.urls,
    timeoutMs: 2000,
    googleOAuth: { clientId: g.clientId, clientSecret: g.clientSecret, ...fake.oauthUrls("google") },
    microsoft: { clientId: fake.microsoft.clientId, clientSecret: fake.microsoft.clientSecret, tenant: "organizations" },
  };
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

beforeEach(() => {
  fake.gmail.inbox.length = 0;
  fake.microsoft.inbox.length = 0;
  fake.microsoft.consent = "grant";
  fake.microsoft.grantScopes = null;
  Object.assign(fake.oauth.google!, { consent: "grant", user: ANA_GMAIL, emailVerified: true, grantScopes: [] });
});

async function automation(trigger: { type: string; config: Record<string, unknown> }, steps: unknown[] = [{ id: "wait", type: "delay", config: { seconds: 5 } }]) {
  const [u] = await db.insert(users).values({ email: `g3-${++seq}@test.local`, passwordHash: "x" }).returning();
  const [w] = await db.insert(workflows).values({ userId: u!.id, name: "Mailbox watcher", slug: `mb-${seq}` }).returning();
  await db.insert(workflowVersions).values({ workflowId: w!.id, version: 1, definition: { trigger, steps, edges: [] }, published: true });
  await db.insert(triggers).values({ workflowId: w!.id, type: trigger.type, config: trigger.config });
  return { ws: u!.id, workflowId: w!.id };
}

async function connectGmailWithRead(ws: string) {
  const back = new URL((await fetch(await startFlow(db, key, urls, "http://localhost:3000", gmail, { workspaceId: ws, memberId: ws }), { redirect: "manual" })).headers.get("location")!);
  const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: ws, memberId: ws });
  expect(await finishFlow(db, key, urls, "http://localhost:3000", gmail, ws, back.searchParams.get("code")!, flow!.verifier)).toBe("connected");
  await db
    .update(mailSenders)
    .set({ scopes: "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly" })
    .where(eq(mailSenders.userId, ws));
}

async function connectOutlook(ws: string, grantScopes: string[] | null = null) {
  fake.microsoft.grantScopes = grantScopes;
  const back = new URL((await fetch(await startFlow(db, key, urls, "http://localhost:3000", outlook, { workspaceId: ws, memberId: ws }), { redirect: "manual" })).headers.get("location")!);
  const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: ws, memberId: ws });
  expect(await finishFlow(db, key, urls, "http://localhost:3000", outlook, ws, back.searchParams.get("code")!, flow!.verifier)).toBe("connected");
}

const poll = () => pollMailboxTriggers({ db, secretsKey: key, urls, enqueue });
const due = (workflowId: string) => db.update(triggerPolls).set({ nextPollAt: sql`now()` }).where(eq(triggerPolls.workflowId, workflowId));
const state = async (workflowId: string) => (await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, workflowId)))[0]!;
const runsOf = async (workflowId: string) =>
  (await db.execute<{ id: string; trigger_payload: Record<string, unknown> }>(sql`select r.id, r.trigger_payload from runs r join workflow_versions v on v.id = r.workflow_version_id where v.workflow_id = ${workflowId} order by r.created_at`)).rows;

describe("gmail_message", () => {
  it("baselines on first poll, filters by sender/subject/label, deduplicates replays, and skips self messages", async () => {
    fake.gmail.inbox.push({
      id: "gm-old",
      labelIds: ["INBOX", "Label_orders"],
      from: "buyer@example.com",
      subject: "Invoice old",
      text: "Before trigger enabled",
      internalDate: String(Date.now() - 60_000),
    });
    const a = await automation({ type: "gmail_message", config: { from: "buyer@", subjectContains: "Invoice", label: "Orders" } });
    await connectGmailWithRead(a.ws);

    await poll();
    expect(await runsOf(a.workflowId)).toEqual([]);
    expect(await state(a.workflowId)).toMatchObject({ problem: null, failures: 0 });
    expect((await state(a.workflowId)).cursor).toHaveProperty("since");

    // Ensure pollGoogleTriggers never claims or deletes mailbox trigger_polls rows.
    await due(a.workflowId);
    expect(await pollGoogleTriggers({ db, secretsKey: key, urls, enqueue })).toBe(0);
    expect(await state(a.workflowId)).toBeDefined();

    const nowMs = Date.now() + 2000;
    fake.gmail.inbox.push(
      {
        id: "gm-match",
        labelIds: ["INBOX", "Label_orders"],
        from: "Buyer <buyer@example.com>",
        replyTo: "reply-buyer@example.com",
        subject: "Invoice #42",
        text: "Please confirm order 42.",
        messageId: "<msg-42@example.com>",
        inReplyTo: "<root@example.com\r\nX-Injected: bad>",
        references: ["<ref-1@example.com>"],
        internalDate: String(nowMs),
      },
      {
        id: "gm-wrong-subj",
        labelIds: ["INBOX", "Label_orders"],
        from: "buyer@example.com",
        subject: "Hello there",
        text: "Ignored",
        internalDate: String(nowMs + 100),
      },
      {
        id: "gm-self",
        labelIds: ["INBOX", "Label_orders"],
        from: ANA_GMAIL.email,
        subject: "Invoice self",
        text: "Should be skipped",
        internalDate: String(nowMs + 200),
      },
    );

    await due(a.workflowId);
    await poll();
    const rows = await runsOf(a.workflowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger_payload).toMatchObject({
      from: "Buyer <buyer@example.com>",
      replyTo: "reply-buyer@example.com",
      subject: "Invoice #42",
      text: "Please confirm order 42.",
      messageId: "<msg-42@example.com>",
      references: ["<ref-1@example.com>"],
      gmailMessageId: "gm-match",
    });
    expect(rows[0]!.trigger_payload.inReplyTo).toBeUndefined();
    expect(enqueued).toContain(rows[0]!.id);

    // Crash recovery: rewinding cursor still finds existing run_keys row and starts nothing new.
    await db.update(triggerPolls).set({ cursor: { since: new Date(nowMs - 1000).toISOString() }, nextPollAt: sql`now()` }).where(eq(triggerPolls.workflowId, a.workflowId));
    await poll();
    expect(await runsOf(a.workflowId)).toHaveLength(1);

    // Changing label starts over with a new first poll.
    const [v] = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, a.workflowId));
    await db.update(workflowVersions).set({ definition: { ...(v!.definition as object), trigger: { type: "gmail_message", config: { label: "INBOX" } } } }).where(eq(workflowVersions.id, v!.id));
    await due(a.workflowId);
    await poll();
    expect(await runsOf(a.workflowId)).toHaveLength(1);
    expect((await state(a.workflowId)).source).toBe(`gmail:${ANA_GMAIL.email}:INBOX`);
  });

  it("pauses when send-only scope or self-loop is found, and backs off on 429", async () => {
    const a = await automation({ type: "gmail_message", config: {} });
    await connectGmailWithRead(a.ws);
    await db.update(mailSenders).set({ scopes: "openid email https://www.googleapis.com/auth/gmail.send" }).where(eq(mailSenders.userId, a.ws));
    await poll();
    expect((await state(a.workflowId)).problem).toContain("gmail.readonly");

    await db.update(mailSenders).set({ scopes: "openid email https://www.googleapis.com/auth/gmail.readonly" }).where(eq(mailSenders.userId, a.ws));
    await due(a.workflowId);
    await poll(); // baseline
    fake.once("/gmail/v1/users/me/messages", { status: 429, body: { error: { code: 429, message: "Rate limit" } } });
    await due(a.workflowId);
    await poll();
    const backedOff = await state(a.workflowId);
    expect(backedOff.failures).toBe(1);
    expect(backedOff.problem).toMatch(/limiting requests/);
    expect(backedOff.nextPollAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

    const loop = await automation({ type: "gmail_message", config: {} }, [{ id: "s", type: "email", config: { to: ANA_GMAIL.email, subject: "Re", text: "hi" } }]);
    await connectGmailWithRead(loop.ws);
    await poll();
    expect((await state(loop.workflowId)).problem).toMatch(/same Gmail address/);
  });
});

describe("outlook_message", () => {
  it("baselines on first poll, reads folder messages after cursor, skips drafts/self, and deduplicates", async () => {
    fake.microsoft.inbox.push({
      id: "om-old",
      from: "client@example.com",
      subject: "Order old",
      text: "Before",
      receivedDateTime: new Date(Date.now() - 60_000).toISOString(),
      parentFolderId: "orders-folder",
    });
    const a = await automation({ type: "outlook_message", config: { from: "client@", subjectContains: "Order", folder: "Orders" } });
    await connectOutlook(a.ws);

    await poll();
    expect(await runsOf(a.workflowId)).toEqual([]);

    const t = Date.now() + 2000;
    fake.microsoft.inbox.push(
      {
        id: "om-match",
        from: "client@example.com",
        fromName: "Client One",
        subject: "Order #77",
        text: "Please ship order 77.",
        receivedDateTime: new Date(t).toISOString(),
        parentFolderId: "orders-folder",
      },
      {
        id: "om-draft",
        from: "client@example.com",
        subject: "Order draft",
        text: "Draft",
        receivedDateTime: new Date(t + 100).toISOString(),
        parentFolderId: "orders-folder",
        isDraft: true,
      },
      {
        id: "om-self",
        from: fake.microsoft.user.mail,
        subject: "Order #77",
        text: "Own reply",
        receivedDateTime: new Date(t + 200).toISOString(),
        parentFolderId: "orders-folder",
      },
      {
        id: "om-other-folder",
        from: "client@example.com",
        subject: "Order #78",
        text: "In inbox",
        receivedDateTime: new Date(t + 300).toISOString(),
        parentFolderId: "inbox",
      },
    );

    await due(a.workflowId);
    await poll();
    const rows = await runsOf(a.workflowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger_payload).toMatchObject({
      from: "Client One <client@example.com>",
      subject: "Order #77",
      text: "Please ship order 77.",
      outlookMessageId: "om-match",
      folder: "Orders",
    });

    await due(a.workflowId);
    await poll();
    expect(await runsOf(a.workflowId)).toHaveLength(1);
  });

  it("pauses when Mail.Read is missing or self-loop exists, and resumes once reconnected with Mail.Read", async () => {
    const a = await automation({ type: "outlook_message", config: {} });
    await connectOutlook(a.ws, ["Mail.Send", "User.Read"]);
    await poll();
    expect((await state(a.workflowId)).problem).toBe("Reconnect Outlook in Apps and allow reading mail (Mail.Read).");

    await connectOutlook(a.ws, ["Mail.Send", "Mail.Read", "User.Read"]);
    await due(a.workflowId);
    await poll();
    expect((await state(a.workflowId)).problem).toBeNull();
    expect((await state(a.workflowId)).cursor).toHaveProperty("since");

    const loop = await automation({ type: "outlook_message", config: {} }, [{ id: "o", type: "outlook", config: { to: fake.microsoft.user.mail, subject: "Re", text: "hi" } }]);
    await connectOutlook(loop.ws);
    await poll();
    expect((await state(loop.workflowId)).problem).toMatch(/same Outlook address/);
    // Also verify connections scope check wasn't bypassed.
    const [conn] = await db.select({ scopes: connections.scopes }).from(connections).where(eq(connections.userId, a.ws));
    expect(conn!.scopes).toContain("Mail.Read");
  });
});
