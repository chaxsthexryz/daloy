import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createKeyedRun, createRun, setPaused, WorkflowPausedError } from "./runs";
import { runKeys, runs, users, workflows, workflowVersions } from "./schema";
import type { Db } from "./index";

let db: Db;
let pool: Pool;
let seq = 0;

beforeAll(async () => ({ db, pool } = await freshDatabase()), 120_000);
afterAll(() => pool?.end());

async function setup() {
  const [u] = await db.insert(users).values({ email: `p${++seq}@test.local`, passwordHash: "x" }).returning();
  const [w] = await db.insert(workflows).values({ userId: u!.id, name: "W", slug: `w${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: w!.id, version: 1, definition: {}, published: true }).returning();
  return { userId: u!.id, workflowId: w!.id, versionId: v!.id };
}
const runCount = async (versionId: string) => (await db.select().from(runs).where(eq(runs.workflowVersionId, versionId))).length;
const row = async (id: string) => (await db.select().from(workflows).where(eq(workflows.id, id)))[0]!;

describe("pause (N11b)", () => {
  it("starts no run of a paused workflow, keyed or not, and leaves nothing behind", async () => {
    const a = await setup();
    expect(await setPaused(db, a.userId, a.workflowId, true)).toBe(true);
    await expect(createRun(db, a.versionId, {})).rejects.toBeInstanceOf(WorkflowPausedError);
    await expect(createKeyedRun(db, a.workflowId, a.versionId, {}, "k1")).rejects.toBeInstanceOf(WorkflowPausedError);
    await expect(createKeyedRun(db, a.workflowId, a.versionId, {}, undefined)).rejects.toBeInstanceOf(WorkflowPausedError);
    expect(await runCount(a.versionId)).toBe(0);
    expect(await db.select().from(runKeys).where(eq(runKeys.workflowId, a.workflowId))).toEqual([]);
  });

  it("still allows a builder test run, and runs of other workflows", async () => {
    const a = await setup();
    const b = await setup();
    await setPaused(db, a.userId, a.workflowId, true);
    await createRun(db, a.versionId, {}, { test: true });
    await createRun(db, b.versionId, {});
    expect(await runCount(a.versionId)).toBe(1);
    expect(await runCount(b.versionId)).toBe(1);
  });

  it("resumes: runs start again, the key is free again and resumedAt is set", async () => {
    const a = await setup();
    await setPaused(db, a.userId, a.workflowId, true);
    expect((await row(a.workflowId)).pausedAt).toBeInstanceOf(Date);
    expect((await row(a.workflowId)).resumedAt).toBeNull();
    await setPaused(db, a.userId, a.workflowId, false);
    const after = await row(a.workflowId);
    expect(after.pausedAt).toBeNull();
    expect(after.resumedAt).toBeInstanceOf(Date);
    const first = await createKeyedRun(db, a.workflowId, a.versionId, {}, "k1");
    expect(first.duplicate).toBeUndefined();
  });

  it("is repeatable: pausing twice keeps the first time, resuming a running workflow changes nothing", async () => {
    const a = await setup();
    await setPaused(db, a.userId, a.workflowId, false);
    expect((await row(a.workflowId)).resumedAt).toBeNull();
    await setPaused(db, a.userId, a.workflowId, true);
    const first = (await row(a.workflowId)).pausedAt;
    await new Promise((r) => setTimeout(r, 10));
    expect(await setPaused(db, a.userId, a.workflowId, true)).toBe(true);
    expect((await row(a.workflowId)).pausedAt).toEqual(first);
  });

  it("answers false for another workspace or an unknown workflow, and changes nothing", async () => {
    const a = await setup();
    const b = await setup();
    expect(await setPaused(db, b.userId, a.workflowId, true)).toBe(false);
    expect(await setPaused(db, a.userId, "00000000-0000-4000-8000-000000000000", true)).toBe(false);
    expect((await row(a.workflowId)).pausedAt).toBeNull();
  });

  it("holds against a pause that races run creation: every run is either before the pause or refused", async () => {
    const a = await setup();
    const attempts = Array.from({ length: 20 }, () => createRun(db, a.versionId, {}).then(() => "ok", (e: unknown) => (e instanceof WorkflowPausedError ? "paused" : "error")));
    const pausing = setPaused(db, a.userId, a.workflowId, true);
    const results = await Promise.all([...attempts, pausing]);
    expect(results.filter((r) => r === "error")).toEqual([]);
    // Whatever got through did so before the pause committed: afterwards nothing starts.
    const before = await runCount(a.versionId);
    await expect(createRun(db, a.versionId, {})).rejects.toBeInstanceOf(WorkflowPausedError);
    expect(await runCount(a.versionId)).toBe(before);
  });
});
