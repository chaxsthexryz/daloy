import { createHmac, randomBytes } from "node:crypto";
import { connections, deliveries, runDueDeliveries, runs, users, workflowVersions, type Db } from "@daloy/db";
import { StepError } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createExecutor } from "../../worker/src/steps";
import { createApp } from "./app";

const SHOP = "tindahan-ni-ana.myshopify.com";
const TOKEN = "shpat_api_token_synthetic_0001"; // gitleaks:allow
const SECRET = "shpss_api_secret_synthetic_0001"; // gitleaks:allow

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let seq = 0;
const secretsKey = randomBytes(32);

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  // The worker reads provider addresses from the environment, like the PayMongo step does.
  vi.stubEnv("SHOPIFY_API_URL", fake.urls.shopify);
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "https://daloy.test", providers: { ...fake.urls, timeoutMs: 2000 } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

beforeEach(() => {
  fake.shopify.token = TOKEN;
  fake.shopify.shopDomain = SHOP;
  fake.shopify.scopes = ["read_orders", "write_products"];
  fake.shopify.products.length = 0;
  fake.shopify.webhooks.length = 0;
  fake.shopify.issued.clear();
  fake.shopify.tokenCalls = 0;
  fake.shopify.calls.length = 0;
  fake.shopify.forced.length = 0;
  fake.shopify.denyWebhooks = false;
});

type Agent = ReturnType<typeof request.agent>;

