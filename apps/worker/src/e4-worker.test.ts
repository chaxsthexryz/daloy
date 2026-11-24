import { generateKeyPairSync, randomBytes } from "node:crypto";
import { deliveries, runDueDeliveries, runs, saveConnection, stepRuns, users, workflows, workflowVersions, type Db, type ProviderUrls } from "@daloy/db";
import { asc, eq } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { advance, type AdvanceDeps } from "./advance";
import { createExecutor } from "./steps";

const key = randomBytes(32);
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let userId: string;
let sheetRows: string[][];

const serviceAccount = (email: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fake.addServiceAccount(email, publicKey.export({ type: "spki", format: "pem" }).toString());
  return { client_email: email, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
};

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  urls = { ...fake.urls, timeoutMs: 500 };
  const [u] = await db.insert(users).values({ email: "e4@test.local", passwordHash: "x" }).returning();
  userId = u!.id;
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

beforeEach(async () => {
  await db.delete(deliveries);
  const sheet = fake.addSheet("sheet-e4", "Orders", "Items", ["sheets@e4.iam.gserviceaccount.com"]);
  sheetRows = sheet.tabs.get("Items")!;
  fake.calls.length = 0;
  await saveConnection(db, key, userId, "google_sheets", {
    account: "sheets@e4.iam.gserviceaccount.com",
    credential: JSON.stringify(serviceAccount("sheets@e4.iam.gserviceaccount.com")),
    destination: { spreadsheetId: "sheet-e4", tab: "Items", title: "Orders" },
  });
});

let seq = 0;
async function runFlowToEnd(definition: object, triggerPayload: object = {}, opts: { test?: boolean; live?: boolean; testChoices?: Record<string, object> } = {}) {
  const [wf] = await db.insert(workflows).values({ userId, name: "e4", slug: `e4-${++seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload, ...opts }).returning();
  const executor = createExecutor({
    db,
    secretsKey: key,
    mail: {
      installation: { transport: nodemailer.createTransport({ jsonTransport: true }) as unknown as Transporter, from: "kymavo@example.com" },
      gmail: () => {
        throw new Error("no gmail");
      },
      sharedMail: "open",
    },
    urls,
  });
  let queued = true;
  const deps: AdvanceDeps = {
    db,
    executor,
    owner: "e4-test",
    leaseMs: 5000,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
    enqueue: async (_id, startAfter) => {
      if (startAfter) {
        const wait = startAfter.getTime() - Date.now();
        if (wait > 0) await new Promise((res) => setTimeout(res, wait + 5));
      }
      queued = true;
    },
  };
  for (let i = 0; i < 20 && queued; i++) {
    queued = false;
    await advance(deps, r!.id);
  }
  const [finalRun] = await db.select().from(runs).where(eq(runs.id, r!.id));
  const steps = await db.select().from(stepRuns).where(eq(stepRuns.runId, r!.id)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));
  return { run: finalRun!, steps };
}

describe("E4 worker execution", () => {
  it("routes multi-way switch branches and falls back to default", async () => {
    const def = {
      trigger: { type: "manual", config: {} },
      steps: [
        {
          id: "route",
          type: "switch",
          config: {
            value: "{{trigger.kind}}",
            cases: [
              { label: "billing", equals: "billing" },
              { label: "vip_num", equals: 1 },
            ],
          },
        },
        { id: "bill_step", type: "transform", config: { op: "uppercase", value: "billing" } },
        { id: "vip_step", type: "transform", config: { op: "uppercase", value: "vip" } },
        { id: "fallback", type: "transform", config: { op: "uppercase", value: "other" } },
      ],
      edges: [
        { from: "route", to: "bill_step", on: "billing" },
        { from: "route", to: "vip_step", on: "vip_num" },
        { from: "route", to: "fallback", on: "default" },
      ],
    };

    const r1 = await runFlowToEnd(def, { kind: "billing" });
    expect(r1.run.state).toBe("succeeded");
    expect(r1.steps.map((s) => [s.stepId, s.branch])).toEqual([
      ["route", "billing"],
      ["bill_step", null],
    ]);

    const r2 = await runFlowToEnd(def, { kind: "1" });
    expect(r2.steps.map((s) => s.stepId)).toEqual(["route", "vip_step"]);

    const r3 = await runFlowToEnd(def, { kind: "unknown" });
    expect(r3.steps.map((s) => [s.stepId, s.branch])).toEqual([
      ["route", "default"],
      ["fallback", null],
    ]);
    expect(r3.steps[0]!.output).toEqual({ value: "unknown", branch: "default", matched: false });
  });

  it("runs deterministic transform steps and passes outputs downstream", async () => {
    const def = {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "peso", type: "transform", config: { op: "format_peso", value: "{{trigger.total}}" } },
        { id: "phone", type: "transform", config: { op: "normalize_phone", value: "{{trigger.mobile}}" } },
        { id: "when", type: "transform", config: { op: "format_date", value: "{{trigger.at}}", timezone: "Asia/Manila", format: "datetime" } },
        {
          id: "summary",
          type: "transform",
          config: {
            op: "pick",
            fields: {
              amount: "{{steps.peso.output.result}}",
              phone: "{{steps.phone.output.result}}",
              time: "{{steps.when.output.result}}",
            },
          },
        },
      ],
      edges: [
        { from: "peso", to: "phone" },
        { from: "phone", to: "when" },
        { from: "when", to: "summary" },
      ],
    };
    const res = await runFlowToEnd(def, { total: "2450.5", mobile: "0917-555-1234", at: "2027-01-20T06:00:00Z" });
    expect(res.run.state).toBe("succeeded");
    expect(res.steps.at(-1)!.output).toEqual({
      amount: "PHP 2,450.50",
      phone: "+639175551234",
      time: "2027-01-20 14:00",
    });
  });

  it("applies onError skip: stores error info on step output and follows the default edge", async () => {
    const def = {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "bad_phone", type: "transform", onError: "skip", config: { op: "normalize_phone", value: "{{trigger.phone}}" } },
        { id: "after", type: "transform", config: { op: "pick", fields: { err: "{{steps.bad_phone.output.error}}", skipped: "{{steps.bad_phone.output.skipped}}" } } },
      ],
      edges: [{ from: "bad_phone", to: "after" }],
    };
    const res = await runFlowToEnd(def, { phone: "not-a-phone" });
    expect(res.run.state).toBe("succeeded");
    expect(res.steps[0]!.state).toBe("skipped");
    expect(res.steps[0]!.output).toMatchObject({ skipped: true, error: expect.stringMatching(/Philippine mobile/) });
    expect(res.steps[1]!.output).toEqual({ err: expect.stringMatching(/Philippine mobile/), skipped: true });
  });

  it("applies onError failed_edge: routes to on=failed edge, and fails normally when no failed edge is wired", async () => {
    const def = {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "bad_peso", type: "transform", onError: "failed_edge", config: { op: "format_peso", value: "{{trigger.amount}}" } },
        { id: "ok_next", type: "transform", config: { op: "uppercase", value: "ok" } },
        { id: "recover", type: "transform", config: { op: "pick", fields: { reason: "{{steps.bad_peso.output.error}}" } } },
      ],
      edges: [
        { from: "bad_peso", to: "ok_next" },
        { from: "bad_peso", to: "recover", on: "failed" },
      ],
    };
    const failedRes = await runFlowToEnd(def, { amount: "nope" });
    expect(failedRes.run.state).toBe("succeeded");
    expect(failedRes.steps.map((s) => [s.stepId, s.state, s.branch])).toEqual([
      ["bad_peso", "failed", "failed"],
      ["recover", "succeeded", null],
    ]);
    expect(failedRes.steps[1]!.output).toEqual({ reason: expect.stringMatching(/peso/) });

    const okRes = await runFlowToEnd(def, { amount: "500" });
    expect(okRes.run.state).toBe("succeeded");
    expect(okRes.steps.map((s) => s.stepId)).toEqual(["bad_peso", "ok_next"]);

    const unwired = {
      trigger: { type: "manual", config: {} },
      steps: [{ id: "bad_peso", type: "transform", onError: "failed_edge", config: { op: "format_peso", value: "nope" } }],
      edges: [],
    };
    const unwiredRes = await runFlowToEnd(unwired);
    expect(unwiredRes.run.state).toBe("failed");
  });

  it("batches Sheets for_each rows in one batchUpdate, writes header once per tab, enforces 100-row cap, and reconciles marker on retry", async () => {
    const def = {
      trigger: { type: "manual", config: {} },
      steps: [
        {
          id: "log_items",
          type: "sheets",
          config: {
            rows: "{{trigger.items}}",
            columns: ["{{trigger.order}}", "{{index}}", "{{item.sku}}", "{{item.qty}}"],
            header: ["Order", "Index", "SKU", "Qty"],
          },
        },
      ],
      edges: [],
    };

    // First run on empty tab writes header + 2 rows in one batchUpdate.
    const r1 = await runFlowToEnd(def, {
      order: "ORD-1",
      items: [
        { sku: "UBE-1", qty: 2 },
        { sku: "JAM-2", qty: 5 },
      ],
    });
    expect(r1.run.state).toBe("succeeded");
    expect(r1.steps[0]!.output).toMatchObject({ rows: 2, state: "queued" });

    // Simulate ambiguous timeout after Google applied the batch; retry must reconcile by marker without duplicating header or rows.
    fake.once(":batchUpdate", "hang-after");
    await runDueDeliveries(db, key, urls);
    expect(sheetRows).toEqual([
      ["Order", "Index", "SKU", "Qty"],
      ["ORD-1", "0", "UBE-1", "2"],
      ["ORD-1", "1", "JAM-2", "5"],
    ]);
    await db.update(deliveries).set({ nextAttemptAt: new Date(0) });
    await runDueDeliveries(db, key, urls);
    expect(sheetRows).toHaveLength(3);

    // Second run on non-empty tab must NOT write the header row again.
    const r2 = await runFlowToEnd(def, { order: "ORD-2", items: [{ sku: "CAP-3", qty: 1 }] });
    expect(r2.run.state).toBe("succeeded");
    await runDueDeliveries(db, key, urls);
    expect(sheetRows).toEqual([
      ["Order", "Index", "SKU", "Qty"],
      ["ORD-1", "0", "UBE-1", "2"],
      ["ORD-1", "1", "JAM-2", "5"],
      ["ORD-2", "0", "CAP-3", "1"],
    ]);

    // Over 100 rows is refused cleanly.
    const tooMany = await runFlowToEnd(def, { order: "ORD-3", items: Array.from({ length: 101 }, (_, i) => ({ sku: `S-${i}`, qty: 1 })) });
    expect(tooMany.run.state).toBe("failed");
    expect(tooMany.run.error).toMatch(/at most 100 rows/);

    // Empty list skips without queueing a delivery.
    const empty = await runFlowToEnd(def, { order: "ORD-4", items: [] });
    expect(empty.run.state).toBe("succeeded");
    expect(empty.steps[0]!.output).toMatchObject({ rows: 0 });
  });
});
