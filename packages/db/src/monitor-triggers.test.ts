import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import type { Db } from "./index";
import {
  evaluateFeedPoll,
  evaluatePagePoll,
  MonitorPollError,
  monitorSourceOf,
  monitorTriggerStatus,
  pollMonitorTriggers,
  type MonitorFetchResult,
} from "./monitor-triggers";
import { triggerPolls, triggers, users, workflows, workflowVersions } from "./schema";
import { QuotaError, usageSummary } from "./usage";

describe("evaluatePagePoll (pure)", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  const url = "https://supplier.example.com/rice";
  const src = monitorSourceOf({ type: "page_changed", config: { mode: "page", url, selector: ".price", maxChars: 4000 } });

  it("baselines on first poll without starting a run, skips 304 and unchanged content, and fires on change", () => {
    const first = evaluatePagePoll(null, { kind: "page", title: "Rice", text: "PHP 52", value: "PHP 52", etag: '"v1"' }, src, url, now);
    expect(first.items).toEqual([]);
    expect(first.cursor).toMatchObject({ mode: "page", value: "PHP 52", etag: '"v1"' });

    const notMod = evaluatePagePoll(first.cursor, { kind: "not_modified", etag: '"v1"' }, src, url, now);
    expect(notMod.items).toEqual([]);
    expect(notMod.cursor?.hash).toBe(first.cursor?.hash);

    const same = evaluatePagePoll(first.cursor, { kind: "page", title: "Rice", text: "PHP 52", value: "PHP 52", etag: '"v1"' }, src, url, now);
    expect(same.items).toEqual([]);

    const changed = evaluatePagePoll(first.cursor, { kind: "page", title: "Rice", text: "PHP 55", value: "PHP 55", etag: '"v2"' }, src, url, now);
    expect(changed.items).toHaveLength(1);
    expect(changed.items[0]!.payload).toMatchObject({
      url,
      title: "Rice",
      value: "PHP 55",
      previous: "PHP 52",
      previousHash: first.cursor!.hash,
    });
    expect(changed.cursor?.etag).toBe('"v2"');

    // Flipping back to PHP 52 generates a distinct transition key (hash2 -> hash1).
    const reverted = evaluatePagePoll(changed.cursor, { kind: "page", title: "Rice", text: "PHP 52", value: "PHP 52" }, src, url, now);
    expect(reverted.items).toHaveLength(1);
    expect(reverted.items[0]!.key).not.toBe(changed.items[0]!.key);
  });
});

describe("evaluateFeedPoll (pure)", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  const url = "https://blog.example.com/rss.xml";
  const src = monitorSourceOf({ type: "page_changed", config: { mode: "feed", url, maxChars: 4000 } });
  const item = (id: string, title = id) => ({
    itemId: id,
    title,
    link: `https://blog.example.com/${id}`,
    summary: `Summary ${id}`,
    published: "2026-11-24T09:00:00Z",
    author: "Ana",
  });

  it("baselines existing entries on first poll and starts runs only for new unseen entries", () => {
    const first = evaluateFeedPoll(null, { kind: "feed", feedTitle: "Shop Blog", items: [item("p1"), item("p2")], etag: '"f1"' }, src, url, now);
    expect(first.items).toEqual([]);
    expect(first.cursor.seenIds).toEqual(["p1", "p2"]);

    const notMod = evaluateFeedPoll(first.cursor, { kind: "not_modified", etag: '"f1"' }, src, url, now);
    expect(notMod.items).toEqual([]);
    expect(notMod.cursor.seenIds).toEqual(["p1", "p2"]);

    const second = evaluateFeedPoll(first.cursor, { kind: "feed", feedTitle: "Shop Blog", items: [item("p3", "New promo"), item("p1")] }, src, url, now);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.payload).toMatchObject({
      url,
      feedTitle: "Shop Blog",
      itemId: "p3",
      title: "New promo",
      link: "https://blog.example.com/p3",
    });
    expect(second.cursor.seenIds).toEqual(["p3", "p1", "p2"]);

    // Seeing p3 again produces zero runs.
    const third = evaluateFeedPoll(second.cursor, { kind: "feed", feedTitle: "Shop Blog", items: [item("p3"), item("p1")] }, src, url, now);
    expect(third.items).toEqual([]);
  });
});

