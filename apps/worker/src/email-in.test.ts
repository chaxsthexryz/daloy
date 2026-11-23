import { randomBytes } from "node:crypto";
import {
  conversations,
  emailSources,
  readEmailSource,
  saveEmailSource,
  disconnectEmailSource,
  requestEmailSourceCheck,
  syncEmailSourceOnPublish,
  runs,
  users,
  workflows,
  workflowVersions,
  triggers,
  type Db,
} from "@daloy/db";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { pollEmailSources, UID_CHANGED, type ImapAdapter, type ImapMessage } from "./email-in";

let db: Db;
let pool: Pool;
const key = randomBytes(32);
let seq = 0;
const input = { host: "imap.example.com", username: "office@example.com", password: "synthetic-password", folder: "INBOX" };
const payload = {
  from: "visitor@example.com",
  replyTo: "visitor@example.com",
  to: ["office@example.com"],
  subject: "New inquiry",
  text: "A website inquiry.",
  messageId: "<one@example.com>",
  receivedAt: "2026-11-17T10:00:00.000Z",
};
async function setup(source = input) {
  const user = (
    await db
      .insert(users)
      .values({ email: `intake${++seq}@test.local`, passwordHash: "x" })
      .returning()
  )[0]!;
  const wf = (await db.insert(workflows).values({ userId: user.id, name: "Email intake", slug: "email" }).returning())[0]!;
  await db
    .insert(workflowVersions)
    .values({
      workflowId: wf.id,
      version: 1,
      definition: { trigger: { type: "email", config: {} }, steps: [], edges: [] },
      published: true,
    });
  await db.insert(triggers).values({ workflowId: wf.id, type: "email", config: {} });
  await saveEmailSource(db, key, user.id, wf.id, source);
  return { userId: user.id, workflowId: wf.id };
}
function mailbox(
  options: { uidValidity?: string; uidNext?: number; messages?: ImapMessage[]; hold?: () => Promise<void>; fail?: boolean } = {},
): ImapAdapter {
  return async () => {
    await options.hold?.();
    if (options.fail) throw new Error(`server response contains ${input.password}`);
    return {
      uidValidity: options.uidValidity ?? "77",
      uidNext: options.uidNext ?? 5,
      readBatch: async (after) => ({
        messages: (options.messages ?? []).filter((m) => m.uid > after),
        throughUid: Math.max(after, (options.uidNext ?? 5) - 1),
      }),
      close: async () => {},
    };
  };
}
const poll = (adapter: ImapAdapter) => pollEmailSources({ db, secretsKey: key, adapter, intervalMs: 0, enqueue: async () => {} });
const due = () => db.update(emailSources).set({ nextPollAt: new Date(0) });
beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);
afterAll(async () => {
  await pool?.end();
});
beforeEach(async () => {
  await db.delete(emailSources);
});

