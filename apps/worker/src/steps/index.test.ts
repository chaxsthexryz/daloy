import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encryptSecret, secrets, users, type Db } from "@daloy/db";
import type { Step } from "@daloy/engine";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    mailer: { transport: nodemailer.createTransport({ jsonTransport: true }), from: "d@example.com" },
    guard: {
      blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")),
      ports: ["", String(port)],
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    },
  });
const run = (step: Step, trigger: unknown = {}) =>
  executor().execute({ runId: "r", userId, step, attempt: 1, idempotencyKey: "r:s:1", ctx: { trigger, steps: {} } });

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
  });

  it("redacts secrets from error messages", async () => {
    const step: Step = { id: "mail", type: "email", config: { to: "{{secrets.api_token}}", subject: "s", text: "t" } };
    const err = (await run(step).then(() => undefined, (e: unknown) => e)) as Error & { retryable: boolean };
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain("[secret]");
    expect(err.retryable).toBe(false);
  });

  it("does not resolve a secret reference that arrives in trigger data", async () => {
    const out = await run({ id: "mail", type: "email", config: { to: "a@example.com", subject: "s", text: "{{trigger.note}}" } }, { note: "{{secrets.api_token}}" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("sends email with resolved templates", async () => {
    const out = await run({ id: "mail", type: "email", config: { to: "{{trigger.email}}", subject: "Hi {{trigger.name}}", text: "t" } }, { email: "ana@example.com", name: "Ana" });
    expect(out.output).toEqual({ messageId: "<r.s.1@daloy>", to: ["ana@example.com"] });
  });

  it("takes a condition branch and schedules a delay", async () => {
    const cond = await run({ id: "c", type: "condition", config: { condition: { left: "{{trigger.n}}", op: "gt", right: 3 } } }, { n: "5" });
    expect(cond.branch).toBe("true");
    const before = Date.now();
    const delay = await run({ id: "d", type: "delay", config: { seconds: 60 } });
    expect(delay.waitUntil!.getTime() - before).toBeGreaterThanOrEqual(60_000);
    expect(delay.waitUntil!.getTime() - before).toBeLessThan(61_000);
  });

  describe("mock mode (builder test runs)", () => {
    const mocked = (step: Step, trigger: unknown = {}) =>
      executor().execute({ runId: "r", userId, step, attempt: 1, idempotencyKey: "r:s:1", ctx: { trigger, steps: {} }, mock: true });

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

    it("caps a delay at one second", async () => {
      const before = Date.now();
      const delay = await mocked({ id: "d", type: "delay", config: { seconds: 3600 } });
      expect(delay.waitUntil!.getTime() - before).toBeLessThan(2_000);
    });
  });
});
