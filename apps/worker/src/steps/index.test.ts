import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { approvals, encryptSecret, hashToken, joinWorkspace, recordDecision, runs, saveAiSettings, secrets, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
import type { Step } from "@daloy/engine";
import { eq } from "drizzle-orm";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { createExecutor } from "./index";
import { BLOCKED_RANGES, blockListOf } from "./ssrf";

const SECRET = "tok_live_9f8e7d6c5b4a";
// A secret with a quote, backslash, newline and percent sign: it is escaped differently in JSON, URLs and form bodies.
const TRICKY = 'sk"q\\b\nn%25 x';
const TRICKY_FORMS = [TRICKY, JSON.stringify(TRICKY).slice(1, -1), encodeURIComponent(TRICKY), new URLSearchParams({ v: TRICKY }).toString().slice(2)];
const key = randomBytes(32);
let db: Db;
let pool: Pool;
let server: Server;
let port: number;
let userId: string;
const received: string[] = [];
const bodies: string[] = [];
const sent: string[] = [];
const NO_STEP_RUN = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  const [user] = await db.insert(users).values({ email: "owner@test.local", passwordHash: "x" }).returning();
  userId = user!.id;
  await db.insert(secrets).values({ userId, name: "api_token", ...encryptSecret(key, userId, "api_token", SECRET) });
  await db.insert(secrets).values({ userId, name: "tricky", ...encryptSecret(key, userId, "tricky", TRICKY) });
  await db.insert(secrets).values({ userId, name: "host_part", ...encryptSecret(key, userId, "host_part", "acme-internal") });

  // Echoes the Authorization header back in the body and in a response header, as a careless API might.
  server = createServer((req, res) => {
    received.push(req.headers.authorization ?? "");
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      bodies.push(body);
      // A careless API that echoes the raw request back as text.
      if (req.url!.startsWith("/echo-raw")) return res.writeHead(200, { "content-type": "text/plain" }).end(`${req.url}\n${req.headers.authorization}\n${body}`);
      res.writeHead(200, { "content-type": "application/json", "x-echo": req.headers.authorization ?? "" });
      res.end(JSON.stringify({ youSent: req.headers.authorization, [SECRET]: "as a key too" }));
    });
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
      sharedMail: "open",
    },
    publicUrl: "https://daloy.example.com/",
    guard: {
      blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")),
      ports: ["", String(port)],
      // Hosts under .nowhere do not resolve, so a lookup error carries the host name.
      resolve: async (host: string) => (host.endsWith(".nowhere") ? [] : [{ address: "127.0.0.1", family: 4 }]),
    },
  });
