import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encryptSecret, runs, secrets, users, workflows, workflowVersions, workspaceMembers, type Db } from "@daloy/db";
import type { Step } from "@daloy/engine";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { createExecutor } from "./index";

// The lalamove step (L1, decision 0141) against a small fake Lalamove. Nothing here reaches the real API.
const key = randomBytes(32);
const NO_STEP_RUN = "00000000-0000-0000-0000-000000000000";
let db: Db;
let pool: Pool;
let fake: Server;
const calls: { path: string; body: { data: Record<string, unknown> } }[] = [];

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      calls.push({ path: req.url ?? "", body: JSON.parse(raw) as { data: Record<string, unknown> } });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v3/quotations") return res.writeHead(201).end(JSON.stringify({ data: { quotationId: "Q9", stops: [{ stopId: "P1" }, { stopId: "D1" }], priceBreakdown: { total: "135", currency: "PHP" } } }));
      res.writeHead(201).end(JSON.stringify({ data: { orderId: "O9", status: "ASSIGNING_DRIVER", shareLink: "https://share.lalamove.com/?PH9", priceBreakdown: { total: "135", currency: "PHP" } } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  vi.stubEnv("LALAMOVE_API_URL", `http://127.0.0.1:${(fake.address() as AddressInfo).port}`);
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  fake.close();
  await pool?.end();
});

async function setup(saved: Record<string, string> = { lalamove_api_key: "pk_test_abc", lalamove_api_secret: "sk_test_xyz" }) {
  const [u] = await db.insert(users).values({ email: `seller-${randomUUID()}@test.local`, passwordHash: "x" }).returning();
  await db.insert(workspaceMembers).values({ userId: u!.id, workspaceId: u!.id, role: "owner" });
  for (const [name, value] of Object.entries(saved)) await db.insert(secrets).values({ userId: u!.id, name, ...encryptSecret(key, u!.id, name, value) });
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Rider", slug: `rider-${randomUUID().slice(0, 8)}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
  const trigger = { order_id: "1042", customer_name: "Juan dela Cruz", phone: "0918 123 4567", address: "45 Kalayaan Ave, Quezon City", lat: "14.6507", lng: "121.0494" };
  const exec = (step: Step, opts: { mock?: boolean; test?: boolean } = {}) =>
    createExecutor({ db, secretsKey: key, mail: {} as never, publicUrl: "https://kymavo.test" }).execute({ runId: r!.id, stepRunId: NO_STEP_RUN, userId: u!.id, workflowId: wf!.id, step, attempt: 1, idempotencyKey: `${r!.id}:${step.id}`, ctx: { trigger, steps: {} }, ...opts });
  return { runId: r!.id, exec };
}

const book = (over: Partial<Extract<Step, { type: "lalamove" }>["config"]> = {}): Step => ({
  id: "book_rider",
  type: "lalamove",
  config: {
    serviceType: "MOTORCYCLE",
    pickupAddress: "Unit 1, 123 Shaw Blvd, Mandaluyong",
    pickupLat: "14.5794",
    pickupLng: "121.0359",
    senderName: "Tindahan ni Aling Rosa",
    senderPhone: "09171234567",
    dropoffAddress: "{{trigger.address}}",
    dropoffLat: "{{trigger.lat}}",
    dropoffLng: "{{trigger.lng}}",
    recipientName: "{{trigger.customer_name}}",
    recipientPhone: "{{trigger.phone}}",
    remarks: "Order {{trigger.order_id}}",
    live: false,
    ...over,
  },
});

describe("lalamove step", () => {
  it("gets a sandbox quotation, then places the order with the quotation's stops", async () => {
    const s = await setup();
    calls.length = 0;
    const out = await s.exec(book());
    expect(calls.map((c) => c.path)).toEqual(["/v3/quotations", "/v3/orders"]);
    expect(calls[1]!.body.data).toEqual({
      quotationId: "Q9",
      sender: { stopId: "P1", name: "Tindahan ni Aling Rosa", phone: "+639171234567" },
      recipients: [{ stopId: "D1", name: "Juan dela Cruz", phone: "+639181234567", remarks: "Order 1042" }],
      metadata: { kymavo_run: s.runId, kymavo_step: "book_rider" },
    });
    expect(out.output).toEqual({ orderId: "O9", status: "ASSIGNING_DRIVER", shareLink: "https://share.lalamove.com/?PH9", total: "135", currency: "PHP", quotationId: "Q9", live: false });
  });

  it("a sample run and a test run use a fake, read no keys and never reach the network", async () => {
    const s = await setup({});
    calls.length = 0;
    for (const opts of [{ mock: true }, { test: true }, { mock: true, test: true }]) {
      const out = await s.exec(book({ live: true }), opts);
      expect(out.output).toMatchObject({ mocked: true, live: true, orderId: "sample-order", shareLink: "" });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a live key unless the step says live: true, before any request", async () => {
    const s = await setup({ lalamove_api_key: "pk_prod_abc", lalamove_api_secret: "sk_prod_xyz" });
    calls.length = 0;
    await expect(s.exec(book())).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/live/) });
    expect(calls).toEqual([]);
  });

  it("refuses a sandbox key on a live step, so live: true never quietly books nothing", async () => {
    const s = await setup();
    calls.length = 0;
    await expect(s.exec(book({ live: true }))).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/sandbox key/) });
    expect(calls).toEqual([]);
  });

  it("asks for the secrets, a coordinate and a mobile number before any request", async () => {
    calls.length = 0;
    await expect((await setup({})).exec(book())).rejects.toThrow(/lalamove_api_key and lalamove_api_secret/);
    const s = await setup();
    await expect(s.exec(book({ dropoffLat: "north" }))).rejects.toThrow(/Drop-off latitude/);
    await expect(s.exec(book({ recipientPhone: "12345" }))).rejects.toThrow(/Recipient mobile/);
    expect(calls).toEqual([]);
  });
});
