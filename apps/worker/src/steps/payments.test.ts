import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { bookFromStep, paymentDues, payments, resources, runs, saveConnection, users, workflows, workflowVersions, workspaceMembers, type Db } from "@daloy/db";
import type { Step } from "@daloy/engine";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { createExecutor } from "./index";

// payment_due, payment_expire and payment_status on a due (R3, decision 0088), against a small fake PayMongo.
const key = randomBytes(32);
const NO_STEP_RUN = "00000000-0000-0000-0000-000000000000";
let db: Db;
let pool: Pool;
let fake: Server;
const sessions: { id: string; amount: number }[] = [];
const expired: string[] = [];
let busy = false;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const m = /^\/v1\/checkout_sessions\/([^/]+)\/expire$/.exec(req.url ?? "");
      if (m) {
        if (busy) return res.writeHead(400).end(JSON.stringify({ errors: [{ detail: "payment in progress" }] }));
        expired.push(m[1]!);
        return res.writeHead(200).end(JSON.stringify({ data: { id: m[1], attributes: { status: "expired" } } }));
      }
      const amount = (JSON.parse(raw) as { data: { attributes: { line_items: { amount: number }[] } } }).data.attributes.line_items[0]!.amount;
      const id = `cs_${sessions.length + 1}_${randomUUID().slice(0, 6)}`;
      sessions.push({ id, amount });
      res.writeHead(200).end(JSON.stringify({ data: { id, attributes: { checkout_url: `https://pay.test/${id}`, livemode: false } } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  vi.stubEnv("PAYMONGO_API_URL", `http://127.0.0.1:${(fake.address() as AddressInfo).port}`);
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  fake.close();
  await pool?.end();
});

async function setup() {
  const [u] = await db.insert(users).values({ email: `seller-${randomUUID()}@test.local`, passwordHash: "x" }).returning();
  await db.insert(workspaceMembers).values({ userId: u!.id, workspaceId: u!.id, role: "owner" });
  await saveConnection(db, key, u!.id, "paymongo", { account: "Test", credential: JSON.stringify({ secretKey: "sk_test_abc", webhookSecret: "whsk_x" }) });
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Deposit", slug: `dep-${randomUUID().slice(0, 8)}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
  const exec = (step: Step, mock = false) =>
    createExecutor({ db, secretsKey: key, mail: {} as never, publicUrl: "https://daloy.test" }).execute({ runId: r!.id, stepRunId: NO_STEP_RUN, userId: u!.id, step, attempt: 1, idempotencyKey: `${r!.id}:${step.id}`, ctx: { trigger: { order: "D-1042", phone: "0917 123 4567" }, steps: {} }, workflowId: wf!.id, mock });
  return { userId: u!.id, email: u!.email, runId: r!.id, workflowId: wf!.id, exec };
}

const ask = (over: Partial<Extract<Step, { type: "payment_due" }>["config"]> = {}): Step => ({
  id: "ask",
  type: "payment_due",
  config: { reference: "{{trigger.order}}", kind: "deposit", amount: "350", total: "1200", checkout: false, channel: "sms", to: "{{trigger.phone}}", confirmedMessage: "Deposit for {{trigger.order}} received.", ...over },
});

describe("payment_due step", () => {
  it("records what is owed with a private pay link, once per run and step", async () => {
    const s = await setup();
    const a = await s.exec(ask());
    const b = await s.exec(ask());
    expect(a.output).toMatchObject({ reference: "D-1042", kind: "deposit", amount: 35000, amountPesos: "350.00", status: "pending", checkoutUrl: "" });
    expect((a.output as { payUrl: string }).payUrl).toMatch(/^https:\/\/daloy\.test\/pay\/[A-Za-z0-9_-]{43}$/);
    expect(b.output).toEqual(a.output);
    const [due] = await db.select().from(paymentDues).where(eq(paymentDues.runId, s.runId));
    expect(due).toMatchObject({ replyChannel: "sms", replyTo: "+639171234567", replyText: "Deposit for D-1042 received.", totalCentavos: 120000, test: false });
  });

  it("with checkout on, makes one PayMongo session for the due's amount, linked to the due", async () => {
    const s = await setup();
    const before = sessions.length;
    const out = (await s.exec(ask({ checkout: true }))).output as { checkoutUrl: string; dueId: string };
    await s.exec(ask({ checkout: true }));
    expect(sessions.length).toBe(before + 1);
    expect(sessions.at(-1)!.amount).toBe(35000);
    expect(out.checkoutUrl).toMatch(/^https:\/\/pay\.test\//);
    const [p] = await db.select().from(payments).where(eq(payments.runId, s.runId));
    expect(p).toMatchObject({ dueId: out.dueId, reference: "D-1042", amountCentavos: 35000 });
  });

  it("refuses a bad phone, a reviewer who may not review and a bad amount, without retrying", async () => {
    const s = await setup();
    await expect(s.exec(ask({ to: "12345" }))).rejects.toMatchObject({ retryable: false });
    await expect(s.exec(ask({ reviewer: "stranger@test.local" }))).rejects.toThrow(/not an owner or operator/);
    await expect(s.exec(ask({ amount: "1,200" }))).rejects.toThrow(/amount/);
    await expect(s.exec(ask({ amount: "500", total: "300" }))).rejects.toThrow(/total is less/);
  });

  it("a mocked test run stores nothing", async () => {
    const s = await setup();
    expect((await s.exec(ask(), true)).output).toMatchObject({ mocked: true, status: "pending" });
    expect(await db.select().from(paymentDues).where(eq(paymentDues.runId, s.runId))).toEqual([]);
  });
});

describe("payment_status on a due", () => {
  it("reads the due's state", async () => {
    const s = await setup();
    await s.exec(ask());
    const out = await s.exec({ id: "check", type: "payment_status", config: { link: "ask" } });
    expect(out.output).toMatchObject({ status: "pending", paid: false, reference: "D-1042" });
  });
});

describe("payment_expire step", () => {
  const expire: Step = { id: "expire", type: "payment_expire", config: { due: "ask" } };

  it("expires the open checkout, cancels the due and releases the booking slot", async () => {
    const s = await setup();
    const [res] = await db.insert(resources).values({ userId: s.userId, name: "Chair 1" }).returning();
    await bookFromStep(db, { workspaceId: s.userId, test: false, runId: s.runId, stepId: "book", workflowId: s.workflowId }, { action: "create", resourceId: res!.id, start: new Date(Date.now() + 86_400_000), minutes: 60, timezone: "Asia/Manila" });
    await s.exec(ask({ checkout: true, booking: "book" }));
    const first = await s.exec(expire);
    const again = await s.exec(expire);
    expect(first).toMatchObject({ branch: "expired", output: { status: "cancelled", bookingReleased: true } });
    expect(again.branch).toBe("expired");
    expect(expired).toContain(sessions.at(-1)!.id);
    const [p] = await db.select().from(payments).where(eq(payments.runId, s.runId));
    expect(p!.status).toBe("expired");
  });

  it("keeps the order while PayMongo is taking a payment", async () => {
    const s = await setup();
    await s.exec(ask({ checkout: true }));
    busy = true;
    try {
      expect((await s.exec(expire)).branch).toBe("kept");
    } finally {
      busy = false;
    }
    const [due] = await db.select().from(paymentDues).where(eq(paymentDues.runId, s.runId));
    expect(due!.status).toBe("pending");
  });
});
