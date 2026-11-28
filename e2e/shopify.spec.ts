import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

type Control = { shopifyProducts: { id: string; title: string; status: string; variants: { sku: string; price: string }[] }[]; shopifyWebhooks: { topic: string; uri: string }[] };
type DeliveryRow = { stepId: string; state: string; result: { productId?: string; adminUrl?: string } | null };
const control = async () => (await (await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`)).json()) as Control;

// Shopify (fake Admin API from e2e/global-setup.ts): connect a Dev Dashboard app in the console, a signed orders/create
// webhook starts a run whose product delivery creates a product, a replay starts nothing, and a second workflow updates it by SKU.
test("an owner connects Shopify, a signed order starts a run that creates and updates a product, and a replay does not repeat it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`shopify-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.locator("#main-menu").getByRole("link", { name: "Apps", exact: true }).click();
  await expect(page.locator("li.directory-row", { hasText: "Facebook Messenger & Instagram" }).locator(".app-mark")).toHaveCount(2);
  await page.getByRole("button", { name: "Connect Shopify" }).click();
  await page.getByLabel("Shop domain").fill(process.env.E2E_SHOPIFY_SHOP!);
  const devRadio = page.getByLabel("In the Dev Dashboard");
  await devRadio.check();
  expect(await devRadio.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(30);
  await expect(page.locator(".setup-pane .field-badge").first()).toHaveText("Required");
  await page.getByLabel("Client ID").fill(process.env.E2E_SHOPIFY_CLIENT_ID!);
  await page.getByLabel("Client secret").fill(process.env.E2E_SHOPIFY_SECRET!);
  await page.getByRole("button", { name: "Connect Shopify" }).click();
  await expect(page.getByText("kymavo registered the new-order webhook in your store.")).toBeVisible();
  const hookUrl = (await page.locator("code", { hasText: "/hooks/shopify/" }).textContent())!;
  expect((await control()).shopifyWebhooks).toContainEqual(expect.objectContaining({ topic: "ORDERS_CREATE", uri: hookUrl }));
  // The secret is never shown again.
  await expect(page.getByText(process.env.E2E_SHOPIFY_SECRET!)).toHaveCount(0);

  const publish = async (name: string, definition: object) => {
    const wf = await (await page.request.post("/workflows", { data: { name, slug: `${name}-${Date.now()}` } })).json();
    expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
    return wf.id as string;
  };
  const sku = `E2E-${Date.now()}`;
  const maker = await publish("shopify-order-to-product", {
    trigger: { type: "shopify_order", config: {} },
    steps: [{ id: "make", type: "shopify_create_product", config: { title: "Reorder {{trigger.order_number}}", description: "For {{trigger.customer_name}}", price: "{{trigger.total}}", sku, status: "active" } }],
    edges: [],
  });

  const orderId = Math.floor(Math.random() * 1e6) + 1000;
  const body = JSON.stringify({ id: orderId, admin_graphql_api_id: `gid://shopify/Order/${orderId}`, name: `#${orderId}`, total_price: "799.00", currency: "PHP", email: "ana@example.test", customer: { first_name: "Ana", last_name: "Reyes" }, line_items: [{ title: "Tote bag", quantity: 1, price: "799.00", sku: "TOTE" }] });
  const webhookId = randomUUID();
  const deliver = async (over: { id?: string; secret?: string } = {}) => {
    const res = await fetch(hookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/create",
        "x-shopify-shop-domain": process.env.E2E_SHOPIFY_SHOP!,
        "x-shopify-webhook-id": over.id ?? webhookId,
        "x-shopify-hmac-sha256": createHmac("sha256", over.secret ?? process.env.E2E_SHOPIFY_SECRET!).update(body).digest("base64"),
      },
      body,
    });
    return { status: res.status, json: (await res.json()) as { started?: number } };
  };
  const makerRuns = async () => ((await (await page.request.get(`/runs?workflowId=${maker}`)).json()) as { id: string; state: string }[]);
  const productDelivery = async (runId: string) => ((await (await page.request.get(`/deliveries?runId=${runId}`)).json()) as DeliveryRow[])[0];

  expect((await deliver({ secret: "a_different_secret_000" })).status).toBe(401);
  expect(await makerRuns()).toHaveLength(0);
  expect(await deliver()).toEqual({ status: 200, json: { ok: true, started: 1 } });
  await expect.poll(async () => (await makerRuns())[0]?.state, { timeout: 30_000 }).toBe("succeeded");
  // The run queued the product; the worker's delivery loop creates it.
  await expect.poll(async () => (await productDelivery((await makerRuns())[0]!.id))?.state, { timeout: 30_000 }).toBe("delivered");
  const made = (await control()).shopifyProducts.filter((p) => p.variants.some((v) => v.sku === sku));
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ title: `Reorder #${orderId}`, status: "ACTIVE" });
  expect(made[0]!.variants[0]!.price).toBe("799.00");

  // The same delivery again (Shopify retries) starts nothing and makes no second product.
  expect((await deliver()).json.started).toBe(0);
  expect(await makerRuns()).toHaveLength(1);
  expect((await control()).shopifyProducts.filter((p) => p.variants.some((v) => v.sku === sku))).toHaveLength(1);

  // Update by SKU from a manual run, then read the delivery's result: product id and admin link.
  const updater = await publish("shopify-update", { trigger: { type: "manual", config: {} }, steps: [{ id: "up", type: "shopify_update_product", config: { by: "sku", product: sku, price: "850", status: "draft" } }], edges: [] });
  const { id: runId } = await (await page.request.post(`/workflows/${updater}/runs`, { data: { payload: {} } })).json();
  await expect.poll(async () => (await productDelivery(runId))?.state, { timeout: 30_000 }).toBe("delivered");
  const output = (await productDelivery(runId))!.result ?? {};
  expect(output.adminUrl).toBe(`https://${process.env.E2E_SHOPIFY_SHOP}/admin/products/${output.productId}`);
  const after = (await control()).shopifyProducts.find((p) => p.variants.some((v) => v.sku === sku))!;
  expect(after).toMatchObject({ status: "DRAFT" });
  expect(after.variants[0]!.price).toBe("850");

  // A faked test run of the product step calls nothing and says so.
  const calls = (await control()).shopifyProducts.length;
  const test1 = await (await page.request.post(`/workflows/${updater}/test-runs`, { data: { definition: { trigger: { type: "manual", config: {} }, steps: [{ id: "make", type: "shopify_create_product", config: { title: "Sample product", sku: `${sku}-T` } }], edges: [] }, payload: {}, mode: "mock" } })).json();
  await expect
    .poll(async () => {
      const run = await (await page.request.get(`/runs/${test1.id}`)).json();
      return run.state;
    }, { timeout: 30_000 })
    .toBe("succeeded");
  expect((await control()).shopifyProducts).toHaveLength(calls);
});
