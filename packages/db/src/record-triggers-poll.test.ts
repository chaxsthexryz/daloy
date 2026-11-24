import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { removeConnection, saveConnection } from "./connections";
import { pollGoogleTriggers } from "./google-triggers";
import type { Db } from "./index";
import type { ProviderUrls } from "./providers";
import { pollRecordTriggers } from "./record-triggers";
import { triggerPolls, triggers, users, workflows, workflowVersions } from "./schema";

// Decision 0134: DB poll tests for airtable_record, notion_page, and trello_card against fake providers.
const key = randomBytes(32);
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
  fake.airtable.token = "patTESTG5TOKEN.0123456789abcdef0123456789";
  fake.notion.token = "ntn_TESTG5TOKEN0123456789abcdefghijkl";
  fake.trello.key = "0123456789abcdef0123456789abcdef";
  fake.trello.token = "ATTAtestg5token0123456789abcdefghijklmnop";
  urls = { ...fake.urls, timeoutMs: 2000 };
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

async function automation(trigger: { type: string; config: Record<string, unknown> }, steps: unknown[] = [{ id: "wait", type: "delay", config: { seconds: 5 } }]) {
  const [u] = await db.insert(users).values({ email: `g5-${++seq}@test.local`, passwordHash: "x" }).returning();
  const [w] = await db.insert(workflows).values({ userId: u!.id, name: "Record Watcher", slug: `rec-${seq}` }).returning();
  await db.insert(workflowVersions).values({ workflowId: w!.id, version: 1, definition: { trigger, steps, edges: [] }, published: true });
  await db.insert(triggers).values({ workflowId: w!.id, type: trigger.type, config: trigger.config });
  return { ws: u!.id, workflowId: w!.id };
}
const poll = () => pollRecordTriggers({ db, secretsKey: key, urls, enqueue });
const due = (workflowId: string) => db.update(triggerPolls).set({ nextPollAt: sql`now()` }).where(eq(triggerPolls.workflowId, workflowId));
const state = async (workflowId: string) => (await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, workflowId)))[0]!;
const runsOf = async (workflowId: string) =>
  (await db.execute<{ id: string; trigger_payload: Record<string, unknown> }>(sql`select r.id, r.trigger_payload from runs r join workflow_versions v on v.id = r.workflow_version_id where v.workflow_id = ${workflowId} order by r.created_at`)).rows;

