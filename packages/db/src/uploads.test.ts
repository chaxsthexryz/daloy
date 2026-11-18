import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createKeyedRun, createRun } from "./runs";
import { uploads, users, workflows, workflowVersions } from "./schema";
import { purgeUploads, readUpload, saveUploads, UPLOAD_RETENTION_MS } from "./uploads";
import type { Db } from "./index";

let db: Db;
let pool: Pool;
let seq = 0;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

beforeAll(async () => ({ db, pool } = await freshDatabase()), 120_000);
afterAll(() => pool?.end());

async function setup() {
  const [u] = await db.insert(users).values({ email: `up${++seq}@test.local`, passwordHash: "x" }).returning();
  const [w] = await db.insert(workflows).values({ userId: u!.id, name: "W", slug: `w${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: w!.id, version: 1, definition: {}, published: true }).returning();
  return { userId: u!.id, workflowId: w!.id, versionId: v!.id };
}
const file = (field = "photo", name = "a.png") => ({ id: newId(), field, name, type: "png" as const, data: png });

describe("uploads", () => {
  it("saves files and reads one only with workspace, run and id all matching", async () => {
    const a = await setup();
    const b = await setup();
    const runId = await createRun(db, a.versionId, {});
    const f = file();
    await saveUploads(db, { userId: a.userId, runId, files: [f] });
    expect(await readUpload(db, { userId: a.userId, runId, id: f.id })).toMatchObject({ name: "a.png", type: "png", size: 4 });
    expect((await readUpload(db, { userId: a.userId, runId, id: f.id }))?.data.equals(png)).toBe(true);
    expect(await readUpload(db, { userId: b.userId, runId, id: f.id })).toBeNull();
    expect(await readUpload(db, { userId: a.userId, runId: newId(), id: f.id })).toBeNull();
    expect(await readUpload(db, { userId: a.userId, runId, id: newId() })).toBeNull();
  });

  it("refuses an empty or oversized file in the database itself", async () => {
    const a = await setup();
    const runId = await createRun(db, a.versionId, {});
    await expect(saveUploads(db, { userId: a.userId, runId, files: [{ ...file(), data: Buffer.alloc(0) }] })).rejects.toThrow();
    await expect(saveUploads(db, { userId: a.userId, runId, files: [{ ...file(), data: Buffer.alloc(5 * 1024 * 1024 + 1) }] })).rejects.toThrow();
  });

  it("goes with its run", async () => {
    const a = await setup();
    const runId = await createRun(db, a.versionId, {}, { uploads: { userId: a.userId, files: [file()] } });
    expect(await db.select().from(uploads).where(eq(uploads.runId, runId))).toHaveLength(1);
  });

  it("commits the run and its files together, with or without a key", async () => {
    const a = await setup();
    const one = await createRun(db, a.versionId, {}, { uploads: { userId: a.userId, files: [file(), file("extra", "b.png")] } });
    expect(await db.select().from(uploads).where(eq(uploads.runId, one))).toHaveLength(2);
    const { runId } = await createKeyedRun(db, a.workflowId, a.versionId, {}, "k1", { uploads: { userId: a.userId, files: [file()] } });
    expect(await db.select().from(uploads).where(eq(uploads.runId, runId))).toHaveLength(1);
  });

  it("stores no files for a replayed key", async () => {
    const a = await setup();
    const first = await createKeyedRun(db, a.workflowId, a.versionId, {}, "same", { uploads: { userId: a.userId, files: [file()] } });
    const again = await createKeyedRun(db, a.workflowId, a.versionId, {}, "same", { uploads: { userId: a.userId, files: [file(), file()] } });
    expect(again).toEqual({ runId: first.runId, duplicate: true });
    expect(await db.select().from(uploads).where(eq(uploads.userId, a.userId))).toHaveLength(1);
  });

  it("leaves no run behind when the files cannot be stored", async () => {
    const a = await setup();
    const bad = { ...file(), data: Buffer.alloc(0) };
    await expect(createRun(db, a.versionId, {}, { uploads: { userId: a.userId, files: [bad] } })).rejects.toThrow();
    const rows = await pool.query("select count(*)::int as n from runs where workflow_version_id = $1", [a.versionId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("purges the oldest expired files, a batch at a time", async () => {
    const a = await setup();
    const runId = await createRun(db, a.versionId, {});
    const files = [file(), file(), file()];
    await saveUploads(db, { userId: a.userId, runId, files });
    const old = new Date(Date.now() - UPLOAD_RETENTION_MS - 60_000);
    await db.update(uploads).set({ createdAt: old }).where(eq(uploads.id, files[0]!.id));
    await db.update(uploads).set({ createdAt: new Date(old.getTime() - 1000) }).where(eq(uploads.id, files[1]!.id));
    expect(await purgeUploads(db, UPLOAD_RETENTION_MS, 1)).toBe(1);
    expect(await readUpload(db, { userId: a.userId, runId, id: files[1]!.id })).toBeNull();
    expect(await readUpload(db, { userId: a.userId, runId, id: files[0]!.id })).not.toBeNull();
    expect(await purgeUploads(db)).toBe(1);
    expect(await purgeUploads(db)).toBe(0);
    expect(await readUpload(db, { userId: a.userId, runId, id: files[2]!.id })).not.toBeNull();
  });
});
