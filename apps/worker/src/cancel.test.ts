import { randomBytes } from "node:crypto";
import { cancelRun, runs, stepRuns, users, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import { asc, eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { advance } from "./advance";
import { createExecutor } from "./steps";

// Cancel a pending run (N11b): a delay's wake-up and an approval answer do nothing to a cancelled run.
const key = randomBytes(32);
let db: Db;
let pool: Pool;
let owner: string;
let seq = 0;
const mail: MailDeps = { installation: { transport: nodemailer.createTransport({ jsonTransport: true }), from: "Daloy <daloy@localhost>" }, gmail: () => nodemailer.createTransport({ jsonTransport: true }), sharedMail: "open" };

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  owner = (await db.insert(users).values({ email: "o@test.local", passwordHash: "x" }).returning())[0]!.id;
}, 120_000);
afterAll(() => pool?.end());

const deps = () => ({ db, executor: createExecutor({ db, secretsKey: key, mail, publicUrl: "https://daloy.example.com" }), owner: "test", leaseMs: 5000, enqueue: async () => {} });
const flow = (...steps: { id: string; type: string; config: object }[]) => ({ trigger: { type: "manual", config: {} }, steps, edges: steps.slice(1).map((s, i) => ({ from: steps[i]!.id, to: s.id })) });
const delay = { id: "wait", type: "delay", config: { seconds: 3600 } };
const after = { id: "after", type: "delay", config: { seconds: 1 } };

async function newRun(definition: object) {
  const [wf] = await db.insert(workflows).values({ userId: owner, name: "C", slug: `c-${++seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true }).returning();
  return (await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning())[0]!.id;
}
const state = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0]!;
const attempts = (id: string) => db.select().from(stepRuns).where(eq(stepRuns.runId, id)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));
async function toWaiting(runId: string) {
  for (let i = 0; i < 5 && (await state(runId)).state !== "waiting"; i++) await advance(deps(), runId);
  expect((await state(runId)).state).toBe("waiting");
}

describe("cancelled runs", () => {
  it("never run their next step when the delay's job fires later", async () => {
    const runId = await newRun(flow(delay, after));
    await toWaiting(runId);
    expect(await cancelRun(db, owner, runId, "ana@test.local")).toBe(true);
    // The wake-up time is reached and the sweep or the queued job calls advance.
    await db.update(runs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(runs.id, runId));
    await advance(deps(), runId);
    expect((await state(runId)).state).toBe("cancelled");
    expect((await attempts(runId)).map((a) => [a.stepId, a.state])).toEqual([["wait", "failed"]]);
  });

  it("settle a cancel that races the wake-up: one wins, nothing throws, nothing runs twice", async () => {
    for (let i = 0; i < 8; i++) {
      const runId = await newRun(flow(delay, after));
      await toWaiting(runId);
      await db.update(runs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(runs.id, runId));
      const [cancelled] = await Promise.all([cancelRun(db, owner, runId, "ana@test.local"), advance(deps(), runId)]);
      const run = await state(runId);
      if (cancelled) {
        expect(run.state).toBe("cancelled");
        expect((await attempts(runId)).map((a) => a.stepId)).toEqual(["wait"]);
      } else {
        expect(run.state).not.toBe("cancelled");
      }
    }
  });
});