describe("email intake checkpoint", () => {
  it("becomes ready after the first baseline without importing old messages; imports new mail once", async () => {
    const own = await setup();
    await poll(mailbox({ messages: [{ uid: 4, payload }] }));
    expect(await readEmailSource(db, own.workflowId)).toMatchObject({ status: "active" });
    expect(await db.select().from(runs)).toHaveLength(0);
    await due();
    await poll(mailbox({ uidNext: 6, messages: [{ uid: 5, payload }] }));
    const first = await db.select().from(runs);
    expect(first).toHaveLength(1);
    expect(first[0]!.triggerPayload).toMatchObject(payload);
    await due();
    await poll(mailbox({ uidNext: 6, messages: [{ uid: 5, payload }] }));
    expect(await db.select().from(runs)).toHaveLength(1);
    // The sender's conversation (decision 0115), keyed by the lowercased reply address, holds the message once.
    const [c] = await db.select().from(conversations).where(eq(conversations.externalId, "visitor@example.com"));
    expect(c).toMatchObject({ channel: "email", version: 1 });
    expect(first[0]).toMatchObject({ conversationId: c!.id, conversationVersion: 1 });
    expect((first[0]!.triggerPayload as { conversation: { history: { text: string }[] } }).conversation.history).toEqual([expect.objectContaining({ text: "New inquiry\n\nA website inquiry." })]);
  });

  it("only one of two simultaneous polls claims a source", async () => {
    const own = await setup();
    await poll(mailbox());
    let connects = 0;
    const adapter: ImapAdapter = async (s) => {
      connects++;
      return mailbox({ uidNext: 7, messages: [{ uid: 6, payload }] })(s);
    };
    await db
      .update(emailSources)
      .set({ nextPollAt: new Date(0) })
      .where(eq(emailSources.workflowId, own.workflowId));
    await Promise.all([
      pollEmailSources({ db, secretsKey: key, adapter, intervalMs: 60_000, enqueue: async () => {} }),
      pollEmailSources({ db, secretsKey: key, adapter, intervalMs: 60_000, enqueue: async () => {} }),
    ]);
    expect(connects).toBe(1);
  });
  it("a disconnected or replaced source rejects an old poll's baseline and errors", async () => {
    const own = await setup();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r));
    const held = new Promise<void>((r) => (release = r));
    const polling = poll(
      mailbox({
        hold: async () => {
          entered();
          await held;
        },
        fail: true,
      }),
    );
    await ready;
    await disconnectEmailSource(db, own.workflowId);
    release();
    await polling;
    expect(await readEmailSource(db, own.workflowId)).toMatchObject({ status: "disconnected", lastError: null });
  });
  it("pauses on UIDVALIDITY changes until an explicit new-mail restart", async () => {
    const own = await setup();
    await poll(mailbox());
    await due();
    await poll(mailbox({ uidValidity: "88", uidNext: 10 }));
    expect(await readEmailSource(db, own.workflowId)).toMatchObject({ status: "failed", lastError: UID_CHANGED });
    await requestEmailSourceCheck(db, own.workflowId);
    await poll(mailbox({ uidValidity: "88", uidNext: 10 }));
    const [row] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    expect(row).toMatchObject({ uidValidity: "88", lastUid: 9, status: "active" });
  });
  it("keeps a committed pending run recoverable when enqueue fails", async () => {
    const own = await setup();
    await poll(mailbox());
    await due();
    await pollEmailSources({
      db,
      secretsKey: key,
      intervalMs: 0,
      adapter: mailbox({ uidNext: 8, messages: [{ uid: 7, payload }] }),
      enqueue: async () => {
        throw new Error("queue unavailable");
      },
    });
    const [row] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    expect(row!.lastUid).toBe(7);
    const found = await db
      .select()
      .from(runs)
      .where(sql`${runs.workflowVersionId} in (select id from workflow_versions where workflow_id = ${own.workflowId})`);
    expect(found).toHaveLength(1);
    expect(found[0]!.state).toBe("pending");
  });
  it("does not ingest draft mail, mail while another trigger is live, or disconnected-interval mail", async () => {
    const own = await setup();
    await db.update(triggers).set({ type: "manual" }).where(eq(triggers.workflowId, own.workflowId));
    await poll(mailbox({ uidNext: 6 }));
    expect(await readEmailSource(db, own.workflowId)).toMatchObject({ status: "active", listening: false });
    await db.transaction(async (tx) => {
      await syncEmailSourceOnPublish(tx, own.workflowId, "email");
      await tx.update(triggers).set({ type: "email" }).where(eq(triggers.workflowId, own.workflowId));
    });
    await poll(mailbox({ uidNext: 10, messages: [{ uid: 8, payload }] }));
    let [row] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    expect(row).toMatchObject({ listening: true, lastUid: 9 });
    const before = (await db.select().from(runs)).length;
    await disconnectEmailSource(db, own.workflowId);
    await saveEmailSource(db, key, own.userId, own.workflowId, input);
    await poll(mailbox({ uidNext: 15, messages: [{ uid: 12, payload }] }));
    [row] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    expect(row!.lastUid).toBe(14);
    expect(await db.select().from(runs)).toHaveLength(before);
  });
  it("separates folders whose servers use the same UIDVALIDITY and UID", async () => {
    const own = await setup();
    await poll(mailbox());
    await due();
    await poll(mailbox({ uidNext: 6, messages: [{ uid: 5, payload }] }));
    const before = (await db.select().from(runs)).length;
    await saveEmailSource(db, key, own.userId, own.workflowId, { ...input, folder: "Website" });
    await poll(mailbox());
    await due();
    await poll(mailbox({ uidNext: 6, messages: [{ uid: 5, payload }] }));
    expect(await db.select().from(runs)).toHaveLength(before + 1);
  });
  it("retries a temporary network error without resetting the cursor", async () => {
    const own = await setup();
    await poll(mailbox());
    await due();
    await poll(mailbox({ fail: true }));
    expect(await readEmailSource(db, own.workflowId)).toMatchObject({ status: "pending" });
    expect(JSON.stringify(await readEmailSource(db, own.workflowId))).not.toContain(input.password);
    await due();
    await poll(mailbox({ uidNext: 6, messages: [{ uid: 5, payload }] }));
    const [row] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    expect(row).toMatchObject({ lastUid: 5, status: "active", listening: true });
  });
  it("keeps a superseded poll from importing or advancing after a password replacement", async () => {
    const own = await setup();
    await poll(mailbox());
    await due();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r));
    const held = new Promise<void>((r) => (release = r));
    const adapter: ImapAdapter = async () => ({
      uidValidity: "77",
      uidNext: 8,
      close: async () => {},
      readBatch: async () => {
        entered();
        await held;
        return { throughUid: 7, messages: [{ uid: 7, payload }] };
      },
    });
    const polling = poll(adapter);
    await ready;
    await saveEmailSource(db, key, own.userId, own.workflowId, { ...input, password: "replaced-password" });
    const count = (await db.select().from(runs)).length;
    release();
    await polling;
    expect(await db.select().from(runs)).toHaveLength(count);
    const [row] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
    expect(row).toMatchObject({ status: "pending", lastUid: 4 });
  });
  it("keeps skipped-message warnings visible on later empty checks", async () => {
    const own = await setup();
    await poll(mailbox());
    await due();
    const warning = "Skipped an email larger than 256 KB. Open the mailbox to read it.";
    await poll(mailbox({ uidNext: 6, messages: [{ uid: 5, payload: null, warning }] }));
    await due();
    await poll(mailbox({ uidNext: 6 }));
    expect(await readEmailSource(db, own.workflowId)).toMatchObject({ status: "active", lastError: warning });
  });
  it("reclaims an expired lease and fences the former worker's held response", async () => {
    const own = await setup();
    await poll(mailbox());
    await due();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => (entered = r));
    const held = new Promise<void>((r) => (release = r));
    const old: ImapAdapter = async () => ({
      uidValidity: "77",
      uidNext: 6,
      close: async () => {},
      readBatch: async () => {
        entered();
        await held;
        return { throughUid: 5, messages: [{ uid: 5, payload: { ...payload, subject: "old" } }] };
      },
    });
    const polling = poll(old);
    await ready;
    await db
      .update(emailSources)
      .set({ claimUntil: new Date(0), nextPollAt: new Date(0) })
      .where(eq(emailSources.workflowId, own.workflowId));
    const before = (await db.select().from(runs)).length;
    await poll(mailbox({ uidNext: 6, messages: [{ uid: 5, payload: { ...payload, subject: "current" } }] }));
    release();
    await polling;
    const all = await db.select().from(runs);
    expect(all).toHaveLength(before + 1);
    expect(all.at(-1)!.triggerPayload).toMatchObject({ subject: "current" });
  });
});