async function owner() {
  const email = `shopify-api-${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201); // gitleaks:allow
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id };
}

async function connectShopify(agent: Agent, userId: string, overrides: Record<string, unknown> = {}) {
  const res = await agent.put("/settings/connections/shopify").send({ shop: SHOP, accessToken: TOKEN, appSecret: SECRET, ...overrides });
  const [c] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, "shopify")));
  return { res, webhookPath: (c?.destination as { webhookPath?: string } | null)?.webhookPath ?? "" };
}

async function publishOrderWorkflow(agent: Agent, steps?: unknown[]) {
  const wf = await agent.post("/workflows").send({ name: `Shopify WF ${++seq}`, slug: `shopify-wf-${seq}` }).expect(201);
  const definition = { trigger: { type: "shopify_order", config: {} }, steps: steps ?? [{ id: "wait", type: "delay", config: { seconds: 1 } }], edges: [] };
  const res = await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true });
  return { id: wf.body.id as string, res };
}

const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("base64");
const order = (over: Record<string, unknown> = {}) => ({
  // eslint-disable-next-line no-loss-of-precision -- Shopify sends ids past 2^53 as JSON numbers, which is what the parser must cope with
  id: 820982911946154508,
  admin_graphql_api_id: "gid://shopify/Order/820982911946154508",
  name: "#1001",
  order_number: 1001,
  email: "ana@example.test",
  phone: null,
  total_price: "1250.50",
  currency: "PHP",
  created_at: "2026-11-22T09:15:00+08:00",
  customer: { first_name: "Ana", last_name: "Reyes", phone: "+639171234567" },
  line_items: [{ title: "Tote bag", variant_title: "Blue", quantity: 2, price: "500.00", sku: "TOTE-BLU" }],
  ...over,
});
type Delivery = { body?: string; id?: string; topic?: string; shop?: string; signature?: string | null; secret?: string };
function deliver(path: string, d: Delivery = {}) {
  const body = d.body ?? JSON.stringify(order());
  const req = request(server).post(`/hooks/shopify/${path}`).set("content-type", "application/json");
  req.set("x-shopify-topic", d.topic ?? "orders/create").set("x-shopify-shop-domain", d.shop ?? SHOP);
  if (d.id !== null) req.set("x-shopify-webhook-id", d.id ?? `wh-${++seq}`);
  if (d.signature !== null) req.set("x-shopify-hmac-sha256", d.signature ?? sign(body, d.secret));
  return req.send(body);
}
const runsOf = async (workflowId: string) => {
  const vs = await db.select({ id: workflowVersions.id }).from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId));
  return db.select().from(runs).where(inArray(runs.workflowVersionId, vs.map((v) => v.id)));
};

describe("Shopify connection", () => {
  it("connects, checks with one read call, registers orders/create, and never echoes the secrets", async () => {
    const o = await owner();
    const { res, webhookPath } = await connectShopify(o.agent, o.userId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "active", webhookUrl: `https://daloy.test/hooks/shopify/${webhookPath}`, webhook: { state: "registered" }, shop: "Tindahan ni Ana", missingScopes: [] });
    expect(webhookPath).toHaveLength(43);
    expect(fake.shopify.calls[0]).toBe("shop");
    expect(fake.shopify.webhooks).toEqual([expect.objectContaining({ topic: "ORDERS_CREATE", uri: `https://daloy.test/hooks/shopify/${webhookPath}` })]);
    const listed = await o.agent.get("/settings/connections").expect(200);
    for (const text of [JSON.stringify(res.body), JSON.stringify(listed.body)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(SECRET);
    }
    expect(listed.body.connections.find((c: { provider: string }) => c.provider === "shopify")).toMatchObject({ account: SHOP, authMethod: "token" });
    const [row] = await db.select().from(connections).where(and(eq(connections.userId, o.userId), eq(connections.provider, "shopify")));
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it("accepts a pasted admin link and refuses any other host", async () => {
    const o = await owner();
    expect((await connectShopify(o.agent, o.userId, { shop: `https://${SHOP}/admin/settings/apps` })).res.status).toBe(200);
    for (const shop of ["evil.example.com", `${SHOP}.evil.test`, `${SHOP}:8443`, "http://127.0.0.1", "", "https://x@tindahan.myshopify.com"]) {
      const res = (await connectShopify(o.agent, o.userId, { shop })).res;
      expect([shop, res.status]).toEqual([shop, 400]);
    }
  });

  it("connects a Dev Dashboard app with its client ID and secret, and stores no access token", async () => {
    const o = await owner();
    const dev = { accessToken: undefined, clientId: fake.shopify.clientId, appSecret: fake.shopify.clientSecret };
    const { res, webhookPath } = await connectShopify(o.agent, o.userId, dev);
    expect(res.status).toBe(200);
    expect(res.body.webhook).toEqual({ state: "registered" });
    expect(fake.shopify.tokenCalls).toBe(1);
    expect(fake.shopify.webhooks.map((w) => w.uri)).toEqual([`https://daloy.test/hooks/shopify/${webhookPath}`]);
    const issued = [...fake.shopify.issued];
    const [row] = await db.select().from(connections).where(and(eq(connections.userId, o.userId), eq(connections.provider, "shopify")));
    const listed = await o.agent.get("/settings/connections").expect(200);
    for (const text of [JSON.stringify(row), JSON.stringify(res.body), JSON.stringify(listed.body)]) {
      expect(text).not.toContain(fake.shopify.clientSecret);
      for (const t of issued) expect(text).not.toContain(t);
    }
    // Signed with the client secret, like Shopify signs for an app made in the Dev Dashboard.
    expect((await deliver(webhookPath, { secret: fake.shopify.clientSecret }).expect(200)).body.ok).toBe(true);
  });

  it("refuses a wrong client secret, both kinds of credential at once, and another app without its own secret", async () => {
    const o = await owner();
    const bad = await connectShopify(o.agent, o.userId, { accessToken: undefined, clientId: fake.shopify.clientId, appSecret: "not-the-client-secret" });
    expect([bad.res.status, /client ID and secret/.test(bad.res.body.message)]).toEqual([400, true]);
    expect((await connectShopify(o.agent, o.userId, { clientId: fake.shopify.clientId })).res.status).toBe(400);
    await connectShopify(o.agent, o.userId);
    // The saved secret belongs to the older app, so switching to a Dev Dashboard app needs that app's own secret.
    const sw = await connectShopify(o.agent, o.userId, { accessToken: undefined, clientId: fake.shopify.clientId, appSecret: undefined });
    expect(sw.res.status).toBe(400);
  });

  it("refuses a token Shopify rejects, and saves nothing", async () => {
    const o = await owner();
    const { res } = await connectShopify(o.agent, o.userId, { accessToken: "shpat_wrong_token_value_0000" }); // gitleaks:allow
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/access token/i);
    expect(await db.select().from(connections).where(eq(connections.userId, o.userId))).toHaveLength(0);
    expect(fake.shopify.webhooks).toHaveLength(0);
  });

  it("needs the app secret the first time, and keeps it and the webhook path when the token is replaced", async () => {
    const o = await owner();
    expect((await connectShopify(o.agent, o.userId, { appSecret: undefined })).res.status).toBe(400);
    const first = await connectShopify(o.agent, o.userId);
    fake.shopify.token = "shpat_rotated_token_0002"; // gitleaks:allow
    const second = await connectShopify(o.agent, o.userId, { accessToken: "shpat_rotated_token_0002", appSecret: undefined }); // gitleaks:allow
    expect(second.res.status).toBe(200);
    expect(second.webhookPath).toBe(first.webhookPath);
    expect(fake.shopify.webhooks).toHaveLength(1);
    const hook = await deliver(second.webhookPath).expect(200);
    expect(hook.body.ok).toBe(true);
  });

  it("saves the connection when Shopify refuses the webhook, and says why", async () => {
    const o = await owner();
    fake.shopify.denyWebhooks = true;
    const { res } = await connectShopify(o.agent, o.userId);
    expect(res.status).toBe(200);
    expect(res.body.webhook.state).toBe("failed");
    expect(res.body.webhook.message).toMatch(/read_orders/);
    const listed = await o.agent.get("/settings/connections").expect(200);
    expect(listed.body.connections.find((c: { provider: string }) => c.provider === "shopify").destination.webhook).toBe("failed");
  });

  it("lists the scopes the app is missing without refusing the connection", async () => {
    const o = await owner();
    fake.shopify.scopes = ["read_orders"];
    const { res } = await connectShopify(o.agent, o.userId);
    expect(res.status).toBe(200);
    expect(res.body.missingScopes).toEqual(["write_products"]);
  });

  it("tests with a read, marks a rejected token as failed, and disconnecting removes kymavo's webhook", async () => {
    const o = await owner();
    await connectShopify(o.agent, o.userId);
    const ok = await o.agent.post("/settings/connections/shopify/test").expect(200);
    expect(ok.body).toMatchObject({ ok: true, shop: "Tindahan ni Ana" });
    fake.shopify.webhooks.push({ id: "gid://shopify/WebhookSubscription/9", topic: "ORDERS_CREATE", uri: "https://owner.example.test/own-hook" });
    await o.agent.delete("/settings/connections/shopify").expect(204);
    expect(fake.shopify.webhooks.map((w) => w.uri)).toEqual(["https://owner.example.test/own-hook"]);
    await connectShopify(o.agent, o.userId);
    fake.shopify.token = "shpat_changed_in_shopify_0003"; // gitleaks:allow
    const bad = await o.agent.post("/settings/connections/shopify/test").expect(200);
    expect(bad.body.ok).toBe(false);
    expect(JSON.stringify(bad.body)).not.toContain(TOKEN);
    const [c] = await db.select().from(connections).where(and(eq(connections.userId, o.userId), eq(connections.provider, "shopify")));
    expect(c!.status).toBe("failed");
  });

  it("will not turn on a workflow with the Shopify trigger or a product step before Shopify is connected", async () => {
    const o = await owner();
    const trig = await publishOrderWorkflow(o.agent);
    expect(trig.res.status).toBe(400);
    expect(trig.res.body.message).toMatch(/Connect Shopify/);
    await connectShopify(o.agent, o.userId);
    expect((await publishOrderWorkflow(o.agent)).res.status).toBe(201);
    const wf = await o.agent.post("/workflows").send({ name: "Product", slug: `shopify-product-${++seq}` }).expect(201);
    const def = { trigger: { type: "manual", config: {} }, steps: [{ id: "make", type: "shopify_create_product", config: { title: "Tote" } }], edges: [] };
    await o.agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: def, publish: true }).expect(201);
  });
});

