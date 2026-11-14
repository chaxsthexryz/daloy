import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { bookFromStep, bookingSuperseded, listBookings, staffChange, type StepAction } from "./bookings";
import type { Db } from "./index";
import { bookingChanges, bookings, resources, runs, users, workflows, workflowVersions } from "./schema";

// Decision 0032: the exclusion constraint decides every conflict, a step's result is stored with its change, and a
// staff change is logged per version so a repeat finds it.
let db: Db;
let pool: Pool;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);
afterAll(async () => {
  await pool?.end();
});

async function workspace() {
  const [u] = await db.insert(users).values({ email: `b${randomBytes(4).toString("hex")}@test.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Spa", slug: `spa-${randomBytes(4).toString("hex")}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const resource = async (name: string, active = true) => (await db.insert(resources).values({ userId: u!.id, name, active }).returning())[0]!.id;
  const run = async (test = false) => (await db.insert(runs).values({ workflowVersionId: v!.id, test }).returning())[0]!.id;
  const step = async (a: StepAction, { test = false, runId, stepId = "book" }: { test?: boolean; runId?: string; stepId?: string } = {}) => {
    const id = runId ?? (await run(test));
    return { runId: id, ...(await bookFromStep(db, { workspaceId: u!.id, test, runId: id, stepId, workflowId: wf!.id }, a)) };
  };
  return { id: u!.id, workflowId: wf!.id, resource, run, step };
}

const hour = (h: number, m = 0) => new Date(Date.UTC(2031, 0, 20, h, m));
const create = (resourceId: string, start: Date, minutes = 60): StepAction => ({ action: "create", resourceId, start, minutes, timezone: "Asia/Manila" });
const rowOf = async (reference: string) => (await db.select().from(bookings).where(eq(bookings.reference, reference)))[0]!;

describe("booking step: create", () => {
  it("books a free slot, stores the times in the field's zone, and links the run", async () => {
    const w = await workspace();
    const ana = await w.resource("Ana");
    const r = await w.step(create(ana, hour(6)));
    expect(r.branch).toBe("done");
    expect(r.output).toMatchObject({ resource: { id: ana, name: "Ana" }, start: "2031-01-20T14:00:00+08:00", end: "2031-01-20T15:00:00+08:00", minutes: 60, status: "active", version: 1, timezone: "Asia/Manila" });
    expect(String(r.output.reference)).toMatch(/^BK-[0-9A-HJKMNP-TV-Z]{6}$/);
    const [run] = await db.select().from(runs).where(eq(runs.id, r.runId));
    expect(run).toMatchObject({ bookingVersion: 1 });
    expect((await rowOf(String(r.output.reference))).runId).toBe(r.runId);
  });

  it("refuses an overlap as taken, allows back-to-back slots, and frees a cancelled slot", async () => {
    const w = await workspace();
    const ana = await w.resource("Ana");
    const first = await w.step(create(ana, hour(6)));
    expect((await w.step(create(ana, hour(6, 30)))).branch).toBe("taken");
    expect((await w.step(create(ana, hour(5, 30)))).branch).toBe("taken");
    expect((await w.step(create(ana, hour(7)))).branch).toBe("done");
    expect((await w.step(create(ana, hour(5)))).branch).toBe("done");
    expect((await w.step({ action: "cancel", reference: String(first.output.reference) })).branch).toBe("done");
    expect((await w.step(create(ana, hour(6)))).branch).toBe("done");
  });

  it("never lets test and live, other resources or other workspaces collide", async () => {
    const w = await workspace();
    const other = await workspace();
    const ana = await w.resource("Ana");
    const ben = await w.resource("Ben");
    expect((await w.step(create(ana, hour(6)))).branch).toBe("done");
    const test = await w.step(create(ana, hour(6)), { test: true });
    expect(test.branch).toBe("done");
    expect(String(test.output.reference)).toMatch(/^TEST-/);
    expect((await w.step(create(ben, hour(6)))).branch).toBe("done");
    expect((await other.step(create(await other.resource("Ana"), hour(6)))).branch).toBe("done");
  });

  it("finds no resource from another workspace, an archived one, or a time in the past", async () => {
    const w = await workspace();
    const other = await workspace();
    const foreign = await other.resource("Zed");
    const old = await w.resource("Old", false);
    expect(await w.step(create(foreign, hour(6)))).toMatchObject({ branch: "not_found", output: { reason: "There is no active resource with that id in this workspace." } });
    expect((await w.step(create(old, hour(6)))).branch).toBe("not_found");
    await expect(w.step(create(await w.resource("Ana"), new Date(Date.now() - 60_000)))).rejects.toThrow("The booking time has passed");
  });

  it("returns the stored result on a retry or takeover instead of booking again", async () => {
    const w = await workspace();
    const ana = await w.resource("Ana");
    const first = await w.step(create(ana, hour(6)));
    const again = await w.step(create(ana, hour(6)), { runId: first.runId });
    expect(again).toEqual(first);
    expect(await db.select().from(bookings).where(eq(bookings.resourceId, ana))).toHaveLength(1);
  });

  it("gives exactly one of ten concurrent bookings for one slot", async () => {
    const w = await workspace();
    const ana = await w.resource("Ana");
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => w.step(create(ana, hour(6, i * 5), 60))));
    expect(all.filter((r) => r.branch === "done")).toHaveLength(1);
    expect(all.filter((r) => r.branch === "taken")).toHaveLength(9);
  });
});