describe("email intake fairness (M13)", () => {
  it("polls another workspace's live mailbox before earlier-due failing drafts", async () => {
    const live = await setup();
    await poll(mailbox());
    for (let i = 0; i < 3; i++) {
      const draft = await setup({ ...input, username: `draft${i}@example.com` });
      await db.delete(triggers).where(eq(triggers.workflowId, draft.workflowId));
    }
    await db.update(emailSources).set({ nextPollAt: new Date(0) }).where(sql`${emailSources.workflowId} <> ${live.workflowId}`);
    await db.update(emailSources).set({ nextPollAt: new Date() }).where(eq(emailSources.workflowId, live.workflowId));
    const adapter: ImapAdapter = (s, signal) =>
      s.username.startsWith("draft")
        ? Promise.reject(new Error("slow failure"))
        : mailbox({ uidNext: 6, messages: [{ uid: 5, payload }] })(s, signal);
    const before = (await db.select().from(runs)).length;
    await poll(adapter);
    expect(await db.select().from(runs)).toHaveLength(before + 1);
  });
  it("backs a failing source off further each time and resets after a read", async () => {
    const own = await setup();
    const check = async (adapter: ImapAdapter) => {
      await pollEmailSources({ db, secretsKey: key, adapter, intervalMs: 1000, enqueue: async () => {} });
      const [row] = await db.select().from(emailSources).where(eq(emailSources.workflowId, own.workflowId));
      return { failures: row!.failures, wait: row!.nextPollAt.getTime() - Date.now() };
    };
    const first = await check(mailbox({ fail: true }));
    await due();
    const second = await check(mailbox({ fail: true }));
    await due();
    const ok = await check(mailbox());
    expect(first.failures).toBe(1);
    expect(second.failures).toBe(2);
    expect(second.wait).toBeGreaterThan(first.wait + 500);
    expect(ok.failures).toBe(0);
  });
});

