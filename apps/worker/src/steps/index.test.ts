import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { approvals, bookings, deliveries, encryptSecret, hashToken, joinWorkspace, payments, recordDecision, resources, runs, saveAiSettings, saveConnection, secrets, stepRuns, usageClaims, usageCounts, manilaDay, users, workflows, workflowVersions, type Db } from "@daloy/db";
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

  describe("delay until a time", () => {
    const until = (offsetSeconds?: number) => ({ id: "d", type: "delay", config: { until: "{{trigger.at}}", ...(offsetSeconds === undefined ? {} : { offsetSeconds }) } }) as Step;
    const inAWeek = () => new Date(Date.now() + 7 * 86_400_000);
    const zoned = (d: Date) => d.toISOString().replace("Z", "+00:00");

    it("waits until the time from the run, moved by the offset", async () => {
      const at = inAWeek();
      const out = await run(until(-3600), { at: zoned(at) });
      expect(out.waitUntil!.getTime()).toBe(at.getTime() - 3_600_000);
      expect(out.output).toEqual({ resumeAt: new Date(at.getTime() - 3_600_000).toISOString() });
      expect(out.input).toEqual({ until: zoned(at), offsetSeconds: -3600 });
      expect(out.branch).toBeUndefined();
    });

    it("takes the late branch at once when that time has passed", async () => {
      const at = new Date(Date.now() + 1_800_000);
      const out = await run(until(-3600), { at: zoned(at) });
      expect(out).toMatchObject({ branch: "late", output: { resumeAt: new Date(at.getTime() - 3_600_000).toISOString(), late: true } });
      expect(out.waitUntil).toBeUndefined();
    });

    it("fails for good when the time has no offset or is not a time", async () => {
      for (const at of ["2030-01-20T14:00", "next week", ""]) {
        const err = (await run(until(), { at }).then(() => undefined, (e: unknown) => e)) as Error & { retryable: boolean };
        expect(err.message, at).toBe(`"until" needs a date and time with an offset, like 2030-01-20T14:00:00+08:00, but got ${JSON.stringify(at)}`);
        expect(err.retryable).toBe(false);
      }
    });
  });

  describe("booking step", () => {
    const at = { name: "at", label: "At", type: "datetime" as const, required: true, timezone: "Asia/Manila", slotMinutes: 60 };
    const trigger = { type: "form" as const, config: { fields: [at, { name: "who", label: "Who", type: "resource" as const, required: true }] } };
    const book: Step = { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.who}}", start: "{{trigger.at}}", minutes: 60 } };
    const year = new Date().getUTCFullYear() + 2;
    async function setup(test = false) {
      const [wf] = await db.insert(workflows).values({ userId, name: "Spa", slug: `spa-${randomUUID().slice(0, 8)}` }).returning();
      const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
      const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, test }).returning();
      const [res] = await db.insert(resources).values({ userId, name: `Ana ${randomUUID().slice(0, 4)}` }).returning();
      const exec = (payload: object, extra: { choice?: { booking: "taken" | "not_found" }; mock?: boolean } = {}) =>
        executor().execute({ runId: r!.id, stepRunId: NO_STEP_RUN, userId, step: book, attempt: 1, idempotencyKey: `${r!.id}:book`, ctx: { trigger: payload, steps: {} }, booking: { test, workflowId: wf!.id, trigger }, ...extra });
      return { runId: r!.id, resource: { id: res!.id, name: res!.name }, exec };
    }

    it("books the resource from a resource field and shows its id in the input", async () => {
      const s = await setup();
      const out = await s.exec({ who: s.resource, at: `${year}-01-20T14:00:00+08:00` });
      expect(out).toMatchObject({ branch: "done", output: { resource: s.resource, start: `${year}-01-20T14:00:00+08:00`, version: 1 } });
      expect(out.input).toEqual({ action: "create", resource: s.resource.id, start: `${year}-01-20T14:00:00+08:00`, minutes: 60 });
    });

    it("checks the start against the field's slot and future rules again when booking", async () => {
      const s = await setup();
      for (const [value, problem] of [
        [`${year}-01-20T14:30:00+08:00`, "must start on a 60-minute slot, counted from midnight in Asia/Manila"],
        ["2020-01-20T14:00:00+08:00", "must be in the future"],
        ["soon", "must be a date and time like 2027-01-20T14:00"],
      ]) {
        const err = (await s.exec({ who: s.resource, at: value }).then(() => undefined, (e: unknown) => e)) as Error & { retryable: boolean };
        expect(err.message, value).toBe(`"start" ${problem}, but got ${JSON.stringify(value)}`);
        expect(err.retryable).toBe(false);
      }
      expect(await db.select().from(bookings).where(eq(bookings.resourceId, s.resource.id))).toEqual([]);
    });

    it("answers not_found for a resource that is not an id of this workspace", async () => {
      const s = await setup();
      expect((await s.exec({ who: "Ana", at: `${year}-01-20T14:00` })).branch).toBe("not_found");
      expect((await s.exec({ who: { id: randomUUID(), name: "Ana" }, at: `${year}-01-20T15:00` }, {})).branch).toBe("not_found");
    });

    it("makes a test booking in a mocked run, and a chosen outcome books nothing", async () => {
      const s = await setup(true);
      const chosen = await s.exec({ who: s.resource, at: `${year}-01-20T14:00` }, { choice: { booking: "taken" }, mock: true });
      expect(chosen).toMatchObject({ branch: "taken", output: { mocked: true } });
      expect(await db.select().from(bookings).where(eq(bookings.resourceId, s.resource.id))).toEqual([]);
      const made = await s.exec({ who: s.resource, at: `${year}-01-20T14:00` }, { mock: true });
      expect(String((made.output as { reference: string }).reference)).toMatch(/^TEST-/);
      expect((await db.select().from(bookings).where(eq(bookings.resourceId, s.resource.id)))[0]).toMatchObject({ test: true });
    });
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

    it("reports the real wake-up time while waiting one second", async () => {
      const before = Date.now();
      const delay = await mocked({ id: "d", type: "delay", config: { seconds: 3600 } });
      const resumeAt = new Date((delay.output as { resumeAt: string }).resumeAt).getTime();
      expect(resumeAt - before).toBeGreaterThanOrEqual(3_600_000);
      expect(delay.output).toMatchObject({ mocked: true });
      const at = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const until = await mocked({ id: "d", type: "delay", config: { until: "{{trigger.at}}" } }, { at });
      expect(until.output).toEqual({ resumeAt: at, mocked: true });
      expect(until.waitUntil!.getTime() - Date.now()).toBeLessThan(2_000);
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

  it("counts every recipient of an approval email, so one unit left refuses two recipients", async () => {
    const [u] = await db.insert(users).values({ email: "capped@test.local", passwordHash: "x", plan: "pilot" }).returning();
    await db.insert(usageCounts).values({ userId: u!.id, kind: "email", period: manilaDay(), used: 99 });
    const { runId, stepRunId } = await waitingApprovalStep();
    const step: Step = { id: "ask", type: "approval", config: { to: "a@example.com, b@example.com", subject: "Buy?", message: "A printer", timeoutSeconds: 3600 } };
    const mails = sent.length;
    const err = await executor().execute({ runId, stepRunId, userId: u!.id, step, attempt: 1, idempotencyKey: `${runId}:ask:1`, ctx: { trigger: {}, steps: {} } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: expect.stringMatching(/limit of 100 email recipients/) });
    expect(sent).toHaveLength(mails);
    expect(await db.select().from(approvals).where(eq(approvals.stepRunId, stepRunId))).toHaveLength(0);
  });

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

describe("paymongo_link step", () => {
  const calls: { auth: string; idem: string; body: { data: { attributes: { line_items: { amount: number }[]; metadata: Record<string, string> } } } }[] = [];
  let fake: Server;
  let status = 200;
  let sessions = 0;
  const step = (amount: string): Step => ({ id: "pay", type: "paymongo_link", config: { amount, description: "Deposit", reference: "INV-1" } });
  beforeAll(async () => {
    fake = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        calls.push({ auth: req.headers.authorization ?? "", idem: String(req.headers["idempotency-key"]), body: JSON.parse(raw) });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(status === 200 ? { data: { id: `cs_${++sessions}`, attributes: { checkout_url: `https://pay.test/cs_${sessions}`, livemode: false } } } : { errors: [{ detail: "no" }] }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    vi.stubEnv("PAYMONGO_API_URL", `http://127.0.0.1:${(fake.address() as AddressInfo).port}`);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    fake.close();
  });
  async function setup(connect = true) {
    const [u] = await db.insert(users).values({ email: `pay-${randomUUID()}@test.local`, passwordHash: "x" }).returning();
    if (connect) await saveConnection(db, key, u!.id, "paymongo", { account: "Test", credential: JSON.stringify({ secretKey: "sk_test_abc", webhookSecret: "whsk_x" }) });
    const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Pay", slug: `pay-${randomUUID().slice(0, 8)}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
    const exec = (amount: string) =>
      createExecutor({ db, secretsKey: key, mail: {} as never }).execute({ runId: r!.id, stepRunId: NO_STEP_RUN, userId: u!.id, step: step(amount), attempt: 1, idempotencyKey: `${r!.id}:pay`, ctx: { trigger: {}, steps: {} }, workflowId: wf!.id });
    return { runId: r!.id, userId: u!.id, exec };
  }

  it("creates one checkout session with the step key and Basic auth, and stores one payment", async () => {
    calls.length = 0;
    const s = await setup();
    const out = await s.exec("150.50");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.idem).toBe(`${s.runId}:pay`);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from("sk_test_abc:").toString("base64")}`);
    expect(calls[0]!.body.data.attributes.line_items[0]!.amount).toBe(15050);
    expect(calls[0]!.body.data.attributes.metadata).toEqual({ daloy_run: s.runId, daloy_step: "pay", reference: "INV-1" });
    expect(out.output).toMatchObject({ url: expect.stringContaining("https://pay.test/cs_"), reference: "INV-1", amount: 15050, status: "pending" });
    expect(await db.select().from(payments).where(eq(payments.runId, s.runId))).toHaveLength(1);
    expect(await db.select().from(usageClaims).where(eq(usageClaims.key, `${s.runId}:pay`))).toMatchObject([{ kind: "http" }]);
  });

  it("makes no second PayMongo call when the step runs again", async () => {
    calls.length = 0;
    const s = await setup();
    const first = await s.exec("150");
    const again = await s.exec("150");
    expect(calls).toHaveLength(1);
    expect(again.output).toEqual(first.output);
  });

  it("rejects an amount with a comma without calling PayMongo", async () => {
    calls.length = 0;
    const s = await setup();
    await expect(s.exec("1,500")).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("1,500") });
    expect(calls).toHaveLength(0);
  });

  it("says to connect PayMongo first when there is no connection", async () => {
    calls.length = 0;
    const s = await setup(false);
    await expect(s.exec("150")).rejects.toMatchObject({ retryable: false, message: "Connect PayMongo first." });
    expect(calls).toHaveLength(0);
  });

  it("does not retry a refused request", async () => {
    const s = await setup();
    status = 400;
    try {
      await expect(s.exec("150")).rejects.toMatchObject({ retryable: false, outcome: "rejected" });
    } finally {
      status = 200;
    }
  });
});

describe("payment_status step", () => {
  async function setup() {
    const [u] = await db.insert(users).values({ email: `ps-${randomUUID()}@test.local`, passwordHash: "x" }).returning();
    const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Pay", slug: `ps-${randomUUID().slice(0, 8)}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
    const exec = (link: string, mock = false) =>
      createExecutor({ db, secretsKey: key, mail: {} as never }).execute({ runId: r!.id, stepRunId: NO_STEP_RUN, userId: u!.id, step: { id: "check", type: "payment_status", config: { link } }, attempt: 1, idempotencyKey: `${r!.id}:check`, ctx: { trigger: {}, steps: {} }, workflowId: wf!.id, mock });
    return { runId: r!.id, userId: u!.id, workflowId: wf!.id, exec };
  }

  it("reports the stored payment's current status, pending then paid, without calling PayMongo", async () => {
    const s = await setup();
    await db.insert(payments).values({ userId: s.userId, workflowId: s.workflowId, runId: s.runId, stepId: "pay", reference: "INV-9", amountCentavos: 5000, livemode: false, providerSessionId: `cs_${randomUUID()}`, url: "https://pay.test/x" });
    expect((await s.exec("pay")).output).toMatchObject({ status: "pending", paid: false, reference: "INV-9" });
    await db.update(payments).set({ status: "paid" }).where(eq(payments.runId, s.runId));
    expect((await s.exec("pay")).output).toMatchObject({ status: "paid", paid: true });
  });

  it("fails without retry when the run made no link, and answers pending in a test run", async () => {
    const s = await setup();
    await expect(s.exec("pay")).rejects.toMatchObject({ retryable: false });
    expect((await s.exec("pay", true)).output).toMatchObject({ mocked: true, status: "pending" });
  });
});

describe("drive step", () => {
  const ref = (name: string) => ({ id: randomUUID(), name, type: "png", size: 4 });
  async function setup() {
    const [u] = await db.insert(users).values({ email: `drive-${randomUUID()}@test.local`, passwordHash: "x" }).returning();
    const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Intake", slug: `w${randomUUID().slice(0, 8)}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {}, published: true }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
    const exec = (trigger: Record<string, unknown>, fileFields: string[] | undefined, mock = false) =>
      createExecutor({ db, secretsKey: key, mail: {} as never }).execute({ runId: r!.id, stepRunId: NO_STEP_RUN, userId: u!.id, step: { id: "save", type: "drive", config: {} }, attempt: 1, idempotencyKey: `${r!.id}:save`, ctx: { trigger, steps: {} }, workflowId: wf!.id, mock, fileFields });
    return { runId: r!.id, exec };
  }

  it("queues one Drive delivery with the files of every file field, and the same one when the step runs again", async () => {
    const s = await setup();
    const [a, b, c] = [ref("front.png"), ref("side.png"), ref("scan.png")];
    const trigger = { reference: "REQ-5", name: "Ana", photos: [a, b], scan: [c] };
    const out = (await s.exec(trigger, ["photos", "scan"])).output as { deliveryId: string; files: number };
    expect(out).toMatchObject({ reference: "REQ-5", state: "queued", files: 3 });
    const rows = await db.select().from(deliveries).where(eq(deliveries.runId, s.runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "google_drive", reference: "REQ-5", payload: { files: [a, b, c] } });
    expect(((await s.exec(trigger, ["photos", "scan"])).output as { deliveryId: string }).deliveryId).toBe(out.deliveryId);
  });

  it("ignores values of fields that are not file fields, and queues nothing when there are no files", async () => {
    const s = await setup();
    expect((await s.exec({ reference: "REQ-6", other: [ref("x.png")] }, ["photos"])).output).toEqual({ files: 0 });
    expect((await s.exec({ reference: "REQ-6" }, undefined)).output).toEqual({ files: 0 });
    expect(await db.select().from(deliveries).where(eq(deliveries.runId, s.runId))).toHaveLength(0);
  });

  it("only counts the files in a test run", async () => {
    const s = await setup();
    expect((await s.exec({ photos: [ref("a.png"), ref("b.png")] }, ["photos"], true)).output).toEqual({ mocked: true, files: 2 });
    expect(await db.select().from(deliveries).where(eq(deliveries.runId, s.runId))).toHaveLength(0);
  });
});
