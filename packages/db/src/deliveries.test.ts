import { generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { connectionCredential, readConnections, removeConnection, saveConnection } from "./connections";
import { claimDueDeliveries, clearSheetWriteKeys, confirmDelivery, DELIVERY_POLICY, queueDelivery, retryDelivery, runDueDeliveries } from "./deliveries";
import type { Db } from "./index";
import { appendRowOnce, serviceAccountSchema, type ProviderUrls, type SheetDestination } from "./providers";
import { bookings, connections, deliveries, resources, runs, users, workflows, workflowVersions } from "./schema";

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
  expect(failed.errorKind).toBe("permission");

  fake.slack.channels[0]!.is_member = true;
  expect(await retryDelivery(db, ana, msg.id)).toBe(true);
  expect((await state(msg.id)).errorKind).toBeNull(); // Retry clears it
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
  expect(held.errorKind).toBe("ambiguous");
  expect(fake.slack.messages).toHaveLength(1);

  expect(await retryDelivery(db, ana, d.id)).toBe(false); // a plain Retry does not repeat an ambiguous post
  await deliverDue();
  expect(fake.slack.messages).toHaveLength(1);

  expect(await confirmDelivery(db, ana, d.id)).toBe(true); // the operator saw it in the channel
  expect(await state(d.id)).toMatchObject({ state: "delivered", result: { confirmedBy: "operator" }, errorKind: null });

  const again = await slack(ana, await newRun(ana), "REQ-1007");
  fake.once("chat.postMessage", "hang-after");
  await deliverDue();
  expect(await retryDelivery(db, ana, again.id, { postAgain: true })).toBe(true);
  expect((await state(again.id)).errorKind).toBeNull(); // Post again clears it
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
  expect((await state(a.id)).errorKind).toBe("auth");
  expect((await readConnections(db, ana)).find((c) => c.provider === "google_sheets")?.status).toBe("failed");
  expect(await state(b.id)).toMatchObject({ state: "delivered" });
  expect((await readConnections(db, ben))[0]?.status).toBe("active");

  // Later deliveries for Ana fail straight away, without calling Google, until she reconnects.
  const calls = fake.calls.length;
  const c = await sheet(ana, await newRun(ana), "REQ-1012");
  await deliverDue();
  expect(await state(c.id)).toMatchObject({ state: "failed", errorKind: "reconnect" });
  expect(fake.calls.length).toBe(calls);
});

it("fails without retrying when the sheet is not shared, and says who to share it with", async () => {
  fake.addSheet("sheet-ana", "Office requests", "Requests", []);
  const d = await sheet(ana, await newRun(ana), "REQ-1013");
  await deliverDue();
  const row = await state(d.id);
  expect(row).toMatchObject({ state: "failed", attempts: 1 });
  expect(row.lastError).toContain("sheets@ana.iam.gserviceaccount.com");
  expect(row.errorKind).toBe("permission");
  expect((await readConnections(db, ana)).find((c) => c.provider === "google_sheets")?.status).toBe("active");
});