describe("airtable_record", () => {
  it("baselines on first poll, triggers once per new record, recovers from cursor-save crash, and pauses on disconnect", async () => {
    const baseId = "appFAKEBASE000001";
    const tableId = "tblFAKETABLE00001";
    fake.airtable.records.length = 0;
    fake.airtable.records.push({ id: "recOLD00000000001", baseId, tableId, createdTime: "2026-11-24T00:00:00.000Z", fields: { "Customer Name": "Old", Status: "New" } });

    const a = await automation({ type: "airtable_record", config: { on: "created" } });
    await saveConnection(db, key, a.ws, "airtable", { account: baseId, credential: fake.airtable.token, destination: { baseId, tableId } });

    await poll();
    expect(await runsOf(a.workflowId)).toEqual([]);
    const s1 = await state(a.workflowId);
    expect(s1.problem).toBeNull();
    expect(typeof s1.cursor?.since).toBe("string");

    const laterIso = new Date(Date.now() + 2_000).toISOString();
    fake.airtable.records.push({ id: "recNEW00000000002", baseId, tableId, createdTime: laterIso, fields: { "Customer Name": "Ana Reyes", Status: "Pending" } });
    await due(a.workflowId);
    await poll();
    const [run] = await runsOf(a.workflowId);
    expect(run!.trigger_payload).toMatchObject({ baseId, tableId, event: "created", recordId: "recNEW00000000002", cells: { customer_name: "Ana Reyes", status: "Pending" } });
    expect(enqueued).toContain(run!.id);

    // Simulated crash after createKeyedRun but before cursor save: run_keys prevents a duplicate run.
    await db.update(triggerPolls).set({ cursor: s1.cursor, nextPollAt: sql`now()` }).where(eq(triggerPolls.workflowId, a.workflowId));
    await poll();
    expect(await runsOf(a.workflowId)).toHaveLength(1);

    // Disconnected -> pauses; reconnected -> resumes cleanly.
    await removeConnection(db, a.ws, "airtable");
    await due(a.workflowId);
    await poll();
    expect((await state(a.workflowId)).problem).toBe("Airtable is not connected. Connect it in Apps.");
    await saveConnection(db, key, a.ws, "airtable", { account: baseId, credential: fake.airtable.token, destination: { baseId, tableId } });
    await due(a.workflowId);
    await poll();
    expect((await state(a.workflowId)).problem).toBeNull();
  });

  it("detects status_changed transitions and backs off on 429", async () => {
    const baseId = "appFAKEBASE000001";
    const tableId = "tblFAKETABLE00002";
    fake.airtable.records.push({ id: "recST000000000001", baseId, tableId, createdTime: "2026-11-24T00:00:00.000Z", fields: { Name: "Order 1", Status: "Pending" } });
    const a = await automation({ type: "airtable_record", config: { on: "status_changed", statusField: "Status" } });
    await saveConnection(db, key, a.ws, "airtable", { account: baseId, credential: fake.airtable.token, destination: { baseId, tableId } });

    await poll();
    expect(await runsOf(a.workflowId)).toEqual([]);

    const rec = fake.airtable.records.find((r) => r.id === "recST000000000001")!;
    rec.fields.Status = "Approved";
    await due(a.workflowId);
    await poll();
    expect((await runsOf(a.workflowId))[0]!.trigger_payload).toMatchObject({ event: "status_changed", statusField: "Status", status: "Approved", previousStatus: "Pending" });

    // Rate limit -> backoff increments failures and pushes nextPollAt out.
    fake.once(`/v0/${baseId}/${tableId}`, { status: 429, body: { error: { type: "RATE_LIMIT" } } });
    await due(a.workflowId);
    await poll();
    const s = await state(a.workflowId);
    expect(s.failures).toBe(1);
    expect(s.problem).toMatch(/limiting requests/);
    expect(s.nextPollAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("pauses when the workflow has an enabled airtable step (self-loop guard)", async () => {
    const a = await automation({ type: "airtable_record", config: { on: "created" } }, [{ id: "add", type: "airtable", config: { fields: { Name: "x" } } }]);
    await saveConnection(db, key, a.ws, "airtable", { account: "appFAKEBASE000001", credential: fake.airtable.token, destination: { baseId: "appFAKEBASE000001", tableId: "tblFAKETABLE00001" } });
    await poll();
    expect((await state(a.workflowId)).problem).toMatch(/Airtable table it watches/);
  });
});

describe("notion_page", () => {
  it("baselines on first poll and starts runs for new pages and status changes", async () => {
    const dbId = fake.notion.database;
    fake.notion.pages.length = 0;
    fake.notion.pages.push({
      id: "11111111111111111111111111111111",
      databaseId: dbId,
      createdTime: "2026-11-24T00:00:00.000Z",
      lastEditedTime: "2026-11-24T00:00:00.000Z",
      properties: { Name: { type: "title", title: [{ plain_text: "Existing" }] }, Status: { type: "status", status: { name: "New" } } },
    });

    const createdWf = await automation({ type: "notion_page", config: { on: "created" } });
    const statusWf = await automation({ type: "notion_page", config: { on: "status_changed", statusProperty: "Status" } });
    for (const ws of [createdWf.ws, statusWf.ws]) {
      await saveConnection(db, key, ws, "notion", { account: "Office requests", credential: fake.notion.token, destination: { databaseId: dbId, databaseTitle: "Office requests", titleProperty: "Name" } });
    }

    await poll();
    expect(await runsOf(createdWf.workflowId)).toEqual([]);
    expect(await runsOf(statusWf.workflowId)).toEqual([]);

    const futureIso = new Date(Date.now() + 2_000).toISOString();
    fake.notion.pages.push({
      id: "22222222222222222222222222222222",
      databaseId: dbId,
      createdTime: futureIso,
      lastEditedTime: futureIso,
      properties: { Name: { type: "title", title: [{ plain_text: "Ana order" }] }, Status: { type: "status", status: { name: "Ready" } } },
    });
    fake.notion.pages[0]!.properties.Status = { type: "status", status: { name: "Done" } };

    await due(createdWf.workflowId);
    await due(statusWf.workflowId);
    await poll();

    const createdRuns = await runsOf(createdWf.workflowId);
    expect(createdRuns).toHaveLength(1);
    expect(createdRuns[0]!.trigger_payload).toMatchObject({ databaseId: dbId, event: "created", pageId: "22222222222222222222222222222222", title: "Ana order", cells: { name: "Ana order", status: "Ready" } });

    const statusRuns = await runsOf(statusWf.workflowId);
    expect(statusRuns).toHaveLength(2);
    expect(statusRuns.map((r) => r.trigger_payload.status).sort()).toEqual(["Done", "Ready"]);
  });
});

describe("trello_card", () => {
  it("tracks new cards and moved_to_list actions cleanly without touching Google trigger_polls rows", async () => {
    const listId = "5f0000000000000000000001";
    const otherListId = "5f0000000000000000000002";
    fake.trello.cards.length = 0;
    fake.trello.actions.length = 0;
    fake.trello.actions.push({
      id: "actOld1",
      type: "createCard",
      date: "2026-11-24T00:00:00.000Z",
      data: { card: { id: "cardOld1", name: "Old card" }, list: { id: listId, name: "To do" }, board: { id: "5f0000000000000000000010", name: "Office" } },
    });

    const createdWf = await automation({ type: "trello_card", config: { on: "created" } });
    const movedWf = await automation({ type: "trello_card", config: { on: "moved_to_list" } });
    // Also add a dummy Google trigger row to verify pollGoogleTriggers and pollRecordTriggers do not delete each other's rows.
    const googleWf = await automation({ type: "sheets_row", config: { tab: "Orders" } });
    await db.insert(triggerPolls).values({ workflowId: googleWf.workflowId, nextPollAt: new Date(0) });

    const cred = JSON.stringify({ key: fake.trello.key, token: fake.trello.token });
    await saveConnection(db, key, createdWf.ws, "trello", { account: "@daloy_tester", credential: cred, destination: { listId, listName: "To do" } });
    await saveConnection(db, key, movedWf.ws, "trello", { account: "@daloy_tester", credential: cred, destination: { listId, listName: "To do" } });

    await poll();
    expect(await runsOf(createdWf.workflowId)).toEqual([]);
    expect(await runsOf(movedWf.workflowId)).toEqual([]);

    const nowIso = new Date(Date.now() + 2_000).toISOString();
    fake.trello.cards.push({ id: "cardNew1", idList: listId, name: "Pack order", desc: "Urgent", url: "https://trello.com/c/cardNew1", shortUrl: "https://trello.com/c/cardNew1" });
    fake.trello.actions.push({
      id: "actCreate1",
      type: "createCard",
      date: nowIso,
      data: { card: { id: "cardNew1", name: "Pack order" }, list: { id: listId, name: "To do" }, board: { id: "5f0000000000000000000010", name: "Office" } },
    });
    fake.trello.actions.push({
      id: "actMove1",
      type: "updateCard",
      date: nowIso,
      data: {
        card: { id: "cardMoved1", name: "Shipped item" },
        listBefore: { id: otherListId, name: "Doing" },
        listAfter: { id: listId, name: "To do" },
        board: { id: "5f0000000000000000000010", name: "Office" },
      },
    });

    await due(createdWf.workflowId);
    await due(movedWf.workflowId);
    await poll();

    const createdRuns = await runsOf(createdWf.workflowId);
    expect(createdRuns).toHaveLength(1);
    expect(createdRuns[0]!.trigger_payload).toMatchObject({ listId, event: "created", cardId: "cardNew1", name: "Pack order", desc: "Urgent" });

    const movedRuns = await runsOf(movedWf.workflowId);
    expect(movedRuns).toHaveLength(1);
    expect(movedRuns[0]!.trigger_payload).toMatchObject({ listId, event: "moved_to_list", cardId: "cardMoved1", name: "Shipped item", previousListId: otherListId, previousListName: "Doing" });

    // Coexistence: pollGoogleTriggers leaves record trigger rows untouched, and vice versa.
    await pollGoogleTriggers({ db, secretsKey: key, urls, enqueue });
    expect((await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, createdWf.workflowId))).length).toBe(1);
    expect((await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, googleWf.workflowId))).length).toBe(1);
  });
});