describe("booking step: reschedule and cancel", () => {
  it("moves a booking, keeps its length, and raises its version", async () => {
    const w = await workspace();
    const ana = await w.resource("Ana");
    const made = await w.step(create(ana, hour(6), 90));
    const moved = await w.step({ action: "reschedule", reference: String(made.output.reference), start: hour(9) });
    expect(moved).toMatchObject({ branch: "done", output: { start: "2031-01-20T17:00:00+08:00", end: "2031-01-20T18:30:00+08:00", version: 2 } });
    expect(await bookingSuperseded(db, { bookingId: (await rowOf(String(made.output.reference))).id, bookingVersion: 1 })).toBe(true);
    const [runRow] = await db.select().from(runs).where(eq(runs.id, moved.runId));
    expect(runRow!.bookingVersion).toBe(2);
  });

  it("answers taken when the new time overlaps, and not_found for an unknown, cancelled or other-scope booking", async () => {
    const w = await workspace();
    const ana = await w.resource("Ana");
    const a = await w.step(create(ana, hour(6)));
    await w.step(create(ana, hour(8)));
    const ref = String(a.output.reference);
    expect((await w.step({ action: "reschedule", reference: ref, start: hour(8, 30) })).branch).toBe("taken");
    expect((await rowOf(ref)).version).toBe(1);
    expect((await w.step({ action: "reschedule", reference: ref, start: hour(9) }, { test: true })).branch).toBe("not_found");
    expect((await w.step({ action: "cancel", reference: "BK-NOPE00" })).branch).toBe("not_found");
    expect((await w.step({ action: "cancel", reference: ref })).branch).toBe("done");
    expect((await w.step({ action: "cancel", reference: ref })).branch).toBe("not_found");
  });
});

describe("staff changes", () => {
  async function booked() {
    const w = await workspace();
    const ana = await w.resource("Ana");
    const made = await w.step(create(ana, hour(6)));
    const row = await rowOf(String(made.output.reference));
    let runs = 0;
    const newRun = async () => {
      runs++;
      return w.run();
    };
    return { w, ana, row, made, newRuns: () => runs, newRun };
  }

  it("reschedules once for a repeated request, also with the same time written another way", async () => {
    const { w, row, newRun, newRuns } = await booked();
    const first = await staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 1, action: "reschedule", start: hour(9), newRun }, "user:a");
    expect(first).toMatchObject({ result: "done", booking: { version: 2, start: "2031-01-20T17:00:00+08:00" } });
    const repeat = await staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 1, action: "reschedule", start: new Date("2031-01-20T17:00:00+08:00"), newRun }, "user:a");
    expect(repeat).toMatchObject({ result: "duplicate", runId: first.runId, booking: { version: 2 } });
    expect(newRuns()).toBe(1);
    expect(await db.select().from(bookingChanges).where(eq(bookingChanges.bookingId, row.id))).toHaveLength(2);
  });

  it("refuses a different change from the same version, a stale version and a taken time", async () => {
    const { w, ana, row, newRun } = await booked();
    await w.step(create(ana, hour(10)));
    expect((await staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 1, action: "reschedule", start: hour(10, 30), newRun }, "user:a")).result).toBe("taken");
    expect((await rowOf(row.reference)).version).toBe(1);
    expect((await staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 1, action: "reschedule", start: hour(9), newRun }, "user:a")).result).toBe("done");
    expect((await staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 1, action: "cancel" }, "user:b")).result).toBe("conflict");
    expect((await staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 1, action: "reschedule", start: hour(11), newRun }, "user:b")).result).toBe("conflict");
    expect((await staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 5, action: "cancel" }, "user:b")).result).toBe("conflict");
  });

  it("gives one change and one run for identical concurrent requests, and one winner for different ones", async () => {
    const { w, row, newRun, newRuns } = await booked();
    const same = await Promise.all(Array.from({ length: 6 }, () => staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 1, action: "reschedule", start: hour(9), newRun }, "user:a")));
    expect(same.map((r) => r.result).sort()).toEqual(["done", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate"]);
    expect(new Set(same.map((r) => r.runId)).size).toBe(1);
    expect(newRuns()).toBe(1);
    const mixed = await Promise.all([10, 11, 12].map((h) => staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 2, action: "reschedule", start: hour(h), newRun }, "user:a")));
    expect(mixed.map((r) => r.result).sort()).toEqual(["conflict", "conflict", "done"]);
    expect((await rowOf(row.reference)).version).toBe(3);
  });

  it("cancels once, never touches test bookings or other workspaces, and lists live bookings only", async () => {
    const { w, ana, row } = await booked();
    const other = await workspace();
    const test = await w.step(create(ana, hour(6)), { test: true });
    const testRow = await rowOf(String(test.output.reference));
    expect((await staffChange(db, { workspaceId: other.id, bookingId: row.id, version: 1, action: "cancel" }, "user:x")).result).toBe("not_found");
    expect((await staffChange(db, { workspaceId: w.id, bookingId: testRow.id, version: 1, action: "cancel" }, "user:a")).result).toBe("not_found");
    expect((await staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 1, action: "cancel" }, "user:a")).result).toBe("done");
    expect((await staffChange(db, { workspaceId: w.id, bookingId: row.id, version: 1, action: "cancel" }, "user:a")).result).toBe("duplicate");
    const list = await listBookings(db, w.id);
    expect(list.map((b) => [b.reference, b.status, b.version])).toEqual([[row.reference, "cancelled", 2]]);
    expect(await listBookings(db, other.id)).toEqual([]);
  });
});