it("waits as long as Slack asks after a rate limit, and gives up after the last attempt", async () => {
  const d = await slack(ana, await newRun(ana), "REQ-1014");
  fake.once("chat.postMessage", { status: 429, body: { ok: false, error: "ratelimited" }, headers: { "retry-after": "30" } });
  await deliverDue();
  const waiting = await state(d.id);
  expect(waiting).toMatchObject({ state: "queued", errorKind: "quota" });
  expect(waiting.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(Date.now() + 29_000);

  for (let i = 1; i < DELIVERY_POLICY.maxAttempts; i++) {
    fake.once("chat.postMessage", { status: 429, body: { ok: false, error: "ratelimited" }, headers: { "retry-after": "1" } });
    await makeDue(d.id);
    await deliverDue();
  }
  expect(await state(d.id)).toMatchObject({ state: "failed", attempts: DELIVERY_POLICY.maxAttempts, errorKind: "quota" });
  expect(fake.slack.messages).toHaveLength(0);
});

it("fails a revoked Slack token and marks the connection failed", async () => {
  fake.slack.revoked = true;
  const d = await slack(ana, await newRun(ana), "REQ-1015");
  await deliverDue();
  expect(await state(d.id)).toMatchObject({ state: "failed", errorKind: "auth" });
  expect((await readConnections(db, ana)).find((c) => c.provider === "slack")?.status).toBe("failed");
});

it("fails a delivery while disconnected, then delivers it after reconnecting and Retry", async () => {
  await removeConnection(db, ana, "slack");
  const d = await slack(ana, await newRun(ana), "REQ-1016");
  await deliverDue();
  expect(await state(d.id)).toMatchObject({ state: "failed", lastError: expect.stringMatching(/not connected/i), errorKind: "not_connected" });
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
    expect(await state(d.id)).toMatchObject({ state: "needs_review", lastError: expect.stringContaining("marker"), errorKind: "review" });
    expect(sheetRows).toHaveLength(0);
  });

  it("never deletes another tool's metadata after a marker collision and Mark as posted (retest of ecb5ade)", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-2009");
    const { sheetMetaId } = await state(d.id);
    const theirs = { metadataId: sheetMetaId!, metadataKey: "another-tool", metadataValue: "keep-me", location: { sheetId: 1 }, visibility: "PROJECT" };
    sheetState.metadata.set(sheetMetaId!, theirs);
    await deliverDue();
    expect((await state(d.id)).state).toBe("needs_review");
    expect(await confirmDelivery(db, ana, d.id)).toBe(true);
    await db.update(deliveries).set({ updatedAt: sql`now() - interval '25 hours'` }).where(eq(deliveries.id, d.id));
    await clearSheetWriteKeys(db, key, urls);
    expect(sheetState.metadata.get(sheetMetaId!)).toEqual(theirs);
    expect((await state(d.id)).sheetMetaClearedAt).not.toBeNull();
  });

  it("reconnect before retry: review, nothing written to either sheet; Post again writes once to the new sheet", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-2006");
    fake.once(":batchUpdate", "hang");
    await deliverDue();
    const newRows = fake.addSheet("sheet-ana-2", "New requests", "Requests", ["sheets@ana.iam.gserviceaccount.com"]).tabs.get("Requests")!;
    await db.update(connections).set({ destination: { spreadsheetId: "sheet-ana-2", tab: "Requests", title: "New requests" } }).where(and(eq(connections.userId, ana), eq(connections.provider, "google_sheets")));
    await makeDue(d.id);
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "needs_review", lastError: expect.stringContaining("changed"), errorKind: "destination_changed" });
    expect([sheetRows.length, newRows.length]).toEqual([0, 0]);
    expect(await retryDelivery(db, ana, d.id, { postAgain: true })).toBe(true);
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "delivered", errorKind: null });
    expect([sheetRows.length, newRows.length]).toEqual([0, 1]);
  });

  it("reconnect before retry for Slack: review and no message; Post again posts once to the new channel", async () => {
    fake.slack.channels.push({ id: "C0NEW", name: "front-desk", is_member: true });
    const d = await slack(ana, await newRun(ana), "REQ-2007");
    await saveConnection(db, key, ana, "slack", { account: "Lim Dental", credential: "xoxb-ana", destination: { channelId: "C0NEW", channelName: "front-desk" } });
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "needs_review", lastError: expect.stringContaining("#office-requests"), errorKind: "destination_changed" });
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
    expect(await state(d.id)).toMatchObject({ state: "needs_review", lastError: expect.stringContaining("before Daloy recorded"), errorKind: "queued_before_pin" });
    expect(sheetRows).toHaveLength(0);
  });
});