const run = (step: Step, trigger: unknown = {}) =>
  executor().execute({ runId: "r", stepRunId: NO_STEP_RUN, userId, step, attempt: 1, idempotencyKey: "r:s", ctx: { trigger, steps: {} } });

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

  it("builds a JSON body value by value, so quotes, newlines and injected keys stay inside one string", async () => {
    const message = 'He said "hi"\nC:\\files", "username": "admin';
    const body = '{"content": "Lead: {{trigger.message}}", "amount": "{{trigger.amount}}", "tags": ["{{trigger.missing}}"]}';
    await run({ id: "call", type: "http", config: { method: "POST", url: `http://api.test:${port}/hook`, headers: { "content-type": "application/json" }, body } }, { message, amount: 40 });
    expect(JSON.parse(bodies.at(-1)!)).toEqual({ content: `Lead: ${message}`, amount: 40, tags: [""] });
    // Not JSON as written (an unquoted placeholder): plain text, as before.
    await run({ id: "call", type: "http", config: { method: "POST", url: `http://api.test:${port}/hook`, headers: {}, body: "n={{trigger.amount}}" } }, { amount: 40 });
    expect(bodies.at(-1)).toBe("n=40");
  });

  it("redacts secrets from error messages", async () => {
    const step: Step = { id: "call", type: "http", config: { method: "GET", url: "http://{{secrets.host_part}}.nowhere/x", headers: {} } };
    const err = (await run(step).then(() => undefined, (e: unknown) => e)) as Error & { input: unknown };
    expect(err.message).toBe("[secret].nowhere did not resolve");
    expect(err.input).toMatchObject({ url: "http://[secret].nowhere/x" });
  });

  it("gives secrets to HTTP steps only: an email, AI prompt or condition resolves them to nothing", async () => {
    const step: Step = { id: "mail", type: "email", config: { to: "{{secrets.api_token}}", subject: "s", text: "t" } };
    const err = (await run(step).then(() => undefined, (e: unknown) => e)) as Error & { retryable: boolean; input: unknown };
    expect(err.message).toBe("email has no recipients");
    expect(err.input).toEqual({ to: "", subject: "s", text: "t" });
    const cond = await run({ id: "c", type: "condition", config: { condition: { left: "{{secrets.api_token}}", op: "eq", right: SECRET } } });
    expect(cond.branch).toBe("false");
  });

  describe("stored previews (QA regression, fec03cc)", () => {
    // A function: port is only known once beforeAll has run. Headers cannot hold a newline, so TRICKY goes in the body.
    const tricky = (): Step => ({
      id: "call",
      type: "http",
      config: {
        method: "POST",
        url: `http://api.test:${port}/echo-raw?k={{secrets.api_token}}`,
        headers: { Authorization: "Bearer {{secrets.api_token}}", "Content-Type": "application/json" },
        body: '{"a": "{{secrets.tricky}}", "nested": {"b": "x {{secrets.tricky}} y"}, "typed": {{secrets.tricky}}}',
      },
    });
    const leaks = (v: unknown) => TRICKY_FORMS.filter((f) => JSON.stringify(v).includes(f) || JSON.stringify(v).includes(JSON.stringify(f).slice(1, -1)));

    it("sends the real secret but stores only [secret], in every encoding, for live and mocked runs", async () => {
      const live = await run(tricky());
      const sent = JSON.parse(bodies.at(-1)!) as { a: string; nested: { b: string }; typed: string };
      expect(sent).toEqual({ a: TRICKY, nested: { b: `x ${TRICKY} y` }, typed: TRICKY });
      expect(received.at(-1)).toBe(`Bearer ${SECRET}`);
      expect(leaks(live.input)).toEqual([]);
      expect(JSON.stringify(live)).not.toContain(SECRET);
      expect(leaks(live.output)).toEqual([]);
      expect(live.input).toMatchObject({ headers: { Authorization: "Bearer [secret]" }, body: '{"a":"[secret]","nested":{"b":"x [secret] y"},"typed":"[secret]"}' });

      const mocked = await executor().execute({ runId: "r", stepRunId: NO_STEP_RUN, userId, step: tricky(), attempt: 1, idempotencyKey: "r:s", ctx: { trigger: {}, steps: {} }, mock: true });
      expect(leaks(mocked.input)).toEqual([]);
      expect(leaks(mocked.output)).toEqual([]);
    });

    it("refuses a request that sends a secret to a host chosen by trigger data", async () => {
      const calls = received.length;
      const step: Step = { id: "call", type: "http", config: { method: "GET", url: `http://api.test:${port}{{trigger.path}}`, headers: { Authorization: "Bearer {{secrets.api_token}}" } } };
      const err = (await run(step, { path: "@evil.test/x" }).then(() => undefined, (e: unknown) => e)) as Error & { retryable: boolean };
      expect(err.message).toMatch(/fixed address/);
      expect(err.retryable).toBe(false);
      expect(received.length).toBe(calls);
      // The same step with data only in the path is fine.
      await run(step, { path: "/ok" });
      expect(received.at(-1)).toBe(`Bearer ${SECRET}`);
    });

    it("refuses a body that says it is JSON but is not, before sending anything", async () => {
      const calls = received.length;
      const step: Step = { id: "call", type: "http", config: { method: "POST", url: `http://api.test:${port}/x`, headers: { "content-type": "application/json" }, body: '{"a": 1' } };
      const err = (await run(step).then(() => undefined, (e: unknown) => e)) as Error & { retryable: boolean };
      expect(err.message).toMatch(/not valid JSON/);
      expect(err.retryable).toBe(false);
      expect(received.length).toBe(calls);
    });
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
      executor().execute({ runId: "r", stepRunId: NO_STEP_RUN, userId, step, attempt: 1, idempotencyKey: "r:s", ctx: { trigger, steps: {} }, mock: true });

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

    it("fails only the first attempt of a step set to an unknown outcome, sending nothing", async () => {
      const calls = received.length;
      const step: Step = { id: "call", type: "http", config: { method: "POST", url: `http://api.test:${port}/orders`, headers: {} } };
      const attempt = (n: number) => executor().execute({ runId: "r", stepRunId: NO_STEP_RUN, userId, step, attempt: n, idempotencyKey: "r:call", ctx: { trigger: {}, steps: {} }, mock: true, choice: { fail: "unknown" } });
      await expect(attempt(1)).rejects.toMatchObject({ outcome: "unknown", retryable: false });
      expect((await attempt(2)).output).toMatchObject({ mocked: true });
      expect(received.length).toBe(calls);
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
    const out = await executor().execute({ runId: r!.id, stepRunId: sr!.id, userId, step, attempt: 1, idempotencyKey: `${r!.id}:ask`, ctx: { trigger: { manager: "boss@example.com", amount: 40 }, steps: {} } });

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

  it("keeps a decision made before a crash: the re-run attempt takes its branch and sends no new link", async () => {
    const { runId, stepRunId } = await waitingApprovalStep();
    const step: Step = { id: "ask", type: "approval", config: { to: "boss@example.com", subject: "Refund?", message: "m", timeoutSeconds: 3600 } };
    const attempt = () => executor().execute({ runId, stepRunId, userId, step, attempt: 1, idempotencyKey: `${runId}:ask:1`, ctx: { trigger: {}, steps: {} } });
    await attempt();
    const token = /approvals\/([A-Za-z0-9_-]{43})/.exec((JSON.parse(sent.at(-1)!) as { text: string }).text)![1]!;
    // The worker died before parking the run, and the approver answered meanwhile.
    expect(await recordDecision(db, token, "rejected")).toBe(runId);

    const before = sent.length;
    const out = await attempt();
    expect(out).toMatchObject({ branch: "rejected", output: { decision: "rejected" } });
    expect(out.waitUntil).toBeUndefined();
    expect(sent.length).toBe(before);
    const rows = await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId));
    expect(rows.map((r) => r.decision)).toEqual(["rejected"]);
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
