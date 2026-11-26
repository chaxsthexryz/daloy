import { randomBytes } from "node:crypto";
import {
  approvals,
  conversationMessages,
  conversations,
  createApproval,
  paymentClaims,
  paymentDues,
  runs,
  stepRuns,
  users,
  workflowVersions,
  workflows,
  type Db,
} from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import type { InboxPayload } from "./inbox";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let seq = 0;
const secretsKey = randomBytes(32);

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey, secureCookies: false });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

async function createOwner() {
  const email = `inbox${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id, email };
}

async function addMember(ownerAgent: ReturnType<typeof request.agent>, role: "operator" | "approver" | "requester") {
  const email = `${role}-${++seq}@test.local`;
  const created = await ownerAgent.post("/workspace/invites").send({ email, role }).expect(201);
  const token = String(created.body.link).split("/invite/")[1]!;
  const agent = request.agent(server);
  await agent.post(`/auth/invites/${token}/accept`).send({ password: "correct horse battery" }).expect(200);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id, email };
}

describe("unified inbox API (G4)", () => {
  it("aggregates conversations, receipt claims, masked approvals and needs_review runs", async () => {
    const owner = await createOwner();
    await owner.agent.put("/secrets/lalamove_api_key").send({ value: "super-secret-value-123" }).expect(204);

    // 1. Staff conversation waiting on a person
    const [conv] = await db
      .insert(conversations)
      .values({
        userId: owner.userId,
        channel: "messenger",
        externalId: "psid-123",
        status: "staff",
        staffUntil: new Date(Date.now() + 3600_000),
        lastInboundAt: new Date(Date.now() - 40_000),
        fields: { name: "Ana Reyes" },
      })
      .returning();
    await db.insert(conversationMessages).values({
      conversationId: conv!.id,
      direction: "in",
      text: "Can we request early check-in?",
    });

    // 2. Open receipt claim on a payment due
    const [wf] = await db.insert(workflows).values({ userId: owner.userId, name: "Resort flow", slug: `resort-${seq}` }).returning();
    const [ver] = await db
      .insert(workflowVersions)
      .values({ workflowId: wf!.id, version: 1, published: true, definition: { trigger: { type: "manual", config: {} }, steps: [], edges: [] } })
      .returning();
    const [dueRun] = await db.insert(runs).values({ workflowVersionId: ver!.id, state: "waiting", test: false }).returning();
    const [due] = await db
      .insert(paymentDues)
      .values({
        userId: owner.userId,
        runId: dueRun!.id,
        stepId: "pay",
        reference: "RES-101",
        kind: "deposit",
        amountCentavos: 250_000,
        status: "pending",
        token: randomBytes(16).toString("hex"),
        test: false,
      })
      .returning();
    await db.insert(paymentClaims).values({
      userId: owner.userId,
      dueId: due!.id,
      submittedCentavos: 250_000,
      transferRef: "GCASH-9988",
      channel: "transfer",
      status: "open",
      flags: [],
      createdAt: new Date(Date.now() - 30_000),
    });

    // 3. Pending approval with a leaked secret string that must be masked
    const [appRun] = await db
      .insert(runs)
      .values({ workflowVersionId: ver!.id, state: "waiting", test: false, createdAt: new Date(Date.now() - 20_000) })
      .returning();
    const [appStep] = await db
      .insert(stepRuns)
      .values({
        runId: appRun!.id,
        stepId: "approve_po",
        attempt: 1,
        state: "waiting",
        input: { message: "Approve order with token super-secret-value-123 please" },
      })
      .returning();
    await createApproval(db, appStep!.id, new Date(Date.now() + 3600_000), owner.userId);

    // 4. Needs-review run
    await db
      .insert(runs)
      .values({
        workflowVersionId: ver!.id,
        state: "needs_review",
        test: false,
        error: "Provider timed out after send",
        createdAt: new Date(Date.now() - 10_000),
      })
      .returning();

    const res = await owner.agent.get("/inbox").expect(200);
    const body = res.body as InboxPayload;
    expect(body.counts).toEqual({ total: 4, conversations: 1, receipts: 1, approvals: 1, runs: 1 });
    expect(new Set(body.items.map((i) => i.kind))).toEqual(new Set(["conversation", "receipt", "approval", "run"]));
    const times = body.items.map((i) => Date.parse(i.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const approvalItem = body.items.find((i) => i.kind === "approval");
    expect(approvalItem?.kind).toBe("approval");
    if (approvalItem?.kind === "approval") {
      expect(approvalItem.data.message).not.toContain("super-secret-value-123");
      expect(approvalItem.data.message).toContain("Approve order");
      expect(approvalItem.data.canDecide).toBe(true);
    }

    // Other roles: requester & approver are blocked from /inbox (403).
    const requester = await addMember(owner.agent, "requester");
    await requester.agent.get("/inbox").expect(403);
    const approver = await addMember(owner.agent, "approver");
    await approver.agent.get("/inbox").expect(403);
  });

  it("enforces named approver checks, replay protection, and wakes the run on POST /inbox/approvals/:id/decide", async () => {
    const owner = await createOwner();
    const operator = await addMember(owner.agent, "operator");
    const otherOwner = await createOwner();

    const [wf] = await db.insert(workflows).values({ userId: owner.userId, name: "Purchase", slug: `po-${seq}` }).returning();
    const [ver] = await db
      .insert(workflowVersions)
      .values({ workflowId: wf!.id, version: 1, published: true, definition: { trigger: { type: "manual", config: {} }, steps: [], edges: [] } })
      .returning();

    // Named approval addressed to owner -> operator cannot decide (403), other workspace gets 404, owner succeeds (200), replay 409.
    const [namedRun] = await db.insert(runs).values({ workflowVersionId: ver!.id, state: "waiting", test: false }).returning();
    const [namedStep] = await db.insert(stepRuns).values({ runId: namedRun!.id, stepId: "mgr", attempt: 1, state: "waiting", input: { message: "Sign PO" } }).returning();
    await createApproval(db, namedStep!.id, new Date(Date.now() + 3600_000), owner.userId);
    const [namedApproval] = await db.select().from(approvals).where(eq(approvals.stepRunId, namedStep!.id));

    await operator.agent.post(`/inbox/approvals/${namedApproval!.id}/decide`).send({ decision: "approved" }).expect(403);
    await otherOwner.agent.post(`/inbox/approvals/${namedApproval!.id}/decide`).send({ decision: "approved" }).expect(404);

    const okRes = await owner.agent.post(`/inbox/approvals/${namedApproval!.id}/decide`).send({ decision: "approved" }).expect(200);
    expect(okRes.body).toEqual({ ok: true, runId: namedRun!.id, decision: "approved" });

    // Replaying or flipping decision returns 409.
    await owner.agent.post(`/inbox/approvals/${namedApproval!.id}/decide`).send({ decision: "rejected" }).expect(409);

    // Unnamed (link-holder) approval can be decided by operator too.
    const [openRun] = await db.insert(runs).values({ workflowVersionId: ver!.id, state: "waiting", test: false }).returning();
    const [openStep] = await db.insert(stepRuns).values({ runId: openRun!.id, stepId: "any", attempt: 1, state: "waiting", input: { message: "Check" } }).returning();
    await createApproval(db, openStep!.id, new Date(Date.now() + 3600_000));
    const [openApproval] = await db.select().from(approvals).where(eq(approvals.stepRunId, openStep!.id));

    await operator.agent.post(`/inbox/approvals/${openApproval!.id}/decide`).send({ decision: "rejected" }).expect(200);
  });
});
