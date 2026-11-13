import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { approvals, encryptSecret, hashToken, joinWorkspace, runs, saveAiSettings, secrets, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
import type { Step } from "@daloy/engine";
import { eq } from "drizzle-orm";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { createExecutor } from "./index";
import { BLOCKED_RANGES, blockListOf } from "./ssrf";

const SECRET = "tok_live_9f8e7d6c5b4a";
const key = randomBytes(32);
let db: Db;
let pool: Pool;
let server: Server;
let port: number;
let userId: string;
const received: string[] = [];
const sent: string[] = [];
const NO_STEP_RUN = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  const [user] = await db.insert(users).values({ email: "owner@test.local", passwordHash: "x" }).returning();
  userId = user!.id;
  await db.insert(secrets).values({ userId, name: "api_token", ...encryptSecret(key, userId, "api_token", SECRET) });

  // Echoes the Authorization header back in the body and in a response header, as a careless API might.
  server = createServer((req, res) => {
    received.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json", "x-echo": req.headers.authorization ?? "" });
    res.end(JSON.stringify({ youSent: req.headers.authorization, [SECRET]: "as a key too" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  await pool?.end();
});

const executor = () =>
  createExecutor({
    db,
    secretsKey: key,
    mail: {
      installation: {
        // jsonTransport builds the message without sending it; keep it so tests can read the approval link.
        transport: {
          sendMail: async (msg: SendMailOptions) => {
            const info = await nodemailer.createTransport({ jsonTransport: true }).sendMail(msg);
            sent.push(String(info.message));
            return info;
          },
        } as unknown as Transporter,
        from: "d@example.com",
      },
      // This owner connected no Gmail account (senders.test.ts covers that path).
      gmail: () => {
        throw new Error("no Gmail in this test");
      },
    },
    publicUrl: "https://daloy.example.com/",
    guard: {
      blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")),
      ports: ["", String(port)],
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    },
  });
const run = (step: Step, trigger: unknown = {}) =>
  executor().execute({ runId: "r", stepRunId: NO_STEP_RUN, userId, step, attempt: 1, idempotencyKey: "r:s:1", ctx: { trigger, steps: {} } });

describe("step executor", () => {
  it("fills secrets into the request but never into the stored output", async () => {
    const out = await run({
      id: "call",
      type: "http",
      config: { method: "GET", url: `http://api.test:${port}/x?q={{trigger.q}}`, headers: { Authorization: "Bearer {{secrets.api_token}}" } },
    }, { q: "hi" });
    expect(received.at(-1)).toBe(`Bearer ${SECRET}`);
    const stored = JSON.stringify(out.output);
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("Bearer [secret]");
    expect(out.input).toEqual({ method: "GET", url: `http://api.test:${port}/x?q=hi`, headers: { Authorization: "Bearer [secret]" } });
  });

  it("redacts secrets from error messages", async () => {
    const step: Step = { id: "mail", type: "email", config: { to: "{{secrets.api_token}}", subject: "s", text: "t" } };
    const err = (await run(step).then(() => undefined, (e: unknown) => e)) as Error & { retryable: boolean };
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain("[secret]");
    expect(err.retryable).toBe(false);
    expect((err as unknown as { input: unknown }).input).toEqual({ to: "[secret]", subject: "s", text: "t" });
  });

  it("does not resolve a secret reference that arrives in trigger data", async () => {
    const out = await run({ id: "mail", type: "email", config: { to: "a@example.com", subject: "s", text: "{{trigger.note}}" } }, { note: "{{secrets.api_token}}" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("sends email with resolved templates", async () => {
    const out = await run({ id: "mail", type: "email", config: { to: "{{trigger.email}}", subject: "Hi {{trigger.name}}", text: "t" } }, { email: "ana@example.com", name: "Ana" });
    expect(out.output).toEqual({ messageId: "<r.s.1@daloy>", to: ["ana@example.com"], from: "d@example.com" });
  });

  it("takes a condition branch and schedules a delay", async () => {
    const cond = await run({ id: "c", type: "condition", config: { condition: { left: "{{trigger.n}}", op: "gt", right: 3 } } }, { n: "5" });
    expect(cond.branch).toBe("true");
    expect(cond.input).toEqual({ left: "5", op: "gt", right: 3 });
    const before = Date.now();
    const delay = await run({ id: "d", type: "delay", config: { seconds: 60 } });
    expect(delay.waitUntil!.getTime() - before).toBeGreaterThanOrEqual(60_000);
    expect(delay.waitUntil!.getTime() - before).toBeLessThan(61_000);
  });

  describe("mock mode (builder test runs)", () => {
    const mocked = (step: Step, trigger: unknown = {}) =>
      executor().execute({ runId: "r", stepRunId: NO_STEP_RUN, userId, step, attempt: 1, idempotencyKey: "r:s:1", ctx: { trigger, steps: {} }, mock: true });

    it("answers http without a request and still redacts secrets", async () => {
      const calls = received.length;
      const out = await mocked({ id: "call", type: "http", config: { method: "POST", url: `http://api.test:${port}/{{secrets.api_token}}`, headers: {} } });
      expect(received.length).toBe(calls);
      expect(out.output).toMatchObject({ mocked: true, status: 200, body: null, request: { method: "POST", url: `http://api.test:${port}/[secret]` } });
    });

    it("resolves email templates without sending", async () => {
      const out = await mocked({ id: "mail", type: "email", config: { to: "{{trigger.email}}", subject: "Hi {{trigger.name}}", text: "t" } }, { email: "ana@example.com", name: "Ana" });
      expect(out.output).toEqual({ mocked: true, to: "ana@example.com", subject: "Hi Ana" });
    });

    it("answers an ai step with the fixed output and no model call", async () => {
      const step: Step = { id: "c", type: "ai", config: { task: "classify", input: "{{trigger.m}}", labels: { billing: "b", support: "s" } } };
      const out = await mocked(step, { m: "where is my invoice" });
      expect(out.output).toEqual({ label: "billing" });
      expect(out.input).toEqual({ task: "classify", input: "where is my invoice", labels: { billing: "b", support: "s" } });
      expect(out.inputTokens).toBeUndefined();
    });

    it("approves an approval step without sending an email", async () => {
      const before = sent.length;
      const out = await mocked({ id: "ok", type: "approval", config: { to: "boss@example.com", subject: "s", message: "m", timeoutSeconds: 60 } });
      expect(out).toMatchObject({ branch: "approved", output: { mocked: true, decision: "approved" } });
      expect(out.waitUntil).toBeUndefined();
      expect(sent.length).toBe(before);
    });

    it("caps a delay at one second", async () => {
      const before = Date.now();
      const delay = await mocked({ id: "d", type: "delay", config: { seconds: 3600 } });
      expect(delay.waitUntil!.getTime() - before).toBeLessThan(2_000);
    });
  });

  it("emails a single-use approval link, stores only its hash, and waits until the timeout", async () => {
    const [wf] = await db.insert(workflows).values({ userId, name: "Refunds", slug: "refunds" }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "running" }).returning();
    const [sr] = await db.insert(stepRuns).values({ runId: r!.id, stepId: "ask", attempt: 1, state: "running" }).returning();
    const step: Step = { id: "ask", type: "approval", config: { to: "{{trigger.manager}}", subject: "Refund {{trigger.amount}}?", message: "Refund {{trigger.amount}} EUR to Ana?", timeoutSeconds: 3600 } };

    const before = Date.now();
    const out = await executor().execute({ runId: r!.id, stepRunId: sr!.id, userId, step, attempt: 1, idempotencyKey: `${r!.id}:ask:1`, ctx: { trigger: { manager: "boss@example.com", amount: 40 }, steps: {} } });

    expect(out.waitUntil!.getTime() - before).toBeGreaterThanOrEqual(3_600_000);
    expect(out.input).toEqual({ to: "boss@example.com", subject: "Refund 40?", message: "Refund 40 EUR to Ana?", timeoutSeconds: 3600 });
    const mail = JSON.parse(sent.at(-1)!) as { subject: string; text: string };
    expect(mail.subject).toBe("Refund 40?");
    const token = /https:\/\/daloy\.example\.com\/approvals\/([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1];
    expect(token).toBeDefined();
    const [row] = await db.select().from(approvals).where(eq(approvals.stepRunId, sr!.id));
    expect(row!.tokenHash).toBe(hashToken(token!));
    expect(JSON.stringify(out)).not.toContain(token);
  });

  async function waitingApprovalStep() {
    const [wf] = await db.insert(workflows).values({ userId, name: "Purchases", slug: `purchases-${randomUUID()}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "running" }).returning();
    const [sr] = await db.insert(stepRuns).values({ runId: r!.id, stepId: "ask", attempt: 1, state: "running" }).returning();
    return { runId: r!.id, stepRunId: sr!.id };
  }

  it("sends a named approval to the approver's sign-in email and stores who may decide (decision 0022)", async () => {
    const [maria] = await db.insert(users).values({ email: "maria@test.local", passwordHash: "x" }).returning();
    await joinWorkspace(db, maria!.id, userId, "approver");
    const { runId, stepRunId } = await waitingApprovalStep();
    const step: Step = { id: "ask", type: "approval", config: { approver: "maria@test.local", subject: "Buy?", message: "A printer", timeoutSeconds: 3600 } };
    const out = await executor().execute({ runId, stepRunId, userId, step, attempt: 1, idempotencyKey: `${runId}:ask:1`, ctx: { trigger: {}, steps: {} } });
    expect(out.input).toMatchObject({ approver: "maria@test.local" });
    const mail = JSON.parse(sent.at(-1)!) as { to: { address: string }[]; text: string };
    expect(mail.to.map((t) => t.address)).toEqual(["maria@test.local"]);
    expect(mail.text).toContain("sign in as maria@test.local");
    const [row] = await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId));
    expect(row!.approverId).toBe(maria!.id);
  });

  it("fails a named approval, without retrying, when the approver is not a member who may approve", async () => {
    const [op] = await db.insert(users).values({ email: "operator@test.local", passwordHash: "x" }).returning();
    await joinWorkspace(db, op!.id, userId, "operator");
    for (const approver of ["operator@test.local", "nobody@test.local"]) {
      const { runId, stepRunId } = await waitingApprovalStep();
      const step: Step = { id: "ask", type: "approval", config: { approver, subject: "Buy?", message: "A printer", timeoutSeconds: 3600 } };
      const err = await executor()
        .execute({ runId, stepRunId, userId, step, attempt: 1, idempotencyKey: `${runId}:ask:1`, ctx: { trigger: {}, steps: {} } })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ retryable: false, message: expect.stringContaining("not a member of this workspace who can approve") });
      expect(await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId))).toHaveLength(0);
    }
  });
});

it("runs an AI step with the model its owner picked in the console", async () => {
  const models: string[] = [];
  const llm = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      models.push((JSON.parse(raw) as { model: string }).model);
      res.end(JSON.stringify({ message: { content: '{"label":"billing"}' }, prompt_eval_count: 9, eval_count: 2 }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${(llm.address() as AddressInfo).port}`);
  try {
    await saveAiSettings(db, key, userId, { preset: "local", model: "owner-model" });
    const result = await run({ id: "c", type: "ai", config: { task: "classify", input: "{{trigger.m}}", labels: { billing: "Invoices", other: "Else" } } } as Step, { m: "refund please" });
    expect(models).toEqual(["owner-model"]);
    expect(result.output).toEqual({ label: "billing" });
  } finally {
    vi.unstubAllEnvs();
    llm.close();
  }
});
