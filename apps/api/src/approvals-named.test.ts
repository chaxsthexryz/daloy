import { randomBytes } from "node:crypto";
import { approvals, createApproval, joinWorkspace, runs, sessions, stepRuns, users, workflows, workflowVersions, workspaceMembers, type Db, type Role } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";

// Named approvals (decision 0022). A file of its own: the approval POST is rate limited per IP, and these tests
// need their own counter.

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let ownerId: string;
let versionId: string;
let seq = 0;

/** An account in `workspaceId` (or owning a new workspace) with a live session cookie. */
async function signedIn(role: Role, workspaceId?: string) {
  const [u] = await db.insert(users).values({ email: `named${++seq}@test.local`, passwordHash: "x" }).returning();
  await joinWorkspace(db, u!.id, workspaceId ?? u!.id, workspaceId ? role : "owner");
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return { id: u!.id, email: u!.email, cookie: `daloy_session=${token}` };
}

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();
  ownerId = (await signedIn("owner")).id;
  const [wf] = await db.insert(workflows).values({ userId: ownerId, name: "Purchases", slug: "purchases" }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  versionId = v!.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

const MESSAGE = "Buy a laser printer for 450 EUR?";
async function namedApproval(approverId: string) {
  const [run] = await db.insert(runs).values({ workflowVersionId: versionId, state: "waiting", nextAttemptAt: new Date(Date.now() + 3_600_000) }).returning();
  const [step] = await db.insert(stepRuns).values({ runId: run!.id, stepId: "ask", attempt: 1, state: "waiting", input: { message: MESSAGE } }).returning();
  const token = (await createApproval(db, step!.id, new Date(Date.now() + 3_600_000), approverId))!;
  return { runId: run!.id, stepRunId: step!.id, token };
}
const rowOf = async (stepRunId: string) => (await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId)))[0]!;
const decide = (token: string, cookie: string | undefined, decision = "approved") => {
  const req = request(server).post(`/approvals/${token}`).type("form");
  return (cookie ? req.set("Cookie", cookie) : req).send({ decision });
};

describe("named approval page", () => {
  it("asks a signed-out visitor to sign in, without showing the request", async () => {
    const approver = await signedIn("approver", ownerId);
    const { stepRunId, token } = await namedApproval(approver.id);
    const page = await request(server).get(`/approvals/${token}`).expect(401);
    expect(page.text).toContain(`href="/#/answer/${token}"`);
    expect(page.text).not.toContain(MESSAGE);
    expect(page.headers["cache-control"]).toBe("no-store");
    await decide(token, undefined).expect(401);
    expect((await rowOf(stepRunId)).usedAt).toBeNull();
  });

  it("refuses a forwarded link opened by a colleague or by someone from another workspace", async () => {
    const approver = await signedIn("approver", ownerId);
    const colleague = await signedIn("approver", ownerId);
    const stranger = await signedIn("owner");
    const { stepRunId, token } = await namedApproval(approver.id);
    const page = await request(server).get(`/approvals/${token}`).set("Cookie", colleague.cookie).expect(403);
    expect(page.text).not.toContain(MESSAGE);
    await request(server).get(`/approvals/${token}`).set("Cookie", stranger.cookie).expect(403);
    await decide(token, colleague.cookie).expect(403);
    await decide(token, stranger.cookie).expect(403);
    expect((await rowOf(stepRunId)).usedAt).toBeNull();
  });

  it("lets the named approver decide once and records who decided and when", async () => {
    const approver = await signedIn("approver", ownerId);
    const { runId, stepRunId, token } = await namedApproval(approver.id);
    const page = await request(server).get(`/approvals/${token}`).set("Cookie", approver.cookie).expect(200);
    expect(page.text).toContain(MESSAGE);
    expect(page.text).toContain(`Signed in as ${approver.email}`);

    await decide(token, approver.cookie, "rejected").expect(200);
    const row = await rowOf(stepRunId);
    expect(row).toMatchObject({ decision: "rejected", decidedBy: approver.id, decidedByEmail: approver.email });
    expect(row.usedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // A repeated answer gets the "not valid" page and changes nothing.
    await decide(token, approver.cookie, "approved").expect(404);
    expect((await rowOf(stepRunId)).decision).toBe("rejected");
  });

  it("records one of two answers sent at the same moment", async () => {
    const approver = await signedIn("approver", ownerId);
    const { stepRunId, token } = await namedApproval(approver.id);
    const [a, b] = await Promise.all([decide(token, approver.cookie, "approved"), decide(token, approver.cookie, "rejected")]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect((await rowOf(stepRunId)).decision).toBe(a.status === 200 ? "approved" : "rejected");
  });

  it("refuses an approver who was removed or demoted after the email went out", async () => {
    const removed = await signedIn("approver", ownerId);
    const demoted = await signedIn("approver", ownerId);
    const first = await namedApproval(removed.id);
    const second = await namedApproval(demoted.id);
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, removed.id));
    await db.update(workspaceMembers).set({ role: "requester" }).where(eq(workspaceMembers.userId, demoted.id));
    await request(server).get(`/approvals/${first.token}`).set("Cookie", removed.cookie).expect(401);
    await decide(first.token, removed.cookie).expect(401);
    await request(server).get(`/approvals/${second.token}`).set("Cookie", demoted.cookie).expect(403);
    await decide(second.token, demoted.cookie).expect(403);
    expect((await rowOf(first.stepRunId)).usedAt).toBeNull();
    expect((await rowOf(second.stepRunId)).usedAt).toBeNull();
  });
});
