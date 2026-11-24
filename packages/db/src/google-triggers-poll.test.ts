import { generateKeyPairSync, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { removeConnection, saveConnection, setDestination } from "./connections";
import { pollGoogleTriggers } from "./google-triggers";
import type { Db } from "./index";
import { consumeFlow, finishFlow, googleSheets, startFlow } from "./oauth";
import type { ProviderUrls } from "./providers";
import { connections, runs, triggerPolls, triggers, uploads, users, workflows, workflowVersions } from "./schema";

// Decision 0127: the Google trigger poll against the fake Google APIs. Dedupe, first poll and pausing need the database.
const key = randomBytes(32);
const SA = "watch@clinic.iam.gserviceaccount.com";
const ANA = { id: "google-ana-g2", email: "ana-g2@clinic.example" };
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let saCredential: string;
let seq = 0;
const enqueued: string[] = [];
const enqueue = async (runId: string) => void enqueued.push(runId);

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  const app = fake.addOAuthApp("google", { rotation: "none" });
  app.user = ANA;
  urls = { ...fake.urls, timeoutMs: 2000, googleOAuth: { clientId: app.clientId, clientSecret: app.clientSecret, ...fake.oauthUrls("google") } };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fake.addServiceAccount(SA, publicKey.export({ type: "spki", format: "pem" }).toString());
  saCredential = JSON.stringify({ client_email: SA, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
}, 120_000);
afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

async function automation(trigger: { type: string; config: Record<string, unknown> }, steps: unknown[] = [{ id: "wait", type: "delay", config: { seconds: 5 } }]) {
  const [u] = await db.insert(users).values({ email: `g2-${++seq}@test.local`, passwordHash: "x" }).returning();
  const [w] = await db.insert(workflows).values({ userId: u!.id, name: "Watcher", slug: `watch-${seq}` }).returning();
  await db.insert(workflowVersions).values({ workflowId: w!.id, version: 1, definition: { trigger, steps, edges: [] }, published: true });
  await db.insert(triggers).values({ workflowId: w!.id, type: trigger.type, config: trigger.config });
  return { ws: u!.id, workflowId: w!.id };
}
const poll = () => pollGoogleTriggers({ db, secretsKey: key, urls, enqueue });
const due = (workflowId: string) => db.update(triggerPolls).set({ nextPollAt: sql`now()` }).where(eq(triggerPolls.workflowId, workflowId));
const state = async (workflowId: string) => (await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, workflowId)))[0]!;
const runsOf = async (workflowId: string) =>
  (await db.execute<{ id: string; trigger_payload: Record<string, unknown> }>(sql`select r.id, r.trigger_payload from runs r join workflow_versions v on v.id = r.workflow_version_id where v.workflow_id = ${workflowId} order by r.created_at`)).rows;

