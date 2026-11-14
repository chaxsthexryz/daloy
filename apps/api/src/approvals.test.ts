import { randomBytes } from "node:crypto";
import { approvals, createApproval, runs, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let versionId: string;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();
  const [user] = await db.insert(users).values({ email: "owner@test.local", passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: user!.id, name: "Refunds", slug: "refunds" }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  versionId = v!.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

/** A run waiting on an approval, as the worker leaves it, plus the link token from the email. */
async function waitingApproval(message = "Refund 40 EUR to Ana?") {
  const [run] = await db.insert(runs).values({ workflowVersionId: versionId, state: "waiting", nextAttemptAt: new Date(Date.now() + 3_600_000) }).returning();
  const [step] = await db.insert(stepRuns).values({ runId: run!.id, stepId: "ask", attempt: 1, state: "waiting", input: { message } }).returning();
  const token = (await createApproval(db, step!.id, new Date(Date.now() + 3_600_000)))!;
  return { runId: run!.id, stepRunId: step!.id, token };
}
const decisionOf = async (stepRunId: string) => (await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId)))[0]!;

describe("approval page", () => {
  it("shows the escaped message and a POST form, and GET changes nothing", async () => {
    const { stepRunId, token } = await waitingApproval('<script>alert("x")</script> Refund?');
    const res = await request(server).get(`/approvals/${token}`).expect(200);
    expect(res.text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Refund?");
    expect(res.text).not.toContain("<script>");
    expect(res.text).toContain('<form method="post">');
    expect(res.text).toContain('name="decision" value="approved"');
    expect(res.text).toContain('name="decision" value="rejected"');
    // The token is in the URL; it must not leak to other sites or caches.
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    // A link scanner that only follows GET does not approve anything.
    expect((await decisionOf(stepRunId)).usedAt).toBeNull();
  });

  it("records the decision on POST, wakes the run, and refuses the link afterwards", async () => {
    const { runId, stepRunId, token } = await waitingApproval();
    const res = await request(server).post(`/approvals/${token}`).type("form").send({ decision: "approved" }).expect(200);
    expect(res.text).toContain("approved");
    expect((await decisionOf(stepRunId)).decision).toBe("approved");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    await request(server).post(`/approvals/${token}`).type("form").send({ decision: "rejected" }).expect(404);
    await request(server).get(`/approvals/${token}`).expect(404);
    expect((await decisionOf(stepRunId)).decision).toBe("approved");
  });

  it("answers unknown and expired links the same way, and rejects bad input", async () => {
    const unknown = await request(server).get(`/approvals/${"a".repeat(43)}`).expect(404);
    const { stepRunId, token } = await waitingApproval();
    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.stepRunId, stepRunId));
    const expired = await request(server).get(`/approvals/${token}`).expect(404);
    expect(expired.text).toBe(unknown.text);

    await request(server).get("/approvals/short").expect(400);
    const live = await waitingApproval();
    await request(server).post(`/approvals/${live.token}`).type("form").send({ decision: "timeout" }).expect(400);
    expect((await decisionOf(live.stepRunId)).usedAt).toBeNull();
  });

  it("rate limits decisions per client", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await request(server).post(`/approvals/${"b".repeat(43)}`).type("form").send({ decision: "approved" })).status);
    }
    expect(statuses).toContain(429);
  });
});