describe("Shopify order webhook", () => {
  it("starts a run with the order mapped to trigger fields, and the run never holds a secret", async () => {
    const o = await owner();
    const { webhookPath } = await connectShopify(o.agent, o.userId);
    const wf = await publishOrderWorkflow(o.agent);
    const res = await deliver(webhookPath).expect(200);
    expect(res.body).toMatchObject({ ok: true, started: 1 });
    const [run] = await runsOf(wf.id);
    expect(run!.triggerPayload).toEqual({
      order_id: "820982911946154508",
      order_number: "#1001",
      customer_name: "Ana Reyes",
      customer_email: "ana@example.test",
      customer_phone: "+639171234567",
      total: "1250.50",
      currency: "PHP",
      financial_status: "",
      created_at: "2026-11-22T09:15:00+08:00",
      shop: SHOP,
      item_count: 2,
      items: "2 x Tote bag (Blue) [TOTE-BLU]",
      line_items: [{ title: "Tote bag", variant_title: "Blue", quantity: 2, price: "500.00", sku: "TOTE-BLU" }],
    });
    expect(JSON.stringify(run)).not.toContain(SECRET);
  });

  it("refuses a bad, missing or tampered signature, and an unknown path", async () => {
    const o = await owner();
    const { webhookPath } = await connectShopify(o.agent, o.userId);
    const wf = await publishOrderWorkflow(o.agent);
    await deliver(webhookPath, { secret: "another_secret_value_123" }).expect(401);
    await deliver(webhookPath, { signature: null }).expect(401);
    await deliver(webhookPath, { signature: "not base64" }).expect(401);
    const body = JSON.stringify(order());
    await deliver(webhookPath, { body: body.replace("1250.50", "0.01"), signature: sign(body) }).expect(401);
    // A body that is signed with the wrong secret is refused whatever it says.
    await deliver(webhookPath, { body: JSON.stringify(order({ total_price: "0.01" })), secret: "x".repeat(20) }).expect(401);
    await deliver("unknown-path-does-not-exist").expect(403);
    expect(await runsOf(wf.id)).toHaveLength(0);
  });

  it("starts one run per order: a replay, or a retry with a new webhook id, answers 200 and starts nothing", async () => {
    const o = await owner();
    const { webhookPath } = await connectShopify(o.agent, o.userId);
    const wf = await publishOrderWorkflow(o.agent);
    const body = JSON.stringify(order());
    const first = await deliver(webhookPath, { body, id: "wh-replay-1" }).expect(200);
    expect(first.body.started).toBe(1);
    for (let i = 0; i < 3; i++) expect((await deliver(webhookPath, { body, id: "wh-replay-1" }).expect(200)).body.started).toBe(0);
    expect((await deliver(webhookPath, { body, id: "wh-replay-1b" }).expect(200)).body.started).toBe(0);
    expect(await runsOf(wf.id)).toHaveLength(1);
    // A different delivery of another order is a new run.
    await deliver(webhookPath, { body: JSON.stringify(order({ id: 2, admin_graphql_api_id: "gid://shopify/Order/2", name: "#1002" })), id: "wh-replay-2" }).expect(200);
    expect(await runsOf(wf.id)).toHaveLength(2);
  });

  it("de-duplicates concurrent deliveries of one order", async () => {
    const o = await owner();
    const { webhookPath } = await connectShopify(o.agent, o.userId);
    const wf = await publishOrderWorkflow(o.agent);
    const body = JSON.stringify(order());
    const answers = await Promise.all(Array.from({ length: 5 }, () => deliver(webhookPath, { body, id: "wh-race-1" })));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(answers.reduce((n, a) => n + (a.body.started as number), 0)).toBe(1);
    expect(await runsOf(wf.id)).toHaveLength(1);
  });

  it("needs a webhook id, refuses another shop, and answers 200 without a run for other topics and bodies that are not orders", async () => {
    const o = await owner();
    const { webhookPath } = await connectShopify(o.agent, o.userId);
    const wf = await publishOrderWorkflow(o.agent);
    await deliver(webhookPath, { id: null as never }).expect(400);
    expect((await deliver(webhookPath, { topic: "orders/paid" }).expect(200)).body.started).toBe(0);
    await deliver(webhookPath, { shop: "another-shop.myshopify.com" }).expect(403);
    await deliver(webhookPath, { shop: "" }).expect(403);
    expect((await deliver(webhookPath, { body: "[]" }).expect(200)).body.started).toBe(0);
    expect(await runsOf(wf.id)).toHaveLength(0);
  });

  it("skips a paused workflow with 200, so Shopify does not drop the webhook", async () => {
    const o = await owner();
    const { webhookPath } = await connectShopify(o.agent, o.userId);
    const wf = await publishOrderWorkflow(o.agent);
    await o.agent.post(`/workflows/${wf.id}/pause`).expect((r) => expect([200, 204]).toContain(r.status));
    expect((await deliver(webhookPath).expect(200)).body.started).toBe(0);
    expect(await runsOf(wf.id)).toHaveLength(0);
  });

  it("does not let one workspace's connection receive another's orders", async () => {
    const a = await owner();
    const b = await owner();
    const pathA = (await connectShopify(a.agent, a.userId)).webhookPath;
    const wfB = await publishOrderWorkflow(b.agent).catch(() => null);
    expect(wfB === null || wfB.res.status === 400).toBe(true);
    const wfA = await publishOrderWorkflow(a.agent);
    await deliver(pathA).expect(200);
    expect(await runsOf(wfA.id)).toHaveLength(1);
  });
});