describe("late answers from stale workers (Astra, c05fa81)", () => {
  // A held answer: the fake applies the request now (or answers `status`) and replies when the test calls release().
  const gate = () => {
    let release!: () => void;
    const heldUntil = new Promise<void>((r) => (release = r));
    return { heldUntil, release };
  };
  const denied = { status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" } } };
  const slow = () => ({ ...urls, timeoutMs: 10_000 });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 300 && !ok(); i++) await sleep(10);
    expect(ok()).toBe(true);
  };
  const expire = (id: string) => db.update(deliveries).set({ updatedAt: sql`now() - interval '10 minutes'` }).where(eq(deliveries.id, id));
  const moveToSheetB = async () => {
    const rows = fake.addSheet("sheet-b", "Sheet B", "Requests", ["sheets@ana.iam.gserviceaccount.com"]).tabs.get("Requests")!;
    await db.update(connections).set({ destination: { spreadsheetId: "sheet-b", tab: "Requests", title: "Sheet B" } }).where(and(eq(connections.userId, ana), eq(connections.provider, "google_sheets")));
    return rows;
  };

  it("after Post again to another sheet, the old worker's late success changes nothing and the new refusal shows as failed", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-3001");
    const a = gate();
    fake.once(":batchUpdate", { heldUntil: a.heldUntil });
    const workerA = runDueDeliveries(db, key, slow());
    await until(() => sheetRows.length === 1); // A's row is in sheet A; its answer is held

    await expire(d.id);
    const rowsB = await moveToSheetB();
    await deliverDue(); // takes back A's claim and finds the connection moved
    expect(await state(d.id)).toMatchObject({ state: "needs_review" });
    expect(await retryDelivery(db, ana, d.id, { postAgain: true })).toBe(true);

    const b = gate();
    fake.once(":batchUpdate", { heldUntil: b.heldUntil, ...denied });
    const before = appends();
    const workerB = runDueDeliveries(db, key, slow());
    await until(() => appends() === before + 1); // B's request reached Google; its answer is held

    a.release();
    await workerA;
    expect(await state(d.id)).toMatchObject({ state: "sending", result: null });

    b.release();
    await workerB;
    expect(await state(d.id)).toMatchObject({ state: "failed", lastError: expect.stringContaining("refused access") });
    expect([sheetRows.length, rowsB.length]).toEqual([1, 0]);
  });

  it("after a manual Retry, the old worker's late success cannot mark the new attempt delivered", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-3002");
    const a = gate();
    fake.once(":batchUpdate", { heldUntil: a.heldUntil, ...denied });
    const start = appends();
    const workerA = runDueDeliveries(db, key, slow());
    await until(() => appends() === start + 1); // A's request reached Google; its answer is held

    await expire(d.id);
    fake.once(":batchUpdate", denied);
    await deliverDue(); // another worker takes the claim back and is refused
    expect(await state(d.id)).toMatchObject({ state: "failed" });
    expect(await retryDelivery(db, ana, d.id)).toBe(true);

    const c = gate();
    fake.once(":batchUpdate", { heldUntil: c.heldUntil, status: 503, body: { error: { code: 503, message: "Backend Error" } } });
    const before = appends();
    const workerC = runDueDeliveries(db, key, slow());
    await until(() => appends() === before + 1);

    a.release(); // A's late refusal
    await workerA;
    expect(await state(d.id)).toMatchObject({ state: "sending" });
    c.release();
    await workerC;
    expect(await state(d.id)).toMatchObject({ state: "queued", lastError: expect.stringContaining("503") });
  });

  it("a worker whose expired claim was taken over and delivered cannot turn the delivery into a failure", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-3003");
    const a = gate();
    fake.once(":batchUpdate", { heldUntil: a.heldUntil, ...denied });
    const start = appends();
    const workerA = runDueDeliveries(db, key, slow());
    await until(() => appends() === start + 1); // A's request reached Google; its answer is held
    await expire(d.id);
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "delivered" });
    a.release();
    await workerA;
    expect(await state(d.id)).toMatchObject({ state: "delivered", lastError: null });
    expect(sheetRows).toHaveLength(1);
  });

  it("a worker that loses its claim while pinning the first destination sends nothing (Astra, 8e2c5d8)", async () => {
    await removeConnection(db, ana, "google_sheets");
    const d = await sheet(ana, await newRun(ana), "REQ-3010"); // queued before any sheet was connected: no pin yet
    expect((await state(d.id)).pinnedAccount).toBe("");
    await saveConnection(db, key, ana, "google_sheets", {
      account: "sheets@ana.iam.gserviceaccount.com",
      credential: JSON.stringify(serviceAccount("sheets@ana.iam.gserviceaccount.com")),
      destination: { spreadsheetId: "sheet-ana", tab: "Requests", title: "Office requests" },
    });
    // Stop worker A at the exact point: after its claim and after it read the connection (sheet A), at its first-pin UPDATE.
    const waiting = async (locktype: string) => {
      for (let i = 0; i < 300; i++) {
        const { rows } = await pool.query("select count(*)::int as n from pg_locks where not granted and locktype = $1", [locktype]);
        if (rows[0].n > 0) return;
        await sleep(10);
      }
      throw new Error(`worker A never waited on a ${locktype} lock`);
    };
    const tables = await pool.connect();
    const row = await pool.connect();
    await tables.query("begin");
    await tables.query("lock table connections in access exclusive mode");
    const workerA = runDueDeliveries(db, key, slow());
    await waiting("relation"); // A has claimed and waits to read the connection
    await row.query("begin");
    await row.query("select 1 from deliveries where id = $1 for update", [d.id]);
    await tables.query("commit");
    tables.release();
    await waiting("transactionid"); // A read sheet A and waits to pin it
    // Meanwhile A's claim expired, and worker B took it over, pinned sheet B and delivered there.
    await moveToSheetB();
    await row.query("update deliveries set claim_id = gen_random_uuid(), state = 'delivered', pinned_destination = $2, result = '{\"sheet\":\"Requests\"}' where id = $1", [
      d.id,
      JSON.stringify({ spreadsheetId: "sheet-b", tab: "Requests", title: "Sheet B" }),
    ]);
    await row.query("commit");
    row.release();
    await workerA;
    expect(sheetRows).toHaveLength(0); // nothing in the former sheet
    expect(await state(d.id)).toMatchObject({ state: "delivered", pinnedDestination: { spreadsheetId: "sheet-b" } });
  });

  it("a late authentication refusal for a replaced credential leaves the new connection working (Astra, 8e2c5d8)", async () => {
    const old = await sheet(ana, await newRun(ana), "REQ-3011");
    const a = gate();
    fake.once("/token", { heldUntil: a.heldUntil, status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } });
    const tokenCalls = () => fake.calls.filter((c) => c === "POST /token").length;
    const start = tokenCalls();
    const workerA = runDueDeliveries(db, key, slow());
    await until(() => tokenCalls() === start + 1); // the old key's sign-in reached Google; the refusal is held

    // The owner replaces the connection with a new key and sheet; a new delivery goes through.
    fake.addSheet("sheet-new", "New sheet", "Requests", ["sheets@ana-new.iam.gserviceaccount.com"]);
    await saveConnection(db, key, ana, "google_sheets", {
      account: "sheets@ana-new.iam.gserviceaccount.com",
      credential: JSON.stringify(serviceAccount("sheets@ana-new.iam.gserviceaccount.com")),
      destination: { spreadsheetId: "sheet-new", tab: "Requests", title: "New sheet" },
    });
    const fresh = await sheet(ana, await newRun(ana), "REQ-3012");
    await deliverDue();
    expect(await state(fresh.id)).toMatchObject({ state: "delivered" });

    a.release(); // the old credential's 401 arrives late
    await workerA;
    expect((await readConnections(db, ana)).find((c) => c.provider === "google_sheets")).toMatchObject({ status: "active", lastError: null });
    expect(await state(old.id)).toMatchObject({ state: "failed" });
    const next = await sheet(ana, await newRun(ana), "REQ-3013");
    await deliverDue();
    expect(await state(next.id)).toMatchObject({ state: "delivered" });
  });

  it("gives every claim its own id, never reused across take-overs, Retry and Post again", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-3004");
    const ids: (string | null)[] = [];
    ids.push((await claimDueDeliveries(db)).find((x) => x.id === d.id)!.claimId);
    await expire(d.id);
    ids.push((await claimDueDeliveries(db)).find((x) => x.id === d.id)!.claimId);
    await db.update(deliveries).set({ state: "failed" }).where(eq(deliveries.id, d.id));
    await retryDelivery(db, ana, d.id);
    ids.push((await claimDueDeliveries(db)).find((x) => x.id === d.id)!.claimId);
    await db.update(deliveries).set({ state: "needs_review" }).where(eq(deliveries.id, d.id));
    await retryDelivery(db, ana, d.id, { postAgain: true });
    ids.push((await claimDueDeliveries(db)).find((x) => x.id === d.id)!.claimId);
    expect(ids.every((x) => typeof x === "string")).toBe(true);
    expect(new Set(ids).size).toBe(4);
  });

  it("concurrent workers each claim a due delivery once, and only the claim holder records the outcome", async () => {
    const ds = await Promise.all(["REQ-3005", "REQ-3006", "REQ-3007"].map(async (r) => sheet(ana, await newRun(ana), r)));
    const [x, y] = await Promise.all([claimDueDeliveries(db), claimDueDeliveries(db)]);
    expect([...x!, ...y!].map((c) => c.id).sort()).toEqual(ds.map((d) => d.id).sort());
    await db.update(deliveries).set({ state: "queued", nextAttemptAt: sql`now()` });
    await deliverDue();
    expect((await Promise.all(ds.map((d) => state(d.id)))).map((s) => s.state)).toEqual(["delivered", "delivered", "delivered"]);
    expect(sheetRows).toHaveLength(3);
  });
});

