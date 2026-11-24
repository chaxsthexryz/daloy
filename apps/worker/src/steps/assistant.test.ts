import { randomBytes } from "node:crypto";
import { bookings, consumeFlow, conversationMessages, createDue, deliveries, encryptSecret, ensureCalendar, finishFlow, googleCalendar, recordInbound, resources, runs, saveConnection, secrets, startFlow, users, workflows, workflowVersions, type Db, type ProviderUrls } from "@daloy/db";
import { dayBounds, StepError, type Step } from "@daloy/engine";
import { eq } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../../test/fake-providers";
import { createExecutor } from "./index";

const SECRET = "tok_live_assistant_redact_9911";
const PUBLIC = "http://localhost:3000";
const ANA = { id: "google-worker-ana", email: "ana@worker.example" };
const NO_STEP_RUN = "00000000-0000-0000-0000-000000000000";

const key = randomBytes(32);
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let seq = 0;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  const app = fake.addOAuthApp("google", { rotation: "none" });
  urls = { ...fake.urls, timeoutMs: 2000, googleOAuth: { clientId: app.clientId, clientSecret: app.clientSecret, ...fake.oauthUrls("google") } };
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

beforeEach(() => {
  Object.assign(fake.oauth.google!, { consent: "grant", user: ANA });
});