describe("sheets_row", () => {
  it("baselines on the first poll, starts one run per new row, and never twice for the same row", async () => {
    const sheetId = `g2-sheet-${String(++seq).padStart(6, "0")}`;
    const sheet = fake.addSheet(sheetId, "Orders", "Orders", [SA]);
    sheet.tabs.get("Orders")!.push(["Customer Name", "Item"], ["Old", "history"]);
    const a = await automation({ type: "sheets_row", config: { tab: "Orders" } });
    await saveConnection(db, key, a.ws, "google_sheets", { account: SA, credential: saCredential, destination: { spreadsheetId: sheetId, tab: "Orders", title: "Orders" } });

    await poll();
    expect(await runsOf(a.workflowId)).toEqual([]);
    expect(await state(a.workflowId)).toMatchObject({ cursor: { rows: 2 }, problem: null, failures: 0 });

    sheet.tabs.get("Orders")!.push(["Ana", "Ube jam"]);
    await poll(); // not due yet
    expect(await runsOf(a.workflowId)).toEqual([]);
    await due(a.workflowId);
    await poll();
    const [run] = await runsOf(a.workflowId);
    expect(run!.trigger_payload).toMatchObject({ spreadsheetId: sheetId, tab: "Orders", rowNumber: 3, values: ["Ana", "Ube jam"], cells: { customer_name: "Ana", item: "Ube jam" } });
    expect(enqueued).toContain(run!.id);

    // A crash after the run was made but before the cursor moved: the row is read again and finds its run.
    await db.update(triggerPolls).set({ cursor: { rows: 2 }, nextPollAt: sql`now()` }).where(eq(triggerPolls.workflowId, a.workflowId));
    await poll();
    expect(await runsOf(a.workflowId)).toHaveLength(1);
    expect((await state(a.workflowId)).cursor).toEqual({ rows: 3 });

    // Watching another tab starts over with a new first poll.
    sheet.tabs.set("Walk-ins", [["Name"], ["Earlier"]]);
    const [v] = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, a.workflowId));
    await db.update(workflowVersions).set({ definition: { ...(v!.definition as object), trigger: { type: "sheets_row", config: { tab: "Walk-ins" } } } }).where(eq(workflowVersions.id, v!.id));
    await due(a.workflowId);
    await poll();
    expect(await runsOf(a.workflowId)).toHaveLength(1);
    expect((await state(a.workflowId)).cursor).toEqual({ rows: 2 });
  });

  it("pauses with a plain reason when the account is disconnected or the grant is narrower, and resumes after", async () => {
    const sheetId = `g2-sheet-${String(++seq).padStart(6, "0")}`;
    const sheet = fake.addSheet(sheetId, "Orders", "Orders", [ANA.email]);
    const a = await automation({ type: "sheets_row", config: { tab: "Orders" } });
    const back = new URL((await fetch(await startFlow(db, key, urls, "http://localhost:3000", googleSheets, { workspaceId: a.ws, memberId: a.ws }), { redirect: "manual" })).headers.get("location")!);
    const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: a.ws, memberId: a.ws });
    expect(await finishFlow(db, key, urls, "http://localhost:3000", googleSheets, a.ws, back.searchParams.get("code")!, flow!.verifier)).toBe("connected");
    await setDestination(db, a.ws, "google_sheets", { spreadsheetId: sheetId, tab: "Orders", title: "Orders" });

    await poll();
    expect((await state(a.workflowId)).cursor).toEqual({ rows: 0 });

    // An older grant without drive.file: the poll names what to reconnect and reads nothing.
    await db.update(connections).set({ scopes: "openid email" }).where(eq(connections.userId, a.ws));
    sheet.tabs.get("Orders")!.push(["Ana"]);
    await due(a.workflowId);
    await poll();
    expect((await state(a.workflowId)).problem).toMatch(/^Reconnect Google Sheets in Apps/);
    expect(await runsOf(a.workflowId)).toEqual([]);

    await removeConnection(db, a.ws, "google_sheets");
    await due(a.workflowId);
    await poll();
    const paused = await state(a.workflowId);
    expect(paused.problem).toBe("Google Sheets is not connected. Connect it in Apps.");
    expect(paused.nextPollAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    // Reconnected: the row added while paused starts its run, since the first poll was before it.
    await saveConnection(db, key, a.ws, "google_sheets", { account: SA, credential: saCredential, destination: { spreadsheetId: sheetId, tab: "Orders", title: "Orders" } });
    sheet.editors.add(SA);
    await due(a.workflowId);
    await poll();
    expect((await state(a.workflowId)).problem).toBeNull();
    expect(await runsOf(a.workflowId)).toHaveLength(1);
  });

  it("pauses an automation that adds rows to the tab it watches", async () => {
    const sheetId = `g2-sheet-${String(++seq).padStart(6, "0")}`;
    fake.addSheet(sheetId, "Orders", "Orders", [SA]);
    const a = await automation({ type: "sheets_row", config: { tab: "Orders" } }, [{ id: "s", type: "sheets", config: { columns: ["{{trigger.rowNumber}}"] } }]);
    await saveConnection(db, key, a.ws, "google_sheets", { account: SA, credential: saCredential, destination: { spreadsheetId: sheetId, tab: "Orders", title: "Orders" } });
    await poll();
    expect((await state(a.workflowId)).problem).toMatch(/same tab/);
  });

  it("backs off after Google limits requests", async () => {
    const sheetId = `g2-sheet-${String(++seq).padStart(6, "0")}`;
    fake.addSheet(sheetId, "Orders", "Orders", [SA]);
    const a = await automation({ type: "sheets_row", config: { tab: "Orders" } });
    await saveConnection(db, key, a.ws, "google_sheets", { account: SA, credential: saCredential, destination: { spreadsheetId: sheetId, tab: "Orders", title: "Orders" } });
    fake.once(`/v4/spreadsheets/${sheetId}/values/`, { status: 429, body: { error: { code: 429, message: "Quota exceeded" } } });
    await poll();
    const s = await state(a.workflowId);
    expect(s).toMatchObject({ failures: 1, cursor: null });
    expect(s.problem).toMatch(/limiting requests/);
    expect(s.nextPollAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });
});

