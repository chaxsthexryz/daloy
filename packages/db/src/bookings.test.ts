import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { bookFromStep, bookingSuperseded, confirmStay, listBookings, staffChange, type StepAction } from "./bookings";
import type { Db } from "./index";
import { createDue, decideClaim, submitTransferClaim } from "./payment-review";
import { insertPayment } from "./paymongo";
import { bookingChanges, bookings, conversations, paymentDues, paymentHistory, payments, resources, runs, users, workflows, workflowVersions } from "./schema";

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

describe("stays (C5)", () => {
  const manila = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);
  const stayCreate = (resourceId: string, checkIn: string, checkOut: string, nights: number, conversationId?: string): StepAction => ({
    action: "create",
    resourceId,
    start: manila(checkIn, "14:00"),
    end: manila(checkOut, "12:00"),
    nights,
    timezone: "Asia/Manila",
    ...(conversationId ? { conversationId } : {}),
  });

  it("refuses overlap across nights, allows same-day checkout-to-checkin turnaround, and keeps nights on reschedule", async () => {
    const w = await workspace();
    const room1 = (await db.insert(resources).values({ userId: w.id, name: "Villa 1", label: "Beach Villa" }).returning())[0]!.id;
    const room2 = (await db.insert(resources).values({ userId: w.id, name: "Villa 2", label: "Beach Villa" }).returning())[0]!.id;

    // 3-night stay: May 1 14:00 to May 4 12:00
    const first = await w.step(stayCreate(room1, "2031-05-01", "2031-05-04", 3));
    expect(first.branch).toBe("done");
    expect(first.output).toMatchObject({
      resource: { id: room1, name: "Villa 1", label: "Beach Villa" },
      start: "2031-05-01T14:00:00+08:00",
      end: "2031-05-04T12:00:00+08:00",
      nights: 3,
      checkIn: "2031-05-01",
      checkOut: "2031-05-04",
      timezone: "Asia/Manila",
    });

    // Overlapping nights on same room are refused:
    expect((await w.step(stayCreate(room1, "2031-05-03", "2031-05-05", 2))).branch).toBe("taken");
    expect((await w.step(stayCreate(room1, "2031-05-02", "2031-05-03", 1))).branch).toBe("taken");
    expect((await w.step(stayCreate(room1, "2031-04-30", "2031-05-02", 2))).branch).toBe("taken");

    // Same-day turnaround (checkout May 4 12:00 < checkin May 4 14:00) and other room unit both succeed:
    expect((await w.step(stayCreate(room1, "2031-05-04", "2031-05-06", 2))).branch).toBe("done");
    expect((await w.step(stayCreate(room2, "2031-05-01", "2031-05-04", 3))).branch).toBe("done");

    // Block May 12-14 on room1; rescheduling the 3-night stay to May 10 (May 10-13) collides on night 3 -> taken!
    expect((await w.step(stayCreate(room1, "2031-05-12", "2031-05-14", 2))).branch).toBe("done");
    const ref = String(first.output.reference);
    expect((await w.step({ action: "reschedule", reference: ref, checkIn: "2031-05-10" })).branch).toBe("taken");
    expect((await rowOf(ref)).version).toBe(1);

    // Moving the 3-night stay to May 15 succeeds and keeps all 3 nights (May 15 14:00 -> May 18 12:00).
    const moved = await w.step({ action: "reschedule", reference: ref, checkIn: "2031-05-15" });
    expect(moved).toMatchObject({
      branch: "done",
      output: {
        start: "2031-05-15T14:00:00+08:00",
        end: "2031-05-18T12:00:00+08:00",
        nights: 3,
        checkIn: "2031-05-15",
        checkOut: "2031-05-18",
        version: 2,
      },
    });
  });

  it("confirmStay links a conversation for guest contact, rejects foreign conversations, and deduplicates by idempotencyKey", async () => {
    const w = await workspace();
    const other = await workspace();
    const room = (await db.insert(resources).values({ userId: w.id, name: "Garden 1", label: "Garden Room" }).returning())[0]!.id;
    const [convo] = await db
      .insert(conversations)
      .values({ userId: w.id, channel: "messenger", externalId: "psid-guest-1", fields: { name: "Lia Santos", phone: "+639171112222", email: "lia@example.com" } })
      .returning();
    const [foreignConvo] = await db.insert(conversations).values({ userId: other.id, channel: "email", externalId: "other@example.com" }).returning();

    // Foreign conversation refused
    expect(
      await confirmStay(
        db,
        { workspaceId: w.id, resourceId: room, start: manila("2031-06-01", "14:00"), end: manila("2031-06-03", "12:00"), nights: 2, timezone: "Asia/Manila", conversationId: foreignConvo!.id },
        "user:staff",
      ),
    ).toEqual({ result: "conversation_not_found" });

    // Confirm stay with idempotency key (concurrent double-click gives one done + duplicates)
    const req = {
      workspaceId: w.id,
      resourceId: room,
      start: manila("2031-06-01", "14:00"),
      end: manila("2031-06-03", "12:00"),
      nights: 2,
      timezone: "Asia/Manila",
      conversationId: convo!.id,
      idempotencyKey: "stay-confirm-1",
    };
    const [a, b] = await Promise.all([confirmStay(db, req, "user:staff"), confirmStay(db, req, "user:staff")]);
    expect([a.result, b.result].sort()).toEqual(["done", "duplicate"]);
    expect(a.booking!.id).toBe(b.booking!.id);
    expect(a.booking).toMatchObject({
      nights: 2,
      checkIn: "2031-06-01",
      checkOut: "2031-06-03",
      conversationId: convo!.id,
      guest: { channel: "messenger", externalId: "psid-guest-1", name: "Lia Santos", phone: "+639171112222", email: "lia@example.com" },
      resource: { id: room, name: "Garden 1", label: "Garden Room" },
    });

    // Overlapping confirmStay refused as taken
    const clash = await confirmStay(
      db,
      { workspaceId: w.id, resourceId: room, start: manila("2031-06-02", "14:00"), end: manila("2031-06-04", "12:00"), nights: 2, timezone: "Asia/Manila" },
      "user:staff",
    );
    expect(clash.result).toBe("taken");

    // Listed bookings expose guest contact & stay metadata
    const listed = await listBookings(db, w.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: a.booking!.id,
      nights: 2,
      conversationId: convo!.id,
      guest: { name: "Lia Santos", phone: "+639171112222", email: "lia@example.com" },
    });

    // Staff reschedule without workflow keeps 2 nights
    const moved = await staffChange(
      db,
      { workspaceId: w.id, bookingId: a.booking!.id, version: 1, action: "reschedule", start: manila("2031-06-10", "14:00"), end: manila("2031-06-12", "12:00") },
      "user:staff",
    );
    expect(moved).toMatchObject({
      result: "done",
      booking: { version: 2, start: "2031-06-10T14:00:00+08:00", end: "2031-06-12T12:00:00+08:00", nights: 2, checkIn: "2031-06-10", checkOut: "2031-06-12" },
    });
  });

  it("cancelling a booking via staff or step also cancels pending payment_dues, clears open_due_id, and expires open checkouts while keeping confirmed dues (S3)", async () => {
    const w = await workspace();
    const ana = await w.resource("Ana");

    // 1. Staff cancel cancels pending due linked to booking + expires checkout + clears conversation openDueId, keeps confirmed due.
    const [convo] = await db.insert(conversations).values({ userId: w.id, channel: "messenger", externalId: "psid-s3-staff" }).returning();
    const first = await w.step(create(ana, hour(14)));
    const booking1 = await rowOf(String(first.output.reference));
    const pendingDue = await createDue(db, {
      userId: w.id,
      test: false,
      workflowId: w.workflowId,
      runId: first.runId,
      stepId: "ask_dep",
      reference: booking1.reference,
      kind: "deposit",
      amountCentavos: 35000,
      bookingId: booking1.id,
      conversationId: convo!.id,
    });
    const openCheckout = await insertPayment(db, {
      userId: w.id,
      workflowId: w.workflowId,
      runId: first.runId,
      stepId: "ask_dep",
      reference: booking1.reference,
      amountCentavos: 35000,
      livemode: false,
      providerSessionId: `cs_s3_staff_${randomBytes(4).toString("hex")}`,
      url: "https://pm.test/s3-staff",
      dueId: pendingDue.id,
    });
    const confirmedDue = await createDue(db, {
      userId: w.id,
      test: false,
      workflowId: w.workflowId,
      runId: await w.run(),
      stepId: "ask_bal",
      reference: `${booking1.reference}-BAL`,
      kind: "balance",
      amountCentavos: 50000,
      bookingId: booking1.id,
    });
    const claim = (await submitTransferClaim(db, confirmedDue.token, { transferRef: `S3CONF${randomBytes(3).toString("hex")}` }))!;
    await decideClaim(db, { workspaceId: w.id, actor: { id: w.id, role: "owner" }, claimId: claim.id, version: 1, decision: "confirm" });

    expect((await staffChange(db, { workspaceId: w.id, bookingId: booking1.id, version: booking1.version, action: "cancel" }, `user:${w.id}`)).result).toBe("done");

    const [dueAfterStaff] = await db.select().from(paymentDues).where(eq(paymentDues.id, pendingDue.id));
    expect(dueAfterStaff!.status).toBe("cancelled");
    const [payAfterStaff] = await db.select().from(payments).where(eq(payments.id, openCheckout.id));
    expect(payAfterStaff!.status).toBe("expired");
    const [convoAfterStaff] = await db.select().from(conversations).where(eq(conversations.id, convo!.id));
    expect(convoAfterStaff!.openDueId).toBeNull();
    const [confAfterStaff] = await db.select().from(paymentDues).where(eq(paymentDues.id, confirmedDue.id));
    expect(confAfterStaff!.status).toBe("confirmed");
    const staffHist = await db.select().from(paymentHistory).where(eq(paymentHistory.dueId, pendingDue.id));
    expect(staffHist.some((h) => h.event === "cancelled")).toBe(true);

    // 2. Step cancel cancels pending due linked to booking.
    const [convo2] = await db.insert(conversations).values({ userId: w.id, channel: "messenger", externalId: "psid-s3-step" }).returning();
    const second = await w.step(create(ana, hour(16)));
    const booking2 = await rowOf(String(second.output.reference));
    const stepDue = await createDue(db, {
      userId: w.id,
      test: false,
      workflowId: w.workflowId,
      runId: second.runId,
      stepId: "ask_dep2",
      reference: booking2.reference,
      kind: "deposit",
      amountCentavos: 35000,
      bookingId: booking2.id,
      conversationId: convo2!.id,
    });
    const cancelledByStep = await w.step({ action: "cancel", reference: booking2.reference });
    expect(cancelledByStep.branch).toBe("done");
    const [dueAfterStep] = await db.select().from(paymentDues).where(eq(paymentDues.id, stepDue.id));
    expect(dueAfterStep!.status).toBe("cancelled");
    const [convoAfterStep] = await db.select().from(conversations).where(eq(conversations.id, convo2!.id));
    expect(convoAfterStep!.openDueId).toBeNull();
  });
});
