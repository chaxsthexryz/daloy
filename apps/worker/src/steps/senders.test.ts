import { randomBytes } from "node:crypto";
import { approveSharedMail, claimVerifyToken, connectGmail, disconnectGmail, issueVerifyToken, runs, stepRuns, users, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import type { Step } from "@daloy/engine";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeSmtp } from "../../../../test/fake-smtp";
import { freshDatabase } from "../../../../test/db";
import { advance } from "../advance";
import { createExecutor } from "./index";

// Roadmap phase 2 acceptance: two owners send through their own accounts, and disconnecting one cannot affect the other.
const key = randomBytes(32);
let db: Db;
let pool: Pool;
let gmail: Awaited<ReturnType<typeof startFakeSmtp>>;
let installation: Awaited<ReturnType<typeof startFakeSmtp>>;
let ana: string;
let ben: string;
let demo: string;

const mail = (sharedMail: MailDeps["sharedMail"] = "open"): MailDeps => ({
  installation: { transport: nodemailer.createTransport({ host: "127.0.0.1", port: installation.port, secure: false, ignoreTLS: true }), from: "kymavo <daloy@localhost>" },
  gmail: (auth) => nodemailer.createTransport({ host: "127.0.0.1", port: gmail.port, secure: false, ignoreTLS: true, auth }),
  sharedMail,
});
const executor = (sharedMail?: MailDeps["sharedMail"]) => createExecutor({ db, secretsKey: key, mail: mail(sharedMail), publicUrl: "https://daloy.example.com" });

const owner = async (email: string) => (await db.insert(users).values({ email, passwordHash: "x" }).returning())[0]!.id;
const connect = async (userId: string, address: string) => {
  await connectGmail(db, key, userId, { address, appPassword: `${address.slice(0, 4)} pass word 1234` });
  await claimVerifyToken(db, userId, await issueVerifyToken(db, userId));
};

const receipt: Step = { id: "receipt", type: "email", config: { to: "{{trigger.email}}", subject: "Thanks", text: "We got it." } };
const run = (userId: string, step: Step, opts: { mock?: boolean; stepRunId?: string } = {}) =>
  executor().execute({
    runId: "r",
    stepRunId: opts.stepRunId ?? "00000000-0000-0000-0000-000000000000",
    userId,
    step,
    attempt: 1,
    idempotencyKey: `r:${step.id}:${userId}`,
    ctx: { trigger: { email: "customer@example.com" }, steps: {} },
    mock: opts.mock,
  });

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  gmail = await startFakeSmtp();
  installation = await startFakeSmtp();
  ana = await owner("ana@test.local");
  ben = await owner("ben@test.local");
  demo = await owner("demo@test.local");
  await connect(ana, "ana.bakery@gmail.com");
  await connect(ben, "ben.clinic@gmail.com");
}, 120_000);

afterAll(async () => {
  await gmail?.close();
  await installation?.close();
  await pool?.end();
});

it("sends each owner's email from their own Gmail account, and the demo owner's through the installation server", async () => {
  expect((await run(ana, receipt)).output).toMatchObject({ from: "ana.bakery@gmail.com", to: ["customer@example.com"] });
  expect(gmail.messages.at(-1)).toMatchObject({ user: "ana.bakery@gmail.com", from: "ana.bakery@gmail.com" });
  await run(ben, receipt);
  expect(gmail.messages.at(-1)).toMatchObject({ user: "ben.clinic@gmail.com", from: "ben.clinic@gmail.com" });
  await run(demo, receipt);
  expect(installation.messages.at(-1)).toMatchObject({ user: undefined, from: "daloy@localhost", to: ["customer@example.com"] });
  expect(gmail.messages.map((m) => m.user)).toEqual(["ana.bakery@gmail.com", "ben.clinic@gmail.com"]);
});