async function workspace() {
  const [u] = await db.insert(users).values({ email: `wk-asst${++seq}@test.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: `Assistant ${seq}`, slug: `asst-${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(resources).values({ userId: u!.id, name: `Desk ${seq}` }).returning();
  return { id: u!.id, workflowId: wf!.id, versionId: v!.id, resourceId: r!.id };
}

const executor = () =>
  createExecutor({
    db,
    secretsKey: key,
    urls,
    publicUrl: PUBLIC,
    mail: {
      installation: {
        transport: nodemailer.createTransport({ jsonTransport: true }) as unknown as Transporter,
        from: "d@example.com",
      },
      gmail: () => {
        throw new Error("no Gmail in this test");
      },
      sharedMail: "open",
    },
  });

describe("assistant_read step", () => {
  it("returns a mocked snapshot without calling Google when mock is true, resolving what from upstream step output", async () => {
    const ws = await workspace();
    const [run] = await db.insert(runs).values({ workflowVersionId: ws.versionId, test: true }).returning();
    const step: Step = { id: "read_data", type: "assistant_read", config: { what: "{{steps.pick_intent.output.label}}", timezone: "Asia/Manila" } };
    const res = await executor().execute({
      runId: run!.id,
      stepRunId: NO_STEP_RUN,
      userId: ws.id,
      workflowId: ws.workflowId,
      step,
      attempt: 1,
      idempotencyKey: `${run!.id}:read_data`,
      ctx: { trigger: {}, steps: { pick_intent: { output: { label: "payments" } } } },
      mock: true,
      test: true,
    });
    expect(res.input).toEqual({ what: "payments", timezone: "Asia/Manila" });
    expect(res.output).toMatchObject({ mocked: true, what: "payments", timezone: "Asia/Manila", payments: { count: 0, totalPesos: "0.00" } });
    expect((res.output as Record<string, unknown>).calendar).toBeUndefined();
  });

  it("reads live calendar, bookings, open dues and runs for the workspace only, and redacts workspace secrets from output", async () => {
    const ws = await workspace();
    const other = await workspace();
    await db.insert(secrets).values({ userId: ws.id, name: "internal_key", ...encryptSecret(key, ws.id, "internal_key", SECRET) });

    // Connect Google Calendar for ws and insert an event happening right now (including a leaked workspace secret in summary).
    const back = new URL((await fetch(await startFlow(db, key, urls, PUBLIC, googleCalendar, { workspaceId: ws.id, memberId: ws.id }), { redirect: "manual" })).headers.get("location")!);
    const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: ws.id, memberId: ws.id });
    expect(await finishFlow(db, key, urls, PUBLIC, googleCalendar, ws.id, back.searchParams.get("code")!, flow!.verifier)).toBe("connected");
    const made = await ensureCalendar(db, key, urls, ws.id);

    const { start } = dayBounds(new Date(), "Asia/Manila");
    const slotStart = new Date(start.getTime() + 2 * 3600_000);
    const slotEnd = new Date(slotStart.getTime() + 3600_000);
    fake.calendar(made.calendarId)!.events.set("ev1", {
      id: "ev1",
      status: "confirmed",
      summary: `Standup ${SECRET}`,
      start: { dateTime: slotStart.toISOString() },
      end: { dateTime: slotEnd.toISOString() },
      created: start.toISOString(),
      updated: start.toISOString(),
    });

    const [bRun] = await db.insert(runs).values({ workflowVersionId: ws.versionId, state: "succeeded" }).returning();
    const bookingRef = `B-LIVE-${seq}`;
    await db.insert(bookings).values({
      userId: ws.id,
      test: false,
      reference: bookingRef,
      resourceId: ws.resourceId,
      during: `[${slotStart.toISOString()},${slotEnd.toISOString()})`,
      timezone: "Asia/Manila",
      workflowId: ws.workflowId,
      runId: bRun!.id,
    });
    const due = await createDue(db, { userId: ws.id, test: false, workflowId: ws.workflowId, runId: bRun!.id, stepId: "ask", reference: `DUE-${seq}`, kind: "deposit", amountCentavos: 250_000 });

    // Another workspace's booking and due must never appear.
    const [otherRun] = await db.insert(runs).values({ workflowVersionId: other.versionId, state: "failed" }).returning();
    await createDue(db, { userId: other.id, test: false, workflowId: other.workflowId, runId: otherRun!.id, stepId: "ask", reference: `OTHER-DUE-${seq}`, kind: "full", amountCentavos: 900_000 });

    const [run] = await db.insert(runs).values({ workflowVersionId: ws.versionId, state: "running" }).returning();
    const step: Step = { id: "read_data", type: "assistant_read", config: { what: "all", timezone: "Asia/Manila" } };
    const res = await executor().execute({
      runId: run!.id,
      stepRunId: NO_STEP_RUN,
      userId: ws.id,
      workflowId: ws.workflowId,
      step,
      attempt: 1,
      idempotencyKey: `${run!.id}:read_data`,
      ctx: { trigger: {}, steps: {} },
    });

    const serialized = JSON.stringify(res.output);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[secret]");
    expect(serialized).not.toContain(due.token);
    expect(serialized).not.toContain("OTHER-DUE");
    expect(serialized).toContain(bookingRef);
    expect(serialized).toContain(due.reference);
  });

  it("throws a non-retryable StepError when resolved what is not a valid read scope", async () => {
    const ws = await workspace();
    const [run] = await db.insert(runs).values({ workflowVersionId: ws.versionId }).returning();
    const step: Step = { id: "read_data", type: "assistant_read", config: { what: "{{steps.pick_intent.output.label}}" } };
    await expect(
      executor().execute({
        runId: run!.id,
        stepRunId: NO_STEP_RUN,
        userId: ws.id,
        workflowId: ws.workflowId,
        step,
        attempt: 1,
        idempotencyKey: `${run!.id}:read_data`,
        ctx: { trigger: {}, steps: { pick_intent: { output: { label: "delete_everything" } } } },
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof StepError && err.retryable === false);
  });
});

describe("telegram outbound conversation reply recording", () => {
  it("records outbound message once without prepending booking privacy notice when replying to the run's Telegram chat, and ignores unrelated chats", async () => {
    const ws = await workspace();
    await saveConnection(db, key, ws.id, "telegram", { account: "@assistant_bot", credential: "123456:ABCDEF", destination: { chatId: "999999" } });

    const convo = await db.transaction((tx) =>
      recordInbound(tx, { userId: ws.id, channel: "telegram", externalId: "777111", mid: "tg:777111:1", text: "What is on my schedule?", at: new Date() }),
    );
    const [run] = await db
      .insert(runs)
      .values({ workflowVersionId: ws.versionId, conversationId: convo.id, conversationVersion: convo.version })
      .returning();

    const replyStep: Step = { id: "reply", type: "telegram", config: { chatId: "{{trigger.chatId}}", text: "You have 1 booking at 10:00 AM." } };
    const first = await executor().execute({
      runId: run!.id,
      stepRunId: NO_STEP_RUN,
      userId: ws.id,
      workflowId: ws.workflowId,
      step: replyStep,
      attempt: 1,
      idempotencyKey: `${run!.id}:reply`,
      ctx: { trigger: { chatId: "777111" }, steps: {} },
    });
    // Retry of the same step must be idempotent and not duplicate conversationMessages or deliveries.
    const second = await executor().execute({
      runId: run!.id,
      stepRunId: NO_STEP_RUN,
      userId: ws.id,
      workflowId: ws.workflowId,
      step: replyStep,
      attempt: 2,
      idempotencyKey: `${run!.id}:reply`,
      ctx: { trigger: { chatId: "777111" }, steps: {} },
    });
    expect(second.output).toEqual(first.output);

    // Sending an owner alert (omitting chatId so it uses the workspace's default chat) must not append to the 777111 conversation thread.
    const alertStep: Step = { id: "alert", type: "telegram", config: { text: "Internal alert" } };
    await executor().execute({
      runId: run!.id,
      stepRunId: NO_STEP_RUN,
      userId: ws.id,
      workflowId: ws.workflowId,
      step: alertStep,
      attempt: 1,
      idempotencyKey: `${run!.id}:alert`,
      ctx: { trigger: { chatId: "777111" }, steps: {} },
    });

    const msgs = await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, convo.id));
    const outbound = msgs.filter((m) => m.direction === "out");
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.text).toBe("You have 1 booking at 10:00 AM.");
    expect(outbound[0]?.text).not.toContain("Data Privacy Act");
    expect(await db.select().from(deliveries).where(eq(deliveries.runId, run!.id))).toHaveLength(2);
  });
});