describe("Shopify product steps as deliveries", () => {
  type Row = typeof deliveries.$inferSelect;
  async function runWith(step: unknown) {
    const o = await owner();
    const { webhookPath } = await connectShopify(o.agent, o.userId);
    const wf = await publishOrderWorkflow(o.agent, [step]);
    await deliver(webhookPath).expect(200);
    const [run] = await runsOf(wf.id);
    const exec = createExecutor({ db, secretsKey, mail: {} as never });
    const go = (s: unknown, attempt = 1) =>
      exec.execute({ runId: run!.id, stepRunId: "00000000-0000-0000-0000-0000000000a1", userId: o.userId, workflowId: wf.id, attempt, idempotencyKey: `${run!.id}:${(s as { id: string }).id}`, step: s as never, ctx: { trigger: run!.triggerPayload, steps: {} } });
    const row = async (stepId: string): Promise<Row> => (await db.select().from(deliveries).where(and(eq(deliveries.runId, run!.id), eq(deliveries.stepId, stepId))))[0]!;
    return { o, go, row, runId: run!.id };
  }
  /** Runs what is queued, with any backoff skipped. */
  const deliverNow = async () => {
    await db.update(deliveries).set({ nextAttemptAt: sql`now()` }).where(eq(deliveries.state, "queued"));
    await runDueDeliveries(db, secretsKey, fake.urls);
  };

  it("queues the product, pinned to the store connected now, and the delivery creates it with the templates filled in", async () => {
    const step = { id: "make", type: "shopify_create_product", config: { title: "Reorder {{trigger.order_number}}", description: "Customer {{trigger.customer_name}}", price: "499.50", sku: "RE-{{trigger.order_id}}", status: "active" } };
    const { go, row } = await runWith(step);
    const out = (await go(step)).output as Record<string, unknown>;
    expect(out).toMatchObject({ deliveryId: expect.any(String), state: "queued" });
    expect(fake.shopify.products).toHaveLength(0);
    expect(await row("make")).toMatchObject({ provider: "shopify", pinnedAccount: SHOP, pinnedDestination: expect.objectContaining({ shop: SHOP }) });
    await deliverNow();
    const p = fake.shopify.products[0]!;
    expect(p).toMatchObject({ title: "Reorder #1001", status: "ACTIVE" });
    expect(p.variants[0]).toMatchObject({ sku: "RE-820982911946154508", price: "499.50" });
    const d = await row("make");
    expect(d.state).toBe("delivered");
    expect(d.result).toMatchObject({ productId: p.id.replace(/\D/g, ""), adminUrl: expect.stringMatching(new RegExp(`^https://${SHOP}/admin/products/\\d+$`)), created: true });
    // A step that runs again gets the same delivery back, so it never queues a second product.
    expect(((await go(step)).output as { deliveryId: string }).deliveryId).toBe(out.deliveryId);
  });

  it("updates by SKU, and fails with the reason when the product is not there", async () => {
    const create = { id: "make", type: "shopify_create_product", config: { title: "Tote", price: "100", sku: "TOTE-1" } };
    const { go, row } = await runWith(create);
    await go(create);
    // Deliveries of one run go independently, in no set order, so the update is queued after the product exists.
    await deliverNow();
    await go({ id: "up", type: "shopify_update_product", config: { by: "sku", product: "TOTE-1", price: "125", status: "active" } });
    await go({ id: "up2", type: "shopify_update_product", config: { by: "sku", product: "NOPE", price: "1" } });
    await deliverNow();
    expect(fake.shopify.products[0]!.variants[0]!.price).toBe("125");
    expect((await row("up")).result).toMatchObject({ created: false, status: "active" });
    const missing = await row("up2");
    expect([missing.state, /NOPE/.test(missing.lastError ?? "")]).toEqual(["failed", true]);
  });

  it("refuses a bad price or image link in the step, before anything is queued", async () => {
    const { go, row } = await runWith({ id: "make", type: "shopify_create_product", config: { title: "x" } });
    for (const config of [{ title: "x", price: "12,50" }, { title: "x", price: "-1" }, { title: "x", imageUrl: "http://insecure.example.test/a.jpg" }, { title: "x", imageUrl: "javascript:alert(1)" }]) {
      const err = (await go({ id: "make", type: "shopify_create_product", config }).catch((e: unknown) => e)) as StepError;
      expect([JSON.stringify(config), err instanceof StepError && !err.retryable]).toEqual([JSON.stringify(config), true]);
    }
    expect(await row("make")).toBeUndefined();
  });

  it("waits and retries when throttled, and holds a create with no SKU for review after an unknown outcome", async () => {
    const step = { id: "make", type: "shopify_create_product", config: { title: "Tote" } };
    const { go, row } = await runWith(step);
    await go(step);
    fake.shopify.forced.push({ status: 200, body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } });
    await runDueDeliveries(db, secretsKey, fake.urls);
    expect(await row("make")).toMatchObject({ state: "queued", errorKind: "quota" });
    fake.shopify.forced.push({ status: 503 });
    await deliverNow();
    const held = await row("make");
    expect([held.state, held.errorKind, /may have saved/.test(held.lastError ?? "")]).toEqual(["needs_review", "ambiguous", true]);
    expect(fake.shopify.products).toHaveLength(0);
  });

  it("retries a create with a SKU after an unknown outcome and finds the product the first attempt made", async () => {
    const step = { id: "make", type: "shopify_create_product", config: { title: "Tote", sku: "TOTE-X", price: "10" } };
    const { go, row } = await runWith(step);
    await go(step);
    // The first attempt's call landed in Shopify but its answer was lost, so the delivery is marked uncertain.
    fake.shopify.products.push({ id: "gid://shopify/Product/555", title: "Tote", descriptionHtml: "", status: "ACTIVE", images: [], variants: [{ id: "gid://shopify/ProductVariant/556", sku: "TOTE-X", price: "10", inventoryItemId: "gid://shopify/InventoryItem/557", tracked: false }] });
    await db.update(deliveries).set({ checkFirst: true }).where(eq(deliveries.id, (await row("make")).id));
    await deliverNow();
    expect(fake.shopify.products.filter((p) => p.variants[0]!.sku === "TOTE-X")).toHaveLength(1);
    expect(await row("make")).toMatchObject({ state: "delivered", result: expect.objectContaining({ productId: "555", reconciled: true }) });
  });

  it("holds a product for review when the store changed after it was queued, and Post again sends it to the new one", async () => {
    const step = { id: "make", type: "shopify_create_product", config: { title: "Tote" } };
    const { o, go, row } = await runWith(step);
    await go(step);
    await connectShopify(o.agent, o.userId, { shop: "another-shop.myshopify.com" });
    await deliverNow();
    const held = await row("make");
    expect([held.state, held.errorKind]).toEqual(["needs_review", "destination_changed"]);
    expect(fake.shopify.products).toHaveLength(0);
    await o.agent.post(`/deliveries/${held.id}/retry`).send({ postAgain: true }).expect(204);
    await deliverNow();
    expect((await row("make")).state).toBe("delivered");
    expect(fake.shopify.products).toHaveLength(1);
  });

  it("fails with not connected after a disconnect, and Retry works once Shopify is back", async () => {
    const step = { id: "make", type: "shopify_create_product", config: { title: "Tote" } };
    const { o, go, row } = await runWith(step);
    await o.agent.delete("/settings/connections/shopify").expect(204);
    await go(step);
    await deliverNow();
    const failed = await row("make");
    expect([failed.state, /not connected/.test(failed.lastError ?? "")]).toEqual(["failed", true]);
    await connectShopify(o.agent, o.userId);
    await o.agent.post(`/deliveries/${failed.id}/retry`).send({}).expect(204);
    await deliverNow();
    expect((await row("make")).state).toBe("delivered");
  });

  it("never puts the token or secret in run history, deliveries or their list", async () => {
    const step = { id: "make", type: "shopify_create_product", config: { title: "Tote" } };
    const { o, go, row, runId } = await runWith(step);
    await go(step);
    fake.shopify.token = "shpat_changed_in_shopify_0004"; // gitleaks:allow
    await deliverNow();
    const d = await row("make");
    expect(d.state).toBe("failed");
    const listed = await o.agent.get(`/deliveries?runId=${runId}`).expect(200);
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    for (const text of [JSON.stringify(d), JSON.stringify(listed.body), JSON.stringify(run)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(SECRET);
    }
  });
});

describe("Shopify webhook rate limit", () => {
  it("answers 429 after 60 calls a minute from one address", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 65; i++) codes.push((await request(server).post("/hooks/shopify/no-such-path").set("content-type", "application/json").send("{}")).status);
    expect(codes).toContain(429);
  });
});