it("sends approval mail from the owner's account too", async () => {
  const [wf] = await db.insert(workflows).values({ userId: ben, name: "Purchases", slug: "purchases" }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
  const [sr] = await db.insert(stepRuns).values({ runId: r!.id, stepId: "ask", attempt: 1 }).returning();
  const ask: Step = { id: "ask", type: "approval", config: { to: "manager@example.com", subject: "Approve?", message: "A new laptop", timeoutSeconds: 3600 } };
  await run(ben, ask, { stepRunId: sr!.id });
  expect(gmail.messages.at(-1)).toMatchObject({ user: "ben.clinic@gmail.com", to: ["manager@example.com"] });
});

it("localizes approval instructions and keeps saved email content after the owner switches language", async () => {
  const userId = await owner("tagalog@test.local");
  await db.update(users).set({ language: "tl" }).where(eq(users.id, userId));
  const [wf] = await db.insert(workflows).values({ userId, name: "English authored name", slug: "language" }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
  const [sr] = await db.insert(stepRuns).values({ runId: r!.id, stepId: "ask", attempt: 1 }).returning();
  const ask: Step = { id: "ask", type: "approval", config: { to: "manager@example.com", subject: "English subject", message: "Keep this English message", timeoutSeconds: 3600 } };
  await run(userId, ask, { stepRunId: sr!.id });
  const raw = installation.messages.at(-1)!.raw.replace(/=\r?\n/g, "");
  expect(raw).toContain("Subject: English subject");
  expect(raw).toContain("Keep this English message");
  expect(raw).toContain("I-approve o tanggihan dito");
  await run(userId, receipt);
  expect(installation.messages.at(-1)!.raw).toContain("Subject: Thanks");
  expect(installation.messages.at(-1)!.raw).toContain("We got it.");
});

it("disconnecting one owner blocks only that owner, without falling back to the installation server", async () => {
  await disconnectGmail(db, ana);
  const counts = [gmail.messages.length, installation.messages.length];
  await expect(run(ana, receipt)).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("Reconnect Gmail") });
  expect([gmail.messages.length, installation.messages.length]).toEqual(counts);
  await run(ben, receipt);
  expect(gmail.messages.at(-1)).toMatchObject({ user: "ben.clinic@gmail.com" });
});

it("a mocked test run sends nothing, even for a blocked sender", async () => {
  const counts = [gmail.messages.length, installation.messages.length];
  expect((await run(ana, receipt, { mock: true })).output).toMatchObject({ mocked: true });
  expect([gmail.messages.length, installation.messages.length]).toEqual(counts);
});

