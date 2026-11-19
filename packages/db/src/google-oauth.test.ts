import { generateKeyPairSync, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { connectionCredential, saveConnection, setDestination } from "./connections";
import { clearSheetWriteKeys, queueDelivery, retryDelivery, runDueDeliveries } from "./deliveries";
import { createDriveFolder, createSpreadsheet, pickerToken, withGoogle } from "./google-access";
import type { Db } from "./index";
import { consumeFlow, finishFlow, googleDrive, googleSheets, readTokenBlob, startFlow, type OAuthProvider } from "./oauth";
import { appendRowOnce, driveFolderInfo, driveUpload, sheetInfo, type ProviderUrls } from "./providers";
import { createRun } from "./runs";
import { connections, deliveries, users, workflows, workflowVersions } from "./schema";
import { saveUploads } from "./uploads";

// Decision 0060: Sheets and Drive through a Google sign-in (drive.file), against the fake's Google OAuth app.
const key = randomBytes(32);
const PUBLIC = "http://localhost:3000";
const ANA = { id: "google-ana", email: "ana@clinic.example" };
const BEN = { id: "google-ben", email: "ben@clinic.example" };
const SA = "sheets@clinic.iam.gserviceaccount.com";
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let saCredential: string;
let seq = 0;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  const app = fake.addOAuthApp("google", { rotation: "none" });
  urls = { ...fake.urls, timeoutMs: 2000, googleOAuth: { clientId: app.clientId, clientSecret: app.clientSecret, ...fake.oauthUrls("google") } };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fake.addServiceAccount(SA, publicKey.export({ type: "spki", format: "pem" }).toString());
  saCredential = JSON.stringify({ client_email: SA, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
}, 120_000);
afterAll(async () => {
  await fake?.close();
  await pool?.end();
});
beforeEach(() => {
  Object.assign(fake.oauth.google!, { consent: "grant", user: ANA });
});

async function workspace() {
  const [u] = await db.insert(users).values({ email: `g${++seq}@test.local`, passwordHash: "x" }).returning();
  const [w] = await db.insert(workflows).values({ userId: u!.id, name: "W", slug: `w${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: w!.id, version: 1, definition: {}, published: true }).returning();
  return { id: u!.id, versionId: v!.id };
}
/** The whole consent: start, the fake's consent page, the one-time flow, and the code exchange. */
async function connectGoogle(ws: string, who: { id: string; email: string }, def: OAuthProvider = googleSheets) {
  fake.oauth.google!.user = who;
  const back = new URL((await fetch(await startFlow(db, key, urls, PUBLIC, def, { workspaceId: ws, memberId: ws }), { redirect: "manual" })).headers.get("location")!);
  const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: ws, memberId: ws });
  return finishFlow(db, key, urls, PUBLIC, def, ws, back.searchParams.get("code")!, flow!.verifier);
}
const conn = async (ws: string, provider: "google_sheets" | "google_drive" = "google_sheets") => (await connectionCredential(db, key, ws, provider))!;
const row = async (id: string) => (await db.select().from(deliveries).where(eq(deliveries.id, id)))[0]!;
const newSheet = (who: string[]) => {
  const id = `picked-sheet-${String(++seq).padStart(6, "0")}`;
  return { id, state: fake.addSheet(id, "Office requests", "Requests", who) };
};
const queueRow = async (ws: { id: string; versionId: string }) => queueDelivery(db, { userId: ws.id, runId: await createRun(db, ws.versionId, {}), stepId: "sheet", provider: "google_sheets", reference: `REQ-${++seq}`, payload: { row: ["REQ", "2026-11-19T09:00:00.000Z", "Printer jammed"] } });
const deliver = () => runDueDeliveries(db, key, urls);
const due = (id: string) => db.update(deliveries).set({ nextAttemptAt: sql`now()` }).where(eq(deliveries.id, id));

describe("the Google definition", () => {
  it("connects with drive.file and the account's stable id, and a narrower grant saves nothing", async () => {
    const ws = await workspace();
    expect(await connectGoogle(ws.id, ANA)).toBe("connected");
    const [c] = await db.select().from(connections).where(eq(connections.userId, ws.id));
    expect(c).toMatchObject({ provider: "google_sheets", authMethod: "oauth", externalId: ANA.id, account: ANA.email, scopes: "openid email https://www.googleapis.com/auth/drive.file" });
    const other = await workspace();
    Object.assign(fake.oauth.google!, { consent: "narrow", grantScopes: ["openid", "email"] });
    expect(await connectGoogle(other.id, ANA)).toBe("missing_scope");
    expect(await db.select().from(connections).where(eq(connections.userId, other.id))).toEqual([]);
  });
});

describe("Sheets through the OAuth token", () => {
  it("adds the row with its developer metadata marker, and a repeat of the same write adds nothing", async () => {
    const ws = await workspace();
    await connectGoogle(ws.id, ANA);
    const s = newSheet([ANA.email]);
    await setDestination(db, ws.id, "google_sheets", { spreadsheetId: s.id, tab: "Requests", title: "Office requests" });
    const d = await queueRow(ws);
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "delivered", result: { sheet: "Requests" } });
    expect(s.state.tabs.get("Requests")).toHaveLength(1);
    expect(s.state.metadata.get(d.sheetMetaId!)).toMatchObject({ metadataKey: "daloy", metadataValue: d.sheetMetaValue, visibility: "PROJECT" });
    // The same marked write again, as a retry after a lost answer would send it.
    const c = await conn(ws.id);
    const again = await withGoogle(db, key, urls, ws.id, "google_sheets", c, (auth) => appendRowOnce(urls, auth, { spreadsheetId: s.id, tab: "Requests" }, ["dup"], { id: d.sheetMetaId!, value: d.sheetMetaValue! }));
    expect(again).toEqual({ sheet: "Requests", reconciled: true });
    expect(s.state.tabs.get("Requests")).toHaveLength(1);
    // The marker sweep deletes it through the same grant.
    await db.update(deliveries).set({ updatedAt: sql`now() - interval '2 days'` }).where(eq(deliveries.id, d.id));
    expect(await clearSheetWriteKeys(db, key, urls, 0)).toBeGreaterThanOrEqual(1);
    expect(s.state.metadata.has(d.sheetMetaId!)).toBe(false);
  });

  it("refreshes once when Google refuses an access token that looked fresh", async () => {
    const ws = await workspace();
    await connectGoogle(ws.id, ANA);
    const s = newSheet([ANA.email]);
    await setDestination(db, ws.id, "google_sheets", { spreadsheetId: s.id, tab: "Requests", title: "Office requests" });
    fake.oauth.google!.accessTokens.clear();
    const calls = fake.oauth.google!.tokenCalls;
    const d = await queueRow(ws);
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "delivered" });
    expect(fake.oauth.google!.tokenCalls).toBe(calls + 1);
  });

  it("fails as a permission problem that says to pick the sheet again when the grant cannot reach it", async () => {
    const ws = await workspace();
    await connectGoogle(ws.id, ANA);
    const s = newSheet([ANA.email]);
    await setDestination(db, ws.id, "google_sheets", { spreadsheetId: s.id, tab: "Requests", title: "Office requests" });
    s.state.editors.delete(ANA.email); // access to a picked file lost, as after a reconnect (unverified live)
    const d = await queueRow(ws);
    await deliver();
    const r = await row(d.id);
    expect(r).toMatchObject({ state: "failed", errorKind: "permission" });
    expect(r.lastError).toMatch(/pick the sheet again/);
    expect((await conn(ws.id)).status).toBe("active");
  });

  it("marks the connection failed when Google refuses the grant itself", async () => {
    const ws = await workspace();
    await connectGoogle(ws.id, ANA);
    const s = newSheet([ANA.email]);
    await setDestination(db, ws.id, "google_sheets", { spreadsheetId: s.id, tab: "Requests", title: "Office requests" });
    fake.oauth.google!.refreshTokens.clear();
    fake.oauth.google!.accessTokens.clear();
    const d = await queueRow(ws);
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "failed", errorKind: "auth" });
    expect((await conn(ws.id)).status).toBe("failed");
  });

  it("creates a spreadsheet the grant can use, and reads only sheets it was given (R12)", async () => {
    const ws = await workspace();
    await connectGoogle(ws.id, ANA);
    const c = await conn(ws.id);
    const made = await withGoogle(db, key, urls, ws.id, "google_sheets", c, (auth) => createSpreadsheet(urls, auth, "Daloy requests"));
    expect(made).toMatchObject({ title: "Daloy requests", tabs: ["Sheet1"] });
    expect(await withGoogle(db, key, urls, ws.id, "google_sheets", c, (auth) => sheetInfo(urls, auth, made.spreadsheetId))).toEqual({ title: "Daloy requests", tabs: ["Sheet1"] });
    const notPicked = newSheet(["someone@else.example"]);
    await expect(withGoogle(db, key, urls, ws.id, "google_sheets", c, (auth) => sheetInfo(urls, auth, notPicked.id))).rejects.toMatchObject({ kind: "permission", message: expect.stringMatching(/pick the sheet again/) });
  });

  it("hands the Picker a freshly refreshed token, and only for a Google sign-in", async () => {
    const ws = await workspace();
    await connectGoogle(ws.id, ANA);
    const c = await conn(ws.id);
    const before = readTokenBlob(c.credential).accessToken;
    const t = await pickerToken(db, key, urls, ws.id, "google_sheets", c);
    expect(t.accessToken).not.toBe(before);
    expect(t.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000);
    const sa = await workspace();
    await saveConnection(db, key, sa.id, "google_sheets", { account: SA, credential: saCredential, destination: null });
    await expect(pickerToken(db, key, urls, sa.id, "google_sheets", await conn(sa.id))).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("pinned deliveries across re-authorization (R7)", () => {
  async function connectedWithSheet(who = ANA) {
    const ws = await workspace();
    await connectGoogle(ws.id, who);
    const s = newSheet([ANA.email, BEN.email, SA]);
    await setDestination(db, ws.id, "google_sheets", { spreadsheetId: s.id, tab: "Requests", title: "Office requests" });
    return { ws, s };
  }

  it("same account: the destination is kept and the queued row goes in", async () => {
    const { ws, s } = await connectedWithSheet();
    const d = await queueRow(ws);
    await connectGoogle(ws.id, ANA);
    expect((await conn(ws.id)).destination).toMatchObject({ spreadsheetId: s.id });
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "delivered" });
  });

  it("another account clears the destination; picking the same sheet and tab again sends without review", async () => {
    const { ws, s } = await connectedWithSheet();
    const d = await queueRow(ws);
    await connectGoogle(ws.id, BEN);
    expect((await conn(ws.id)).destination).toBeNull();
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "failed", errorKind: "no_destination" });
    await setDestination(db, ws.id, "google_sheets", { spreadsheetId: s.id, tab: "Requests", title: "Office requests" });
    expect(await retryDelivery(db, ws.id, d.id)).toBe(true);
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "delivered" });
    expect(s.state.tabs.get("Requests")).toHaveLength(1);
  });

  it("another account with another sheet goes to review and writes nothing", async () => {
    const { ws, s } = await connectedWithSheet();
    const d = await queueRow(ws);
    await connectGoogle(ws.id, BEN);
    const other = newSheet([BEN.email]);
    await setDestination(db, ws.id, "google_sheets", { spreadsheetId: other.id, tab: "Requests", title: "Other" });
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "needs_review", errorKind: "destination_changed" });
    expect(s.state.tabs.get("Requests")).toHaveLength(0);
    expect(other.state.tabs.get("Requests")).toHaveLength(0);
  });

  it("service account to Google sign-in for the same sheet sends without review", async () => {
    const ws = await workspace();
    const s = newSheet([SA, ANA.email]);
    await saveConnection(db, key, ws.id, "google_sheets", { account: SA, credential: saCredential, destination: { spreadsheetId: s.id, tab: "Requests", title: "Office requests" } });
    const d = await queueRow(ws);
    expect(d.pinnedAccount).toBe(SA);
    await connectGoogle(ws.id, ANA);
    await setDestination(db, ws.id, "google_sheets", { spreadsheetId: s.id, tab: "Requests", title: "Office requests" });
    await due(d.id);
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "delivered" });
  });

  it("still sends a tab change to review", async () => {
    const { ws, s } = await connectedWithSheet();
    s.state.tabs.set("Other", []);
    const d = await queueRow(ws);
    await setDestination(db, ws.id, "google_sheets", { spreadsheetId: s.id, tab: "Other", title: "Office requests" });
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "needs_review", errorKind: "destination_changed" });
  });
});

describe("Drive through the OAuth token", () => {
  it("creates a folder in My Drive, saves files there, and checks a picked folder without the shared drive rule", async () => {
    const ws = await workspace();
    await connectGoogle(ws.id, ANA, googleDrive);
    const c = await conn(ws.id, "google_drive");
    const folder = await withGoogle(db, key, urls, ws.id, "google_drive", c, (auth) => createDriveFolder(urls, auth, "Daloy uploads"));
    expect(fake.driveFolder(folder.folderId)).toMatchObject({ name: "Daloy uploads", sharedDriveId: null });
    await setDestination(db, ws.id, "google_drive", folder);
    const runId = await createRun(db, ws.versionId, {});
    const file = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, field: "photo", name: "front.png", type: "png" as const, data: Buffer.from("png bytes") };
    await saveUploads(db, { userId: ws.id, runId, files: [file] });
    const d = await queueDelivery(db, { userId: ws.id, runId, stepId: "drive", provider: "google_drive", reference: "REQ-9", payload: { files: [{ id: file.id, name: file.name, type: file.type, size: file.data.length }] } });
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "delivered", result: { folder: "Daloy uploads", count: 1 } });
    expect(fake.driveFiles.filter((f) => f.parent === folder.folderId).map((f) => f.name)).toEqual(["REQ-9 front.png"]);
    // A picked folder in My Drive is fine for a Google sign-in; one never picked answers as not reachable.
    fake.addDriveFolder("my-drive-folder-01", "Patient files", [ANA.email], null);
    expect(await withGoogle(db, key, urls, ws.id, "google_drive", c, (auth) => driveFolderInfo(urls, auth, "my-drive-folder-01"))).toEqual({ title: "Patient files" });
    fake.addDriveFolder("not-picked-folder-1", "Theirs", ["someone@else.example"], null);
    await expect(withGoogle(db, key, urls, ws.id, "google_drive", c, (auth) => driveUpload(urls, auth, "not-picked-folder-1", { name: "x", mimeType: "image/png", data: Buffer.from("x") }))).rejects.toMatchObject({ kind: "permission", message: expect.stringMatching(/pick the folder again/) });
  });

  it("service account to Google sign-in for the same folder saves without review", async () => {
    const ws = await workspace();
    fake.addDriveFolder("shared-folder-0001", "Intake", [SA, ANA.email], "0Ashared");
    await saveConnection(db, key, ws.id, "google_drive", { account: SA, credential: saCredential, destination: { folderId: "shared-folder-0001", title: "Intake" } });
    const runId = await createRun(db, ws.versionId, {});
    const file = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, field: "photo", name: "scan.pdf", type: "pdf" as const, data: Buffer.from("%PDF") };
    await saveUploads(db, { userId: ws.id, runId, files: [file] });
    const d = await queueDelivery(db, { userId: ws.id, runId, stepId: "drive", provider: "google_drive", reference: "REQ-10", payload: { files: [{ id: file.id, name: file.name, type: file.type, size: file.data.length }] } });
    await connectGoogle(ws.id, ANA, googleDrive);
    await setDestination(db, ws.id, "google_drive", { folderId: "shared-folder-0001", title: "Intake" });
    await deliver();
    expect(await row(d.id)).toMatchObject({ state: "delivered" });
  });
});