describe("markers of uncertain Sheets deliveries (retest of 6e13e32)", () => {
  // A request held by Google lands only when the test says so: { late } applies it after that many milliseconds.
  const LATE = 1500;
  const age = (id: string) => db.update(deliveries).set({ updatedAt: sql`now() - interval '25 hours'` }).where(eq(deliveries.id, id));

  it("keeps the marker of a delivery whose first answer was lost, so a request landing after the sweep adds nothing", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-3001");
    fake.once(":batchUpdate", { late: LATE });
    const started = Date.now();
    await deliverDue(); // times out after 300 ms: uncertain
    expect(await state(d.id)).toMatchObject({ state: "queued" });
    await makeDue(d.id);
    await deliverDue(); // the retry writes the row and the marker
    expect(await state(d.id)).toMatchObject({ state: "delivered" });
    await age(d.id);
    await clearSheetWriteKeys(db, key, urls);
    expect(sheetState.metadata.has((await state(d.id)).sheetMetaId!)).toBe(true);
    await sleep(LATE + 200 - (Date.now() - started)); // the held request lands now
    expect(sheetRows).toHaveLength(1);
  });

  it("keeps the marker when the worker died mid-call before recording anything", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-3002");
    // The crashed worker: it claimed the delivery and sent the request, which Google holds, then died.
    const [claimed] = await claimDueDeliveries(db);
    const conn = (await connectionCredential(db, key, ana, "google_sheets"))!;
    fake.once(":batchUpdate", { late: LATE });
    const started = Date.now();
    void appendRowOnce(urls, serviceAccountSchema.parse(JSON.parse(conn.credential)), conn.destination as SheetDestination, (claimed!.payload as { row: string[] }).row, {
      id: claimed!.sheetMetaId!,
      value: claimed!.sheetMetaValue!,
    }).catch(() => undefined);
    // Its claim goes stale, another worker takes over and delivers.
    await sleep(50);
    await db.update(deliveries).set({ updatedAt: sql`now() - interval '10 minutes'` }).where(eq(deliveries.id, d.id));
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "delivered" });
    await age(d.id);
    await clearSheetWriteKeys(db, key, urls);
    expect(sheetState.metadata.has(claimed!.sheetMetaId!)).toBe(true);
    await sleep(LATE + 200 - (Date.now() - started));
    expect(sheetRows).toHaveLength(1);
  });

  it("keeps it after a manual Retry too, and still deletes markers of deliveries with only definite answers", async () => {
    const uncertain = await sheet(ana, await newRun(ana), "REQ-3003");
    for (let i = 0; i < DELIVERY_POLICY.maxAttempts; i++) {
      fake.once(":batchUpdate", "hang");
      await makeDue(uncertain.id);
      await deliverDue();
    }
    expect((await state(uncertain.id)).state).toBe("failed");
    await retryDelivery(db, ana, uncertain.id);
    await deliverDue();
    // A definite refusal (rate limit) is not uncertain: Google did not take that request.
    const definite = await sheet(ana, await newRun(ana), "REQ-3004");
    fake.once(":batchUpdate", { status: 429, body: { error: { code: 429, message: "quota" } } });
    await deliverDue();
    await makeDue(definite.id);
    await deliverDue();
    expect([(await state(uncertain.id)).state, (await state(definite.id)).state]).toEqual(["delivered", "delivered"]);
    await age(uncertain.id);
    await age(definite.id);
    await clearSheetWriteKeys(db, key, urls);
    expect(sheetState.metadata.has((await state(uncertain.id)).sheetMetaId!)).toBe(true);
    expect(sheetState.metadata.has((await state(definite.id)).sheetMetaId!)).toBe(false);
  });

  it("lets two sweeps run at once without errors, deleting each certain marker once", async () => {
    const d = await sheet(ana, await newRun(ana), "REQ-3005");
    await deliverDue();
    await age(d.id);
    const cleared = await Promise.all([clearSheetWriteKeys(db, key, urls), clearSheetWriteKeys(db, key, urls)]);
    expect(cleared.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
    expect(sheetState.metadata.has((await state(d.id)).sheetMetaId!)).toBe(false);
    expect((await state(d.id)).sheetMetaClearedAt).not.toBeNull();
  });
});