describe("when the shared mail server only sends for approved owners", () => {
  // A fresh sign-up that connected no Gmail: its live test runs, published runs and approval emails must not reach the server.
  async function runOnce(userId: string, steps: Step[], opts: { published: boolean; test: boolean; live: boolean }) {
    const definition = { trigger: { type: "manual", config: {} }, steps, edges: [] };
    const [wf] = await db.insert(workflows).values({ userId, name: "w", slug: `w-${Math.random().toString(36).slice(2)}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: opts.published }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: { email: "customer@example.com" }, test: opts.test, live: opts.live }).returning();
    // One advance runs one step; the next one finishes the run.
    for (let i = 0; i < 3; i++) {
      await advance({ db, executor: executor("approved"), owner: "test", leaseMs: 5000, enqueue: async () => {} }, r!.id);
      const [after] = await db.select().from(runs).where(eq(runs.id, r!.id));
      if (after!.state !== "running" && after!.state !== "pending") return after!;
    }
    throw new Error("run did not finish");
  }
  const approval: Step = { id: "ask", type: "approval", config: { to: "anyone@example.com", subject: "Approve?", message: "m", timeoutSeconds: 3600 } };

  it("sends nothing for an unapproved sign-up, from a live test run, a published run or an approval", async () => {
    const stranger = await owner("stranger@test.local");
    const before = installation.messages.length;
    for (const [steps, opts] of [
      [[receipt], { published: false, test: true, live: true }],
      [[receipt], { published: true, test: false, live: false }],
      [[approval], { published: true, test: false, live: false }],
    ] as const) {
      const r = await runOnce(stranger, [...steps], opts);
      expect(r.state).toBe("failed");
      expect(r.error).toMatch(/Connect Gmail/);
    }
    expect(installation.messages).toHaveLength(before);
  });

  it("sends for an owner the operator approved", async () => {
    const approved = await owner("approved@test.local");
    await approveSharedMail(db, approved, 10);
    const r = await runOnce(approved, [receipt], { published: true, test: false, live: false });
    expect(r.state).toBe("succeeded");
    expect(installation.messages.at(-1)).toMatchObject({ user: undefined, to: ["customer@example.com"] });
  });
});

describe("the daily recipient cap on Gmail (N11b)", () => {
  const withCap = async (cap: string, body: () => Promise<void>) => {
    const before = process.env.MAILBOX_DAILY_CAP;
    process.env.MAILBOX_DAILY_CAP = cap;
    try {
      await body();
    } finally {
      if (before === undefined) delete process.env.MAILBOX_DAILY_CAP;
      else process.env.MAILBOX_DAILY_CAP = before;
    }
  };
  const mailTo = (id: string, to: string): Step => ({ id, type: "email", config: { to, subject: "Hello", text: "Hi" } });
  async function finish(userId: string, steps: Step[]) {
    const definition = { trigger: { type: "manual", config: {} }, steps, edges: [] };
    const [wf] = await db.insert(workflows).values({ userId, name: "w", slug: `w-${Math.random().toString(36).slice(2)}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
    for (let i = 0; i < 4; i++) {
      await advance({ db, executor: executor(), owner: "test", leaseMs: 5000, enqueue: async () => {} }, r!.id);
      const [after] = await db.select().from(runs).where(eq(runs.id, r!.id));
      if (after!.state !== "running" && after!.state !== "pending") return after!;
    }
    throw new Error("run did not finish");
  }

  it("counts every recipient, then sends nothing more and waits for a person, with the reason", async () => {
    await withCap("3", async () => {
      const cara = await owner("cara@test.local");
      await connect(cara, "cara.shop@gmail.com");
      const before = gmail.messages.length;
      expect((await finish(cara, [mailTo("first", "a@example.com,b@example.com")])).state).toBe("succeeded");
      expect((await finish(cara, [mailTo("second", "c@example.com")])).state).toBe("succeeded");
      const capped = await finish(cara, [mailTo("third", "d@example.com")]);
      expect(capped.state).toBe("needs_review");
      expect(capped.error).toContain("today's limit of 3 recipients through its Gmail or Outlook. Nothing was sent.");
      // Two messages went out (the first had two recipients) and the third was held.
      expect(gmail.messages.length).toBe(before + 2);
      const [attempt] = await db.select().from(stepRuns).where(eq(stepRuns.runId, capped.id));
      expect(attempt).toMatchObject({ state: "failed", outcome: "not_sent" });
    });
  });

  it("is per workspace: another owner's Gmail still sends, and installation mail is not counted", async () => {
    await withCap("1", async () => {
      const dan = await owner("dan@test.local");
      await connect(dan, "dan.shop@gmail.com");
      expect((await finish(dan, [mailTo("one", "a@example.com")])).state).toBe("succeeded");
      expect((await finish(dan, [mailTo("two", "b@example.com")])).state).toBe("needs_review");
      const fay = await owner("fay@test.local");
      await connect(fay, "fay.shop@gmail.com");
      expect((await finish(fay, [mailTo("fay_one", "a@example.com")])).state).toBe("succeeded");
      const before = installation.messages.length;
      expect((await finish(demo, [mailTo("d1", "a@example.com")])).state).toBe("succeeded");
      expect((await finish(demo, [mailTo("d2", "b@example.com")])).state).toBe("succeeded");
      expect(installation.messages.length).toBe(before + 2);
    });
  });

  it("does not count a retried send twice", async () => {
    await withCap("2", async () => {
      const eve = await owner("eve@test.local");
      await connect(eve, "eve.shop@gmail.com");
      const step = mailTo("same", "a@example.com");
      await run(eve, step);
      await run(eve, step);
      await run(eve, mailTo("other", "b@example.com"));
      await expect(run(eve, mailTo("third", "c@example.com"))).rejects.toMatchObject({ review: true, outcome: "not_sent" });
    });
  });
});