describe("pollMonitorTriggers (Postgres trigger_polls + run_keys)", () => {
  let db: Db;
  let pool: Pool;
  let seq = 0;
  const enqueued: string[] = [];
  const enqueue = async (runId: string) => void enqueued.push(runId);

  beforeAll(async () => {
    ({ db, pool } = await freshDatabase());
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function createMonitor(config: Record<string, unknown>) {
    const [u] = await db.insert(users).values({ email: `g4-mon-${++seq}@test.local`, passwordHash: "x" }).returning();
    const [w] = await db.insert(workflows).values({ userId: u!.id, name: "Monitor", slug: `mon-${seq}` }).returning();
    await db.insert(workflowVersions).values({
      workflowId: w!.id,
      version: 1,
      definition: { trigger: { type: "page_changed", config }, steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }], edges: [] },
      published: true,
    });
    await db.insert(triggers).values({ workflowId: w!.id, type: "page_changed", config });
    return { ws: u!.id, workflowId: w!.id };
  }

  const due = (workflowId: string) => db.update(triggerPolls).set({ nextPollAt: sql`now()` }).where(eq(triggerPolls.workflowId, workflowId));
  const pollState = async (workflowId: string) => (await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, workflowId)))[0]!;
  const runsOf = async (workflowId: string) =>
    (await db.execute<{ id: string; trigger_payload: Record<string, unknown> }>(
      sql`select r.id, r.trigger_payload from runs r join workflow_versions v on v.id = r.workflow_version_id where v.workflow_id = ${workflowId} order by r.created_at`,
    )).rows;

  it("baselines first poll, starts one run per change, recovers from cursor crash via run_keys, and reports status", async () => {
    const { ws, workflowId } = await createMonitor({ mode: "page", url: "https://supplier.example/p", selector: ".price", maxChars: 4000 });
    let answer: MonitorFetchResult = { kind: "page", title: "Price", text: "50", value: "50", etag: '"e1"' };
    const fetchMonitor = async ({ claimHttp }: { claimHttp: () => Promise<void> }) => {
      await claimHttp();
      return answer;
    };

    await pollMonitorTriggers({ db, fetchMonitor, enqueue });
    expect(await runsOf(workflowId)).toEqual([]);
    const baseline = await pollState(workflowId);
    expect(baseline.problem).toBeNull();
    expect(baseline.failures).toBe(0);
    expect(baseline.cursor).toMatchObject({ mode: "page", value: "50", etag: '"e1"' });

    const status = await monitorTriggerStatus(db, ws, workflowId);
    expect(status.watching).toMatchObject({ problem: null, failures: 0, started: true });
    const usage = await usageSummary(db, ws);
    expect(usage.http.used).toBe(1);

    // Change price and trigger poll.
    answer = { kind: "page", title: "Price", text: "55", value: "55", etag: '"e2"' };
    await due(workflowId);
    await pollMonitorTriggers({ db, fetchMonitor, enqueue });
    const afterChange = await runsOf(workflowId);
    expect(afterChange).toHaveLength(1);
    expect(afterChange[0]!.trigger_payload).toMatchObject({ value: "55", previous: "50" });
    expect(enqueued).toContain(afterChange[0]!.id);

    // Simulate a crash after run creation before cursor moved: revert cursor to baseline and re-poll -> run_keys deduplicates.
    await db.update(triggerPolls).set({ cursor: baseline.cursor, nextPollAt: sql`now()` }).where(eq(triggerPolls.workflowId, workflowId));
    await pollMonitorTriggers({ db, fetchMonitor, enqueue });
    expect(await runsOf(workflowId)).toHaveLength(1);
    expect((await pollState(workflowId)).cursor).toMatchObject({ value: "55" });
  });

  it("backs off with a plain problem on retryable/fatal errors and QuotaError, then clears on recovery", async () => {
    const { workflowId } = await createMonitor({ mode: "feed", url: "https://news.example/rss", maxChars: 4000 });

    // Retryable 503 increments failures and sets problem.
    await pollMonitorTriggers({
      db,
      enqueue,
      fetchMonitor: async () => {
        throw new MonitorPollError("the server answered 503", true, 30_000);
      },
    });
    expect(await pollState(workflowId)).toMatchObject({ failures: 1, problem: "the server answered 503" });

    // QuotaError records daily cap problem without incrementing hard failures unexpectedly.
    await due(workflowId);
    await pollMonitorTriggers({
      db,
      enqueue,
      fetchMonitor: async () => {
        throw new QuotaError("Daily web request limit reached.", "http");
      },
    });
    expect((await pollState(workflowId)).problem).toMatch(/daily web request limit/i);

    // Recovery clears problem and failures.
    await due(workflowId);
    await pollMonitorTriggers({
      db,
      enqueue,
      fetchMonitor: async () => ({ kind: "feed", feedTitle: "News", items: [] }),
    });
    expect(await pollState(workflowId)).toMatchObject({ failures: 0, problem: null });
  });
});