describe("calendar_event", () => {
  it("starts a run for an event added after the first poll, once", async () => {
    const calId = `g2cal${++seq}@group.calendar.google.com`;
    const cal = fake.addCalendar(calId, "Daloy bookings", [SA]);
    const old = new Date(Date.now() - 3_600_000).toISOString();
    cal.events.set("old1", { id: "old1", status: "confirmed", summary: "Before", start: { dateTime: "2026-12-01T01:00:00Z" }, created: old, updated: old });
    const a = await automation({ type: "calendar_event", config: { on: "created", minutesBefore: 60 } });
    await saveConnection(db, key, a.ws, "google_calendar", { account: SA, credential: saCredential, destination: { calendarId: calId, title: "Daloy bookings" } });
    await poll();
    cal.events.set("new1", { id: "new1", status: "confirmed", summary: "Ana, haircut", start: { dateTime: "2026-12-02T02:00:00Z" }, end: { dateTime: "2026-12-02T03:00:00Z" }, created: new Date().toISOString(), updated: new Date().toISOString() });
    await due(a.workflowId);
    await poll();
    await due(a.workflowId);
    await poll();
    const list = await runsOf(a.workflowId);
    expect(list).toHaveLength(1);
    expect(list[0]!.trigger_payload).toMatchObject({ calendarId: calId, eventId: "new1", event: "created", title: "Ana, haircut", start: "2026-12-02T02:00:00Z" });
  });
});

describe("drive_file", () => {
  it("starts a run per new file and attaches its bytes only within the upload limits", async () => {
    const folderId = `g2folder${String(++seq).padStart(6, "0")}`;
    fake.addDriveFolder(folderId, "Receipts", [SA], "0Ag2Shared");
    const a = await automation({ type: "drive_file", config: { requireFile: false } });
    await saveConnection(db, key, a.ws, "google_drive", { account: SA, credential: saCredential, destination: { folderId, title: "Receipts" } });
    fake.addDriveFile(folderId, { name: "before.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4 old") });
    await poll();
    expect(await runsOf(a.workflowId)).toEqual([]);

    const pdf = Buffer.from("%PDF-1.4 receipt");
    const pdfId = fake.addDriveFile(folderId, { name: "receipt.pdf", mimeType: "application/pdf", data: pdf });
    fake.addDriveFile(folderId, { name: "big.pdf", mimeType: "application/pdf", data: Buffer.alloc(6 * 1024 * 1024, 1) });
    fake.addDriveFile(folderId, { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("hello") });
    await due(a.workflowId);
    await poll();
    const list = await runsOf(a.workflowId);
    const byName = Object.fromEntries(list.map((r) => [r.trigger_payload.name, r]));
    expect(Object.keys(byName).sort()).toEqual(["big.pdf", "notes.txt", "receipt.pdf"]);
    expect(byName["receipt.pdf"]!.trigger_payload).toMatchObject({ fileId: pdfId, folderId, mimeType: "application/pdf", size: pdf.length, file: [{ name: "receipt.pdf", type: "pdf", size: pdf.length }] });
    expect(byName["big.pdf"]!.trigger_payload).toMatchObject({ file: [], fileSkipped: "too_large" });
    expect(byName["notes.txt"]!.trigger_payload).toMatchObject({ file: [], fileSkipped: "type" });
    const saved = await db.select().from(uploads).where(eq(uploads.runId, byName["receipt.pdf"]!.id));
    expect(saved.map((u) => u.data.equals(pdf))).toEqual([true]);

    await due(a.workflowId);
    await poll();
    expect(await runsOf(a.workflowId)).toHaveLength(3);
    expect(await db.select({ id: runs.id }).from(runs).where(eq(runs.id, byName["big.pdf"]!.id))).toHaveLength(1);
  });
});