describe("booking changes stop queued deliveries (N2b, decision 0032)", () => {
  const notSent = "The booking was rescheduled or cancelled, so this was not sent.";
  /** A run linked to version 1 of a booking, as its booking step leaves it. bump() raises the version, as cancel and reschedule do. */
  async function bookedRun(userId: string) {
    const runId = await newRun(userId);
    const tag = randomBytes(4).toString("hex");
    const [res] = await db.insert(resources).values({ userId, name: `Chair ${tag}` }).returning();
    const [b] = await db
      .insert(bookings)
      .values({ userId, test: false, reference: `B-${tag}`, resourceId: res!.id, during: sql`tstzrange(now(), now() + interval '1 hour')` as unknown as string, timezone: "Asia/Manila", runId })
      .returning();
    await db.update(runs).set({ bookingId: b!.id, bookingVersion: 1 }).where(eq(runs.id, runId));
    return { runId, bump: () => db.update(bookings).set({ version: sql`${bookings.version} + 1` }).where(eq(bookings.id, b!.id)) };
  }

  it("sends nothing when the booking changed before the delivery was claimed, and says why", async () => {
    const b = await bookedRun(ana);
    const row = await sheet(ana, b.runId, "REQ-B1");
    const msg = await slack(ana, b.runId, "REQ-B1");
    await b.bump();
    const before = appends();
    await deliverDue();
    expect(appends()).toBe(before);
    expect(sheetRows).toHaveLength(0);
    expect(fake.slack.messages).toHaveLength(0);
    for (const d of [await state(row.id), await state(msg.id)]) expect(d).toMatchObject({ state: "failed", lastError: notSent, errorKind: "booking_changed" });
  });

  it("refuses Retry and Post again once the booking changed, and a retry queued before the change sends nothing", async () => {
    const b = await bookedRun(ana);
    const d = await slack(ana, b.runId, "REQ-B2");
    await db.update(deliveries).set({ state: "failed", lastError: "Slack is down." }).where(eq(deliveries.id, d.id));
    expect(await retryDelivery(db, ana, d.id)).toBe(true);
    await b.bump();
    await deliverDue();
    expect(fake.slack.messages).toHaveLength(0);
    expect(await state(d.id)).toMatchObject({ state: "failed", lastError: notSent });
    expect(await retryDelivery(db, ana, d.id)).toBe(false);
    await db.update(deliveries).set({ state: "needs_review" }).where(eq(deliveries.id, d.id));
    expect(await retryDelivery(db, ana, d.id, { postAgain: true })).toBe(false);
    expect((await state(d.id)).state).toBe("needs_review");
  });

  it("makes a change that arrives while the delivery is sending wait until the call returns", async () => {
    const b = await bookedRun(ana);
    const d = await slack(ana, b.runId, "REQ-B3");
    let release!: () => void;
    fake.once("chat.postMessage", { heldUntil: new Promise<void>((r) => (release = r)) });
    const sending = runDueDeliveries(db, key, { ...urls, timeoutMs: 5000 });
    for (let i = 0; i < 300 && fake.slack.messages.length === 0; i++) await sleep(10);
    expect(fake.slack.messages).toHaveLength(1);
    let changed = false;
    const change = b.bump().then(() => (changed = true));
    await sleep(300);
    expect(changed).toBe(false);
    release();
    await sending;
    await change;
    expect(await state(d.id)).toMatchObject({ state: "delivered" });
  });

  it("delivers for a run with no booking, and for a run whose own booking step moved the link", async () => {
    const plain = await slack(ana, await newRun(ana), "REQ-B4");
    const b = await bookedRun(ana);
    await b.bump();
    await db.update(runs).set({ bookingVersion: 2 }).where(eq(runs.id, b.runId));
    const moved = await slack(ana, b.runId, "REQ-B5");
    await deliverDue();
    expect(await state(plain.id)).toMatchObject({ state: "delivered" });
    expect(await state(moved.id)).toMatchObject({ state: "delivered" });
    expect(fake.slack.messages).toHaveLength(2);
  });
});

