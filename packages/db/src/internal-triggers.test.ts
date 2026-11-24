import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { dispatchInternalTrigger, startSubWorkflow } from "./internal-triggers";
import type { Db } from "./index";
import { setPaused, WorkflowPausedError } from "./runs";
import { runs, triggers, users, workflows, workflowVersions } from "./schema";

let db: Db;
let pool: Pool;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);
afterAll(async () => {
  await pool?.end();
});

async function makeUser(prefix: string) {
  const [u] = await db.insert(users).values({ email: `${prefix}-${randomBytes(4).toString("hex")}@test.local`, passwordHash: "x" }).returning();
  return u!.id;
}

async function publishFlow(userId: string, slug: string, trigger: { type: string; config: Record<string, unknown> }, published = true) {
  const [wf] = await db.insert(workflows).values({ userId, name: slug, slug }).returning();
  const definition = { trigger, steps: [{ id: "wait", type: "delay", config: { seconds: 5 } }], edges: [] };
  const [ver] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published }).returning();
  if (published) {
    await db.insert(triggers).values({ workflowId: wf!.id, type: trigger.type, config: trigger.config });
  }
  return { workflowId: wf!.id, versionId: ver!.id };
}

describe("dispatchInternalTrigger (G1)", () => {
  it("dispatches keyed runs only to matching unpaused listeners in the same workspace and dedups replays", async () => {
    const owner = await makeUser("g1-a");
    const other = await makeUser("g1-b");

    const onCancel = await publishFlow(owner, "on-cancel", { type: "booking_event", config: { events: ["cancelled"] } });
    const onCreate = await publishFlow(owner, "on-create", { type: "booking_event", config: { events: ["created"] } });
    const paused = await publishFlow(owner, "paused-cancel", { type: "booking_event", config: { events: ["cancelled"] } });
    await setPaused(db, owner, paused.workflowId, true);
    const otherOwner = await publishFlow(other, "other-cancel", { type: "booking_event", config: { events: ["cancelled"] } });

    const payload = { event: "cancelled", bookingId: "b1", reference: "BK-100" };
    const first = await dispatchInternalTrigger(db, {
      workspaceId: owner,
      type: "booking_event",
      event: "cancelled",
      eventKey: "booking:b1:v2:cancelled",
      payload,
    });
    expect(first.runIds).toHaveLength(1);

    const replay = await dispatchInternalTrigger(db, {
      workspaceId: owner,
      type: "booking_event",
      event: "cancelled",
      eventKey: "booking:b1:v2:cancelled",
      payload,
    });
    expect(replay.runIds).toEqual([]);

    const createRuns = await db.select().from(runs).where(eq(runs.workflowVersionId, onCreate.versionId));
    const pausedRuns = await db.select().from(runs).where(eq(runs.workflowVersionId, paused.versionId));
    const otherRuns = await db.select().from(runs).where(eq(runs.workflowVersionId, otherOwner.versionId));
    const cancelRuns = await db.select().from(runs).where(eq(runs.workflowVersionId, onCancel.versionId));
    expect(cancelRuns).toHaveLength(1);
    expect(cancelRuns[0]!.triggerPayload).toEqual(payload);
    expect(createRuns).toEqual([]);
    expect(pausedRuns).toEqual([]);
    expect(otherRuns).toEqual([]);
  });

  it("dispatches payment_event listeners on confirmed and expired outcomes", async () => {
    const owner = await makeUser("g1-pay");
    const onExpired = await publishFlow(owner, "on-expired", { type: "payment_event", config: { events: ["expired"] } });

    const res = await dispatchInternalTrigger(db, {
      workspaceId: owner,
      type: "payment_event",
      event: "expired",
      eventKey: "payment_due:d1:expired",
      payload: { event: "expired", dueId: "d1", reference: "D-101", amountPesos: 350, status: "cancelled" },
    });
    expect(res.runIds).toHaveLength(1);
    const created = await db.select().from(runs).where(eq(runs.workflowVersionId, onExpired.versionId));
    expect(created).toHaveLength(1);
  });
});

describe("startSubWorkflow (G1)", () => {
  it("starts a child run, dedups on retry, validates required fields, and blocks cycles, depth >= 3, wrong trigger, paused, and cross-workspace targets", async () => {
    const owner = await makeUser("g1-sub");
    const stranger = await makeUser("g1-stranger");

    const child = await publishFlow(owner, "notify-child", {
      type: "sub_workflow",
      config: { fields: [{ name: "ref", label: "Reference", type: "text", required: true }] },
    });
    await publishFlow(owner, "manual-only", { type: "manual", config: {} });
    await publishFlow(stranger, "stranger-child", { type: "sub_workflow", config: {} });

    const first = await startSubWorkflow(db, {
      workspaceId: owner,
      workflowSlug: "notify-child",
      eventKey: "sub:parent-1:step_1",
      payload: { ref: "BK-9" },
      callChain: ["parent-wf"],
    });
    expect(first).toEqual({ runId: expect.any(String), duplicate: false, workflowId: child.workflowId, workflowSlug: "notify-child" });
    const [childRun] = await db.select().from(runs).where(eq(runs.id, first.runId));
    expect(childRun!.triggerPayload).toEqual({ ref: "BK-9", _callChain: ["parent-wf", child.workflowId] });

    const retry = await startSubWorkflow(db, {
      workspaceId: owner,
      workflowSlug: "notify-child",
      eventKey: "sub:parent-1:step_1",
      payload: { ref: "BK-9" },
      callChain: ["parent-wf"],
    });
    expect(retry).toEqual({ runId: first.runId, duplicate: true, workflowId: child.workflowId, workflowSlug: "notify-child" });

    await expect(
      startSubWorkflow(db, { workspaceId: owner, workflowSlug: "notify-child", eventKey: "sub:bad-fields", payload: {}, callChain: [] }),
    ).rejects.toThrow(/Invalid inputs/);

    await expect(
      startSubWorkflow(db, { workspaceId: owner, workflowSlug: "notify-child", eventKey: "sub:cycle", payload: { ref: "x" }, callChain: ["p1", child.workflowId] }),
    ).rejects.toThrow(/create a loop/);

    await expect(
      startSubWorkflow(db, { workspaceId: owner, workflowSlug: "notify-child", eventKey: "sub:deep", payload: { ref: "x" }, callChain: ["a", "b", "c"] }),
    ).rejects.toThrow(/depth limit/);

    await expect(
      startSubWorkflow(db, { workspaceId: owner, workflowSlug: "manual-only", eventKey: "sub:wrong", payload: {}, callChain: [] }),
    ).rejects.toThrow(/Called by another automation/);

    await expect(
      startSubWorkflow(db, { workspaceId: owner, workflowSlug: "stranger-child", eventKey: "sub:cross", payload: {}, callChain: [] }),
    ).rejects.toThrow(/No automation with slug/);

    await setPaused(db, owner, child.workflowId, true);
    await expect(
      startSubWorkflow(db, { workspaceId: owner, workflowSlug: "notify-child", eventKey: "sub:paused", payload: { ref: "x" }, callChain: [] }),
    ).rejects.toBeInstanceOf(WorkflowPausedError);
  });
});
