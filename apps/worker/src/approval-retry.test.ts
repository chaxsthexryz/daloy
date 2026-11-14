import { randomBytes } from "node:crypto";
import { approvals, recordDecision, runs, stepRuns, users, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import { asc, eq } from "drizzle-orm";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { advance } from "./advance";
import { createExecutor } from "./steps";

// Regression for the fec03cc report: the approval email reaches the approver, the SMTP acknowledgment is lost, the
// step is retried and sends a second link. Every link must stand for one decision, taken exactly once.
const key = randomBytes(32);
let db: Db;
let pool: Pool;
let ownerId: string;
const sent: string[] = [];
let loseNextAck = false;

const mail: MailDeps = {
  installation: {
    from: "Daloy <daloy@localhost>",
    transport: {
      sendMail: async (msg: SendMailOptions) => {
        const info = await nodemailer.createTransport({ jsonTransport: true }).sendMail(msg);
        sent.push(String(info.message));
        if (loseNextAck) {
          loseNextAck = false;
          throw Object.assign(new Error("connection reset after DATA"), { code: "ECONNRESET" });
        }
        return info;
      },
    } as unknown as Transporter,
  },
  gmail: () => {
    throw new Error("no Gmail in this test");
  },
  sharedMail: "open",
};
const deps = () => ({
  db,
  executor: createExecutor({ db, secretsKey: key, mail, publicUrl: "https://daloy.example.com" }),
  owner: "test",
  leaseMs: 5000,
  retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  enqueue: async () => {},
});

const done = (id: string) => ({ id, type: "condition", config: { condition: { left: "1", op: "eq", right: "1" } } });
const definition = {
  trigger: { type: "manual", config: {} },
  steps: [{ id: "ask", type: "approval", config: { to: "boss@example.com", subject: "Refund?", message: "Refund 40 EUR?", timeoutSeconds: 3600 } }, done("yes"), done("no"), done("late")],
  edges: [
    { from: "ask", to: "yes", on: "approved" },
    { from: "ask", to: "no", on: "rejected" },
    { from: "ask", to: "late", on: "timeout" },
  ],
};

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  ownerId = (await db.insert(users).values({ email: "owner@test.local", passwordHash: "x" }).returning())[0]!.id;
}, 120_000);
afterAll(async () => {
  await pool?.end();
});

let seq = 0;
async function newRun() {
  const [wf] = await db.insert(workflows).values({ userId: ownerId, name: "Refunds", slug: `refunds-${++seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true }).returning();
  return (await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning())[0]!.id;
}
const state = async (runId: string) => (await db.select().from(runs).where(eq(runs.id, runId)))[0]!;
/** Advances until the run reaches one of the states, waiting out the tiny retry backoff. */
async function until(runId: string, states: string[]) {
  for (let i = 0; i < 20; i++) {
    if (states.includes((await state(runId)).state)) return;
    await advance(deps(), runId);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${runId} never reached ${states.join(" or ")}`);
}
const tokenIn = (raw: string) => /approvals\/([A-Za-z0-9_-]{43})/.exec((JSON.parse(raw) as { text: string }).text)![1]!;
const stepsOf = async (runId: string) => (await db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt))).map((r) => [r.stepId, r.attempt, r.state, r.branch]);

describe("approval email retried after a lost acknowledgment", () => {
  for (const decision of ["approved", "rejected"] as const) {
    const branchStep = decision === "approved" ? "yes" : "no";

    it(`retry before link A is clicked: A's ${decision} decides, B stops working, one branch runs once`, async () => {
      const runId = await newRun();
      const before = sent.length;
      loseNextAck = true;
      await until(runId, ["waiting"]);
      expect(sent.length - before).toBe(2);
      const [a, b] = sent.slice(before).map(tokenIn);
      const deadlines = (await db.select({ expiresAt: approvals.expiresAt }).from(approvals).innerJoin(stepRuns, eq(stepRuns.id, approvals.stepRunId)).where(eq(stepRuns.runId, runId))).map((r) => r.expiresAt.getTime());
      expect(new Set(deadlines).size).toBe(1);

      expect(await recordDecision(db, a!, decision)).toBe(runId);
      await until(runId, ["succeeded", "failed"]);
      expect(await recordDecision(db, b!, decision === "approved" ? "rejected" : "approved")).toBeNull();
      expect(await stepsOf(runId)).toEqual([
        ["ask", 1, "failed", null],
        ["ask", 2, "succeeded", decision],
        [branchStep, 1, "succeeded", "true"],
      ]);
      expect(sent.length - before).toBe(2);
    });

    it(`link A ${decision} before the retry: the retry takes it, sends nothing, one branch runs once`, async () => {
      const runId = await newRun();
      const before = sent.length;
      loseNextAck = true;
      await advance(deps(), runId);
      expect(sent.length - before).toBe(1);
      expect(await recordDecision(db, tokenIn(sent.at(-1)!), decision)).toBe(runId);
      await until(runId, ["succeeded", "failed"]);
      expect(await stepsOf(runId)).toEqual([
        ["ask", 1, "failed", null],
        ["ask", 2, "succeeded", decision],
        [branchStep, 1, "succeeded", "true"],
      ]);
      expect(sent.length - before).toBe(1);
    });
  }

  it("stays waiting until the deadline when woken early with no answer", async () => {
    const runId = await newRun();
    await until(runId, ["waiting"]);
    const deadline = (await state(runId)).nextAttemptAt!;
    await db.update(runs).set({ nextAttemptAt: new Date() }).where(eq(runs.id, runId));
    await advance(deps(), runId);
    const after = await state(runId);
    expect(after.state).toBe("waiting");
    expect(after.nextAttemptAt!.getTime()).toBe(deadline.getTime());
    expect((await stepsOf(runId)).map((s) => s[0])).toEqual(["ask"]);
  });
});