describe("email intake and pause (N11b)", () => {
  it("starts no run from mail that arrives while paused, moves the checkpoint past it, and imports only later mail after the resume", async () => {
    const own = await setup();
    await poll(mailbox({ uidNext: 5 }));
    await db.update(workflows).set({ pausedAt: new Date() }).where(eq(workflows.id, own.workflowId));
    await due();
    await poll(mailbox({ uidNext: 6, messages: [{ uid: 5, payload }] }));
    const ofOwn = async () => (await db.select({ id: runs.id, payload: runs.triggerPayload }).from(runs).innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId)).where(eq(workflowVersions.workflowId, own.workflowId)));
    expect(await ofOwn()).toHaveLength(0);
    expect(await readEmailSource(db, own.workflowId)).toMatchObject({ status: "active" });
    await db.update(workflows).set({ pausedAt: null, resumedAt: new Date() }).where(eq(workflows.id, own.workflowId));
    await due();
    // The mail of the pause is not replayed; mail that arrives after the resume is.
    await poll(mailbox({ uidNext: 7, messages: [{ uid: 5, payload }, { uid: 6, payload: { ...payload, messageId: "<two@example.com>" } }] }));
    const made = await ofOwn();
    expect(made).toHaveLength(1);
    expect(made[0]!.payload).toMatchObject({ messageId: "<two@example.com>" });
  });
});

describe("email menu (C2)", () => {
  it("maps a reply of 2 to choice 2 of the workflow's email menu", async () => {
    const own = await setup();
    const menu = [
      { title: "Rooms", choice: "rooms" },
      { title: "Rates", choice: "rates" },
    ];
    const definition = { trigger: { type: "email", config: {} }, steps: [{ id: "answer", type: "email", config: { to: "{{trigger.replyTo}}", subject: "Re: {{trigger.subject}}", text: "Pili po:", menu } }], edges: [] };
    await db.update(workflowVersions).set({ definition }).where(eq(workflowVersions.workflowId, own.workflowId));
    await poll(mailbox());
    await due();
    const reply = { ...payload, subject: "Re: Pili po", text: "2\n\nOn Mon, the resort wrote:\n> 1. Rooms\n> 2. Rates" };
    await poll(mailbox({ uidNext: 8, messages: [{ uid: 5, payload: reply }, { uid: 6, payload: { ...reply, messageId: "<six@example.com>", text: "3" } }, { uid: 7, payload: { ...reply, messageId: "<seven@example.com>", text: "2 adults po" } }] }));
    const made = await db.select({ payload: runs.triggerPayload }).from(runs).innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId)).where(eq(workflowVersions.workflowId, own.workflowId));
    expect(made.map((r) => (r.payload as { choice?: string }).choice).sort()).toEqual(["rates", undefined, undefined]);
  });
});
