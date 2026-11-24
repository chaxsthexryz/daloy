import { randomBytes } from "node:crypto";
import { deliveries, runs, users, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import { StepError, type Step } from "@daloy/engine";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { createExecutor } from "./index";

const key = randomBytes(32);
let db: Db;
let pool: Pool;
let owner: string;
let seq = 0;

const mail: MailDeps = {
  installation: { transport: nodemailer.createTransport({ jsonTransport: true }), from: "kymavo <daloy@localhost>" },
  gmail: () => nodemailer.createTransport({ jsonTransport: true }),
  sharedMail: "open",
};

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  owner = (await db.insert(users).values({ email: "sms-worker@test.local", passwordHash: "x" }).returning())[0]!.id;
}, 120_000);

afterAll(() => pool?.end());

async function newRun() {
  const [wf] = await db.insert(workflows).values({ userId: owner, name: "SMS", slug: `sms-${++seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
  return { runId: r!.id, workflowId: wf!.id };
}

const smsStep = (config: { to: string; message: string; senderId?: string }): Step => ({ id: "send_sms", type: "sms", config });

describe("worker sms step", () => {
  it("validates and normalizes Philippine mobile numbers, and rejects malformed numbers or over-670-char messages", async () => {
    const exec = createExecutor({ db, secretsKey: key, mail });
    const { runId, workflowId } = await newRun();

    const badPhone = await exec
      .execute({
        runId,
        stepRunId: "sr-1",
        userId: owner,
        workflowId,
        step: smsStep({ to: "+14155550100", message: "Hi" }),
        attempt: 1,
        idempotencyKey: `${runId}:send_sms`,
        ctx: { trigger: {}, steps: {} },
        mock: false,
      })
      .catch((e: unknown) => e);
    expect(badPhone).toBeInstanceOf(StepError);
    expect((badPhone as StepError).retryable).toBe(false);

    const tooLong = await exec
      .execute({
        runId,
        stepRunId: "sr-2",
        userId: owner,
        workflowId,
        step: smsStep({ to: "09171234567", message: "a".repeat(671) }),
        attempt: 1,
        idempotencyKey: `${runId}:send_sms`,
        ctx: { trigger: {}, steps: {} },
        mock: false,
      })
      .catch((e: unknown) => e);
    expect(tooLong).toBeInstanceOf(StepError);
    expect((tooLong as StepError).retryable).toBe(false);
    expect((tooLong as Error).message).toMatch(/670/);
  });

  it("mocks cleanly in mock and ai test runs without queuing a delivery", async () => {
    const exec = createExecutor({ db, secretsKey: key, mail });
    const { runId, workflowId } = await newRun();
    const res = await exec.execute({
      runId,
      stepRunId: "sr-3",
      userId: owner,
      workflowId,
      step: smsStep({ to: "{{trigger.phone}}", message: "Hi {{trigger.name}}, confirmed.", senderId: "Clinic" }),
      attempt: 1,
      idempotencyKey: `${runId}:send_sms`,
      ctx: { trigger: { phone: "09171234567", name: "Ana", reference: "REQ-9" }, steps: {} },
      mock: true,
      aiLive: true,
    });
    expect(res.output).toEqual({ mocked: true, reference: "REQ-9", to: "+639171234567", message: "Hi Ana, confirmed.", senderId: "Clinic" });
    expect(await db.select().from(deliveries).where(eq(deliveries.runId, runId))).toEqual([]);
  });

  it("queues a unisms delivery row on live runs with normalized phone number", async () => {
    const exec = createExecutor({ db, secretsKey: key, mail });
    const { runId, workflowId } = await newRun();
    const res = await exec.execute({
      runId,
      stepRunId: "sr-4",
      userId: owner,
      workflowId,
      step: smsStep({ to: "{{trigger.phone}}", message: "Hi {{trigger.name}}, see you tomorrow." }),
      attempt: 1,
      idempotencyKey: `${runId}:send_sms`,
      ctx: { trigger: { phone: "639171234567", name: "Ben", reference: "BK-10" }, steps: {} },
      mock: false,
    });
    expect(res.output).toMatchObject({ reference: "BK-10", to: "+639171234567", state: "queued" });
    const [row] = await db.select().from(deliveries).where(eq(deliveries.runId, runId));
    expect(row).toMatchObject({ provider: "unisms", reference: "BK-10", state: "queued", payload: { to: "+639171234567", message: "Hi Ben, see you tomorrow." } });
  });
});
