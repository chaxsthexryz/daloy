import { generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { readConnections, removeConnection, saveConnection } from "./connections";
import { claimDueDeliveries, clearSheetWriteKeys, confirmDelivery, DELIVERY_POLICY, queueDelivery, retryDelivery, runDueDeliveries } from "./deliveries";
import type { Db } from "./index";
import type { ProviderUrls } from "./providers";
import { connections, deliveries, runs, users, workflows, workflowVersions } from "./schema";

// Roadmap phase 3 acceptance: each delivery is handled on its own, and a call that may have reached the provider is
// reconciled (Sheets) or held for review (Slack) instead of being repeated.
const key = randomBytes(32);
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let ana: string;
let ben: string;
let sheetRows: string[][];
let sheetState: ReturnType<FakeProviders["addSheet"]>;

const serviceAccount = (email: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fake.addServiceAccount(email, publicKey.export({ type: "spki", format: "pem" }).toString());
  return { client_email: email, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
};

async function owner(email: string) {
  const [u] = await db.insert(users).values({ email, passwordHash: "x" }).returning();
  return u!.id;
}
async function newRun(userId: string) {
  const [wf] = await db.insert(workflows).values({ userId, name: "Office requests", slug: `w${randomBytes(4).toString("hex")}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
  return r!.id;
}
const sheet = (userId: string, runId: string, reference: string) =>
  queueDelivery(db, { userId, runId, stepId: "add_to_sheet", provider: "google_sheets", reference, payload: { row: [reference, "2026-11-13T09:00:00.000Z", "Printer jammed"] } });
const slack = (userId: string, runId: string, reference: string) =>
  queueDelivery(db, { userId, runId, stepId: "post_to_slack", provider: "slack", reference, payload: { text: `New request ${reference}: Printer jammed` } });
const state = async (id: string) => (await db.select().from(deliveries).where(eq(deliveries.id, id)))[0]!;
const deliverDue = () => runDueDeliveries(db, key, urls);
/** Makes a scheduled retry due now, as if its backoff had passed. */
const makeDue = (id: string) => db.update(deliveries).set({ nextAttemptAt: sql`now()` }).where(eq(deliveries.id, id));
const appends = () => fake.calls.filter((c) => c.endsWith(":batchUpdate")).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  urls = { ...fake.urls, timeoutMs: 300 };
  ana = await owner("ana@test.local");
  ben = await owner("ben@test.local");
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

beforeEach(async () => {
  await db.delete(deliveries);
  await db.delete(connections);
  sheetState = fake.addSheet("sheet-ana", "Office requests", "Requests", ["sheets@ana.iam.gserviceaccount.com"]);
  sheetRows = sheetState.tabs.get("Requests")!;
  fake.slack.token = "xoxb-ana";
  fake.slack.revoked = false;
  fake.slack.messages.length = 0;
  fake.slack.channels[0]!.is_member = true;
  await saveConnection(db, key, ana, "google_sheets", {
    account: "sheets@ana.iam.gserviceaccount.com",
    credential: JSON.stringify(serviceAccount("sheets@ana.iam.gserviceaccount.com")),
    destination: { spreadsheetId: "sheet-ana", tab: "Requests", title: "Office requests" },
  });
  await saveConnection(db, key, ana, "slack", { account: "Lim Dental", credential: "xoxb-ana", destination: { channelId: "C0REQ", channelName: "office-requests" } });
});

it("appends one row that starts with the request reference, and records where it went", async () => {
  const d = await sheet(ana, await newRun(ana), "REQ-1001");
  await deliverDue();
  expect(sheetRows).toEqual([["REQ-1001", "2026-11-13T09:00:00.000Z", "Printer jammed"]]);
  expect(await state(d.id)).toMatchObject({ state: "delivered", attempts: 1, result: { sheet: "Requests" } });
});

it("queues one delivery per run and step, however often the step runs", async () => {
  const runId = await newRun(ana);
  const a = await sheet(ana, runId, "REQ-1002");
  const b = await sheet(ana, runId, "REQ-1002");
  expect(b.id).toBe(a.id);
  await deliverDue();
  await deliverDue();
  expect(sheetRows).toHaveLength(1);
});

it("retries Slack alone when the sheet row went in and Slack failed", async () => {
  const runId = await newRun(ana);
  fake.slack.channels[0]!.is_member = false;
  const row = await sheet(ana, runId, "REQ-1003");
  const msg = await slack(ana, runId, "REQ-1003");
  await deliverDue();
  expect((await state(row.id)).state).toBe("delivered");
  const failed = await state(msg.id);
  expect(failed).toMatchObject({ state: "failed" });
  expect(failed.lastError).toMatch(/invite/i);

  fake.slack.channels[0]!.is_member = true;
  expect(await retryDelivery(db, ana, msg.id)).toBe(true);
  await deliverDue();
  expect((await state(msg.id)).state).toBe("delivered");
  expect(fake.slack.messages).toHaveLength(1);
  expect(sheetRows).toHaveLength(1);
});

it("does not write twice when Google accepted a row but the answer timed out", async () => {
  const d = await sheet(ana, await newRun(ana), "REQ-1004");
  fake.once(":batchUpdate", "hang-after");
  const before = appends();
  await deliverDue();
  expect(await state(d.id)).toMatchObject({ state: "queued", checkFirst: true });
  await makeDue(d.id);
  await deliverDue();
  expect(await state(d.id)).toMatchObject({ state: "delivered", result: { sheet: "Requests", reconciled: true } });
  expect(sheetRows).toHaveLength(1);
  // The retry sent the same atomic write, and Google refused it because its marker already existed.
  expect(appends() - before).toBe(2);
});

it("does not take another step's row with the same reference for its own", async () => {
  const runId = await newRun(ana);
  await sheet(ana, runId, "REQ-1010");
  await deliverDue();
  const second = await queueDelivery(db, { userId: ana, runId, stepId: "log_cost", provider: "google_sheets", reference: "REQ-1010", payload: { row: ["REQ-1010", "2026-11-13T09:00:01.000Z", "PHP 7,800"] } });
  fake.once(":batchUpdate", "hang");
  await deliverDue();
  await makeDue(second.id);
  await deliverDue();
  expect(await state(second.id)).toMatchObject({ state: "delivered", result: { sheet: "Requests" } });
  expect(sheetRows.map((r) => r[2])).toEqual(["Printer jammed", "PHP 7,800"]);
});

it("writes the row after the check when the timed-out call never arrived", async () => {
  const d = await sheet(ana, await newRun(ana), "REQ-1005");
  fake.once(":batchUpdate", "hang");
  await deliverDue();
  await makeDue(d.id);
  await deliverDue();
  expect((await state(d.id)).state).toBe("delivered");
  expect(sheetRows.map((r) => r[0])).toEqual(["REQ-1005"]);
});

it("holds a Slack post for review when Slack may have accepted it, and repeats it only when asked", async () => {
  const d = await slack(ana, await newRun(ana), "REQ-1006");
  fake.once("chat.postMessage", "hang-after");
  await deliverDue();
  const held = await state(d.id);
  expect(held.state).toBe("needs_review");
  expect(held.lastError).toMatch(/may have posted/i);
  expect(fake.slack.messages).toHaveLength(1);

  expect(await retryDelivery(db, ana, d.id)).toBe(false); // a plain Retry does not repeat an ambiguous post
  await deliverDue();
  expect(fake.slack.messages).toHaveLength(1);

  expect(await confirmDelivery(db, ana, d.id)).toBe(true); // the operator saw it in the channel
  expect(await state(d.id)).toMatchObject({ state: "delivered", result: { confirmedBy: "operator" } });

  const again = await slack(ana, await newRun(ana), "REQ-1007");
  fake.once("chat.postMessage", "hang-after");
  await deliverDue();
  expect(await retryDelivery(db, ana, again.id, { postAgain: true })).toBe(true);
  await deliverDue();
  expect((await state(again.id)).state).toBe("delivered");
  expect(fake.slack.messages).toHaveLength(3);
});

it("gets a new Google access token once when the old one has expired", async () => {
  await sheet(ana, await newRun(ana), "REQ-1008");
  await deliverDue();
  fake.expireTokens();
  const d = await sheet(ana, await newRun(ana), "REQ-1009");
  await deliverDue();
  expect((await state(d.id)).state).toBe("delivered");
  expect(sheetRows).toHaveLength(2);
});

it("marks the connection failed when Google rejects the key, without touching another owner", async () => {
  fake.addSheet("sheet-ben", "Clinic intake", "Sheet1", ["sheets@ben.iam.gserviceaccount.com"]);
  await saveConnection(db, key, ben, "google_sheets", {
    account: "sheets@ben.iam.gserviceaccount.com",
    credential: JSON.stringify(serviceAccount("sheets@ben.iam.gserviceaccount.com")),
    destination: { spreadsheetId: "sheet-ben", tab: "Sheet1", title: "Clinic intake" },
  });
  fake.revokeServiceAccount("sheets@ana.iam.gserviceaccount.com");
  fake.expireTokens();
  const a = await sheet(ana, await newRun(ana), "REQ-1010");
  const b = await sheet(ben, await newRun(ben), "REQ-1011");
  await deliverDue();
  expect(await state(a.id)).toMatchObject({ state: "failed" });
  expect((await state(a.id)).lastError).toMatch(/connect google sheets again/i);
  expect((await readConnections(db, ana)).find((c) => c.provider === "google_sheets")?.status).toBe("failed");
  expect(await state(b.id)).toMatchObject({ state: "delivered" });
  expect((await readConnections(db, ben))[0]?.status).toBe("active");

  // Later deliveries for Ana fail straight away, without calling Google, until she reconnects.
  const calls = fake.calls.length;
  const c = await sheet(ana, await newRun(ana), "REQ-1012");
  await deliverDue();
  expect((await state(c.id)).state).toBe("failed");
  expect(fake.calls.length).toBe(calls);
});

it("fails without retrying when the sheet is not shared, and says who to share it with", async () => {
  fake.addSheet("sheet-ana", "Office requests", "Requests", []);
  const d = await sheet(ana, await newRun(ana), "REQ-1013");
  await deliverDue();
  const row = await state(d.id);
  expect(row).toMatchObject({ state: "failed", attempts: 1 });
  expect(row.lastError).toContain("sheets@ana.iam.gserviceaccount.com");
  expect((await readConnections(db, ana)).find((c) => c.provider === "google_sheets")?.status).toBe("active");
});

it("waits as long as Slack asks after a rate limit, and gives up after the last attempt", async () => {
  const d = await slack(ana, await newRun(ana), "REQ-1014");
  fake.once("chat.postMessage", { status: 429, body: { ok: false, error: "ratelimited" }, headers: { "retry-after": "30" } });
  await deliverDue();
  const waiting = await state(d.id);
  expect(waiting.state).toBe("queued");
  expect(waiting.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(Date.now() + 29_000);

  for (let i = 1; i < DELIVERY_POLICY.maxAttempts; i++) {
    fake.once("chat.postMessage", { status: 429, body: { ok: false, error: "ratelimited" }, headers: { "retry-after": "1" } });
    await makeDue(d.id);
    await deliverDue();
  }
  expect(await state(d.id)).toMatchObject({ state: "failed", attempts: DELIVERY_POLICY.maxAttempts });
  expect(fake.slack.messages).toHaveLength(0);
});

it("fails a revoked Slack token and marks the connection failed", async () => {
  fake.slack.revoked = true;
  const d = await slack(ana, await newRun(ana), "REQ-1015");
  await deliverDue();
  expect((await state(d.id)).state).toBe("failed");
  expect((await readConnections(db, ana)).find((c) => c.provider === "slack")?.status).toBe("failed");
});

it("fails a delivery while disconnected, then delivers it after reconnecting and Retry", async () => {
  await removeConnection(db, ana, "slack");
  const d = await slack(ana, await newRun(ana), "REQ-1016");
  await deliverDue();
  expect(await state(d.id)).toMatchObject({ state: "failed", lastError: expect.stringMatching(/not connected/i) });
  await saveConnection(db, key, ana, "slack", { account: "Lim Dental", credential: "xoxb-ana", destination: { channelId: "C0REQ", channelName: "office-requests" } });
  await retryDelivery(db, ana, d.id);
  await deliverDue();
  expect((await state(d.id)).state).toBe("delivered");
});

it("lets a double-click on Retry queue the delivery once, and only for its owner", async () => {
  fake.slack.channels[0]!.is_member = false;
  const d = await slack(ana, await newRun(ana), "REQ-1017");
  await deliverDue();
  fake.slack.channels[0]!.is_member = true;
  expect(await retryDelivery(db, ben, d.id)).toBe(false);
  const results = await Promise.all([retryDelivery(db, ana, d.id), retryDelivery(db, ana, d.id)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await Promise.all([deliverDue(), deliverDue()]);
  expect(fake.slack.messages).toHaveLength(1);
});

it("hands each due delivery to one worker, and treats one left sending by a crashed worker as uncertain", async () => {
  const runId = await newRun(ana);
  const a = await sheet(ana, runId, "REQ-1018");
  const [first, second] = await Promise.all([claimDueDeliveries(db), claimDueDeliveries(db)]);
  expect([...first, ...second].map((r) => r.id)).toEqual([a.id]);

  // The claim above is never finished, like a worker that died mid-call. After the stale time it is claimed again,
  // and marked uncertain.
  await db.update(deliveries).set({ updatedAt: sql`now() - interval '10 minutes'` }).where(eq(deliveries.id, a.id));
  const [again] = await claimDueDeliveries(db);
  expect(again).toMatchObject({ id: a.id, checkFirst: true, attempts: 2 });
});

describe("exactly-once Sheets writes and pinned destinations (QA regression, fec03cc)", () => {
  it("edit before retry: the row landed, the answer was lost and someone edited the row; the retry adds nothing", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-2001");
    fake.once(":batchUpdate", "hang-after");
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "queued" });
    sheetRows[0]![2] = "Printer jammed (Ana fixed it)";
    await makeDue(d.id);
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "delivered", result: { reconciled: true } });
    expect(sheetRows).toHaveLength(1);
  });

  it("two workers at once, one taking over a stale claim while the first call is still in flight, write one row", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-2002");
    // Worker A's write reaches Google only after A has given up (timeout 300 ms, write applied at 450 ms).
    fake.once(":batchUpdate", { late: 450 });
    const workerA = deliverDue();
    await sleep(100);
    await db.update(deliveries).set({ updatedAt: sql`now() - interval '10 minutes'` }).where(eq(deliveries.id, d.id));
    await deliverDue(); // worker B
    await workerA;
    await sleep(500);
    expect(sheetRows).toHaveLength(1);
    expect(await state(d.id)).toMatchObject({ state: "delivered" });
  });

  it("refuses a late duplicate after the retry succeeded, because the marker is kept", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-2003");
    fake.once(":batchUpdate", { late: 450 });
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "queued" });
    await makeDue(d.id);
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "delivered" });
    await sleep(300);
    expect(sheetRows).toHaveLength(1);
  });

  it("keeps the marker for 24 hours after delivery, then deletes it", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-2004");
    await deliverDue();
    const { sheetMetaId } = await state(d.id);
    expect(sheetState.metadata.has(sheetMetaId!)).toBe(true);
    expect(await clearSheetWriteKeys(db, key, urls)).toBe(0);
    expect(sheetState.metadata.has(sheetMetaId!)).toBe(true);
    await db.update(deliveries).set({ updatedAt: sql`now() - interval '25 hours'` }).where(eq(deliveries.id, d.id));
    expect(await clearSheetWriteKeys(db, key, urls)).toBe(1);
    expect(sheetState.metadata.has(sheetMetaId!)).toBe(false);
    expect((await state(d.id)).sheetMetaClearedAt).not.toBeNull();
  });

  it("sends a delivery to review, writing nothing, when its marker id is taken by something else", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-2005");
    const { sheetMetaId } = await state(d.id);
    sheetState.metadata.set(sheetMetaId!, { metadataId: sheetMetaId!, metadataKey: "another-tool", location: { sheetId: 1 }, visibility: "PROJECT" });
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "needs_review", lastError: expect.stringContaining("marker") });
    expect(sheetRows).toHaveLength(0);
  });

  it("reconnect before retry: review, nothing written to either sheet; Post again writes once to the new sheet", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-2006");
    fake.once(":batchUpdate", "hang");
    await deliverDue();
    const newRows = fake.addSheet("sheet-ana-2", "New requests", "Requests", ["sheets@ana.iam.gserviceaccount.com"]).tabs.get("Requests")!;
    await db.update(connections).set({ destination: { spreadsheetId: "sheet-ana-2", tab: "Requests", title: "New requests" } }).where(and(eq(connections.userId, ana), eq(connections.provider, "google_sheets")));
    await makeDue(d.id);
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "needs_review", lastError: expect.stringContaining("changed") });
    expect([sheetRows.length, newRows.length]).toEqual([0, 0]);
    expect(await retryDelivery(db, ana, d.id, { postAgain: true })).toBe(true);
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "delivered" });
    expect([sheetRows.length, newRows.length]).toEqual([0, 1]);
  });

  it("reconnect before retry for Slack: review and no message; Post again posts once to the new channel", async () => {
    fake.slack.channels.push({ id: "C0NEW", name: "front-desk", is_member: true });
    const d = await slack(ana, await newRun(ana), "REQ-2007");
    await saveConnection(db, key, ana, "slack", { account: "Lim Dental", credential: "xoxb-ana", destination: { channelId: "C0NEW", channelName: "front-desk" } });
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "needs_review", lastError: expect.stringContaining("#office-requests") });
    expect(fake.slack.messages).toHaveLength(0);
    await retryDelivery(db, ana, d.id, { postAgain: true });
    await deliverDue();
    expect(fake.slack.messages.map((m) => m.channel)).toEqual(["C0NEW"]);
    fake.slack.channels.pop();
  });

  it("sends a delivery queued before destinations were recorded to review, writing nothing", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-2008");
    await db.update(deliveries).set({ pinnedAccount: null, pinnedDestination: null }).where(eq(deliveries.id, d.id));
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "needs_review", lastError: expect.stringContaining("before Daloy recorded") });
    expect(sheetRows).toHaveLength(0);
  });
});
