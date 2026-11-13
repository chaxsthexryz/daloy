import { randomBytes } from "node:crypto";
import { claimVerifyToken, connectGmail, disconnectGmail, issueVerifyToken, runs, stepRuns, users, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import type { Step } from "@daloy/engine";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startFakeSmtp } from "../../../../test/fake-smtp";
import { freshDatabase } from "../../../../test/db";
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

const mail = (): MailDeps => ({
  installation: { transport: nodemailer.createTransport({ host: "127.0.0.1", port: installation.port, secure: false, ignoreTLS: true }), from: "Daloy <daloy@localhost>" },
  gmail: (auth) => nodemailer.createTransport({ host: "127.0.0.1", port: gmail.port, secure: false, ignoreTLS: true, auth }),
});
const executor = () => createExecutor({ db, secretsKey: key, mail: mail(), publicUrl: "https://daloy.example.com" });

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