describe("Telegram", () => {
  const tg = (userId: string, runId: string, reference: string) =>
    queueDelivery(db, { userId, runId, stepId: "send_to_telegram", provider: "telegram", reference, payload: { text: `New request ${reference}` } });
  beforeEach(async () => {
    fake.telegram.token = "100000001:ana-telegram-token-aaaaaaaaaaaaaaaaaaaa";
    fake.telegram.revoked = false;
    fake.telegram.messages.length = 0;
    await saveConnection(db, key, ana, "telegram", { account: "@daloy_test_bot", credential: fake.telegram.token, destination: { chatId: "-1001234567890", chatTitle: "Office team" } });
  });

  it("delivers to the chat saved on the connection", async () => {
    const d = await tg(ana, await newRun(ana), "REQ-2001");
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "delivered", result: { chatId: "-1001234567890" } });
    expect(fake.telegram.messages.map((m) => m.text)).toEqual(["New request REQ-2001"]);
  });

  it("holds for review when the chat changed after queueing, and sends nothing", async () => {
    const d = await tg(ana, await newRun(ana), "REQ-2002");
    await saveConnection(db, key, ana, "telegram", { account: "@daloy_test_bot", credential: fake.telegram.token, destination: { chatId: "-1009999999999", chatTitle: "Other" } });
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "needs_review", errorKind: "destination_changed" });
    expect(fake.telegram.messages).toHaveLength(0);
  });

  it("fails and marks the connection when the token is revoked", async () => {
    const d = await tg(ana, await newRun(ana), "REQ-2003");
    fake.telegram.revoked = true;
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "failed", errorKind: "auth" });
  });

  it("retries after a rate limit, then holds for review when Telegram may have accepted the message", async () => {
    const d = await tg(ana, await newRun(ana), "REQ-2004");
    fake.once("sendMessage", { status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } }, headers: {} });
    await deliverDue();
    expect(await state(d.id)).toMatchObject({ state: "queued", errorKind: "quota" });
    const e = await tg(ana, await newRun(ana), "REQ-2005");
    fake.once("sendMessage", "hang-after");
    await deliverDue();
    const held = await state(e.id);
    expect(held).toMatchObject({ state: "needs_review", errorKind: "ambiguous" });
    expect(held.lastError).toMatch(/telegram chat/i);
    expect(await retryDelivery(db, ana, e.id)).toBe(false);
  });
});
