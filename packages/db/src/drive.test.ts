import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { saveConnection } from "./connections";
import { queueDelivery, retryDelivery, runDueDeliveries } from "./deliveries";
import type { Db } from "./index";
import { driveFolderIdFrom, driveFolderInfo, driveUpload, ProviderError, serviceAccountSchema, type ProviderUrls, type ServiceAccount } from "./providers";
import { createRun } from "./runs";
import { deliveries, uploads, users, workflows, workflowVersions } from "./schema";
import { saveUploads } from "./uploads";

// Saving form files to a shared drive folder (N21): the provider calls, then the delivery that saves each file once.
const key = randomBytes(32);
const EMAIL = "daloy@project.iam.gserviceaccount.com";
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let sa: ServiceAccount;
let credential: string;
let seq = 0;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
const pdf = Buffer.from("%PDF-1.4\r\n--boundary-like text\r\n");
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  urls = { ...fake.urls, timeoutMs: 2000 };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fake.addServiceAccount(EMAIL, publicKey.export({ type: "spki", format: "pem" }).toString());
  credential = JSON.stringify({ client_email: EMAIL, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  sa = serviceAccountSchema.parse(JSON.parse(credential));
}, 120_000);
afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

/** A workspace with a Drive connection to a new folder (in a shared drive unless sharedDrive is false) and a run holding two files. */
async function setup(sharedDrive = true) {
  const n = ++seq;
  const folderId = `folder${String(n).padStart(10, "0")}`;
  fake.addDriveFolder(folderId, `Intake ${n}`, [EMAIL], sharedDrive ? "0Ashared" : null);
  const [u] = await db.insert(users).values({ email: `drive${n}@test.local`, passwordHash: "x" }).returning();
  const [w] = await db.insert(workflows).values({ userId: u!.id, name: "W", slug: `w${n}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: w!.id, version: 1, definition: {}, published: true }).returning();
  const connect = (id: string, title: string) => saveConnection(db, key, u!.id, "google_drive", { account: EMAIL, credential, destination: { folderId: id, title } });
  await connect(folderId, `Intake ${n}`);
  const runId = await createRun(db, v!.id, {});
  const files = [
    { id: uuid(), field: "photo", name: "front.png", type: "png" as const, data: png },
    { id: uuid(), field: "photo", name: "scan.pdf", type: "pdf" as const, data: pdf },
  ];
  await saveUploads(db, { userId: u!.id, runId, files });
  const refs = files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.data.length }));
  const queue = (list = refs) => queueDelivery(db, { userId: u!.id, runId, stepId: "drive", provider: "google_drive", reference: "REQ-7", payload: { files: list } });
  const row = async (id: string) => (await db.select().from(deliveries).where(eq(deliveries.id, id)))[0]!;
  return { userId: u!.id, folderId, runId, refs, queue, row, connect, versionId: v!.id };
}
const savedIn = (folderId: string) => fake.driveFiles.filter((f) => f.parent === folderId);

describe("folder links", () => {
  it("takes a folder link, with a user prefix or a query, or a bare id, and refuses the rest", () => {
    expect(driveFolderIdFrom("https://drive.google.com/drive/folders/1AbC_dEf-GhIjKlMn")).toBe("1AbC_dEf-GhIjKlMn");
    expect(driveFolderIdFrom("https://drive.google.com/drive/u/2/folders/1AbC_dEf-GhIjKlMn?usp=sharing")).toBe("1AbC_dEf-GhIjKlMn");
    expect(driveFolderIdFrom(" 1AbC_dEf-GhIjKlMn ")).toBe("1AbC_dEf-GhIjKlMn");
    expect(driveFolderIdFrom("https://example.com/drive/folders/1AbC_dEf-GhIjKlMn")).toBeNull();
    expect(driveFolderIdFrom("short")).toBeNull();
    expect(driveFolderIdFrom("not a folder id!")).toBeNull();
  });
});

describe("Drive calls", () => {
  it("reads the folder title, and refuses a folder outside a shared drive or one that is not shared with the account", async () => {
    const shared = await setup();
    expect(await driveFolderInfo(urls, sa, shared.folderId)).toEqual({ title: expect.stringMatching(/^Intake/) });
    const plain = await setup(false);
    await expect(driveFolderInfo(urls, sa, plain.folderId)).rejects.toMatchObject({ kind: "permission", message: expect.stringContaining(`add ${EMAIL} as Content manager`) });
    const err = await driveFolderInfo(urls, sa, "nosuchfolder0001").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "permission", message: expect.stringContaining(EMAIL) });
    expect((err as Error).message).not.toContain("http");
  });

  it("uploads the exact bytes under the name and type given, even bytes that look like multipart framing", async () => {
    const { folderId } = await setup();
    const out = await driveUpload(urls, sa, folderId, { name: "REQ-7 scan.pdf", mimeType: "application/pdf", data: pdf });
    expect(out.id).toMatch(/^drivefile/);
    expect(savedIn(folderId)).toEqual([{ id: out.id, name: "REQ-7 scan.pdf", parent: folderId, mimeType: "application/pdf", size: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex") }]);
  });

  it("maps a 401 to one retry, quota to quota, 403 to permission, a 5xx on a write to ambiguous and the rest to invalid", async () => {
    const { folderId } = await setup();
    const file = { name: "a.png", mimeType: "image/png", data: png };
    fake.once("/upload/drive", { status: 401, body: { error: { message: "expired" } } });
    expect((await driveUpload(urls, sa, folderId, file)).id).toMatch(/^drivefile/);
    fake.once("/upload/drive", { status: 429, body: {}, headers: { "retry-after": "7" } });
    await expect(driveUpload(urls, sa, folderId, file)).rejects.toMatchObject({ kind: "quota", retryAfterMs: 7000 });
    fake.once("/upload/drive", { status: 403, body: { error: { message: "slow", errors: [{ reason: "userRateLimitExceeded" }] } } });
    await expect(driveUpload(urls, sa, folderId, file)).rejects.toMatchObject({ kind: "quota" });
    fake.once("/upload/drive", { status: 403, body: { error: { message: "no", errors: [{ reason: "forbidden" }] } } });
    await expect(driveUpload(urls, sa, folderId, file)).rejects.toMatchObject({ kind: "permission" });
    fake.once("/upload/drive", { status: 503, body: {} });
    await expect(driveUpload(urls, sa, folderId, file)).rejects.toMatchObject({ kind: "ambiguous" });
    fake.once("/upload/drive", { status: 400, body: { error: { message: "bad" } } });
    await expect(driveUpload(urls, sa, folderId, file)).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("Drive deliveries", () => {
  it("saves each file once under the request reference and reports the folder and the saved files", async () => {
    const s = await setup();
    const d = await s.queue();
    expect(d.pinnedDestination).toMatchObject({ folderId: s.folderId });
    await runDueDeliveries(db, key, urls);
    const done = await s.row(d.id);
    expect(done).toMatchObject({ state: "delivered", result: { folder: expect.stringMatching(/^Intake/), count: 2, saved: { [s.refs[0]!.id]: expect.any(String), [s.refs[1]!.id]: expect.any(String) } } });
    expect(savedIn(s.folderId).map((f) => [f.name, f.mimeType])).toEqual([
      ["REQ-7 front.png", "image/png"],
      ["REQ-7 scan.pdf", "application/pdf"],
    ]);
  });

  it("sends a delivery to review when the folder was changed after it was queued, and saves nothing", async () => {
    const s = await setup();
    const d = await s.queue();
    const other = await setup();
    await s.connect(other.folderId, "Another");
    await runDueDeliveries(db, key, urls);
    expect(await s.row(d.id)).toMatchObject({ state: "needs_review", errorKind: "destination_changed" });
    expect(savedIn(s.folderId)).toHaveLength(0);
    expect(savedIn(other.folderId)).toHaveLength(0);
  });

  it("goes to review on a 5xx after the first file was saved, and Post again saves only the second file", async () => {
    const s = await setup();
    const d = await s.queue();
    fake.once("/upload/drive", { status: 503, body: {} }, 1);
    await runDueDeliveries(db, key, urls);
    const held = await s.row(d.id);
    expect(held).toMatchObject({ state: "needs_review", errorKind: "ambiguous", lastError: expect.stringContaining("Google Drive may have saved it") });
    expect(held.result).toEqual({ saved: { [s.refs[0]!.id]: expect.any(String) } });
    expect(savedIn(s.folderId)).toHaveLength(1);
    expect(await retryDelivery(db, s.userId, d.id, { postAgain: true })).toBe(true);
    await runDueDeliveries(db, key, urls);
    expect(await s.row(d.id)).toMatchObject({ state: "delivered", result: { count: 2 } });
    expect(savedIn(s.folderId).map((f) => f.name)).toEqual(["REQ-7 front.png", "REQ-7 scan.pdf"]);
  });

  it("requeues on a quota answer and keeps the files already saved", async () => {
    const s = await setup();
    const d = await s.queue();
    fake.once("/upload/drive", { status: 429, body: {} }, 1);
    await runDueDeliveries(db, key, urls);
    expect(await s.row(d.id)).toMatchObject({ state: "queued", errorKind: "quota" });
    expect(savedIn(s.folderId)).toHaveLength(1);
    await db.update(deliveries).set({ nextAttemptAt: new Date() }).where(eq(deliveries.id, d.id));
    await runDueDeliveries(db, key, urls);
    expect(await s.row(d.id)).toMatchObject({ state: "delivered" });
    expect(savedIn(s.folderId)).toHaveLength(2);
  });

  it("fails with the shared drive message when the folder is not in a shared drive", async () => {
    const s = await setup(false);
    const d = await s.queue();
    await runDueDeliveries(db, key, urls);
    const row = await s.row(d.id);
    expect(row).toMatchObject({ state: "failed", errorKind: "permission" });
    expect(row.lastError).toContain("shared drive");
    expect(row.lastError).toContain(EMAIL);
  });

  it("fails when a file was purged, and says so by name", async () => {
    const s = await setup();
    await db.delete(uploads).where(eq(uploads.id, s.refs[1]!.id));
    const d = await s.queue();
    await runDueDeliveries(db, key, urls);
    expect(await s.row(d.id)).toMatchObject({ state: "failed", errorKind: "invalid", lastError: "The file scan.pdf was removed after 7 days, so it cannot be saved now." });
    expect(savedIn(s.folderId).map((f) => f.name)).toEqual(["REQ-7 front.png"]);
  });

  it("does not read a file of another run or another workspace", async () => {
    const mine = await setup();
    const theirs = await setup();
    // Their file ids named in my delivery: my workspace and run do not match, so nothing is read.
    const d = await mine.queue(theirs.refs);
    await runDueDeliveries(db, key, urls);
    expect(await mine.row(d.id)).toMatchObject({ state: "failed", lastError: expect.stringContaining("removed after 7 days") });
    // My own file ids named under another run of mine.
    const otherRun = await createRun(db, mine.versionId, {});
    const e = await queueDelivery(db, { userId: mine.userId, runId: otherRun, stepId: "drive", provider: "google_drive", reference: "REQ-8", payload: { files: mine.refs } });
    await runDueDeliveries(db, key, urls);
    expect(await mine.row(e.id)).toMatchObject({ state: "failed" });
    expect(savedIn(mine.folderId)).toHaveLength(0);
    expect(savedIn(theirs.folderId)).toHaveLength(0);
  });
});
