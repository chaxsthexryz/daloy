import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeShopify } from "../../../test/fake-shopify";
import { ProviderError, type ProviderUrls } from "./providers";
import {
  checkShopifyConnection,
  createShopifyProduct,
  ensureOrderWebhook,
  normalizeShopDomain,
  parseShopifyCredential,
  parseShopifyOrder,
  shopifyConn,
  SHOPIFY_API_VERSION,
  textToHtml,
  updateShopifyProduct,
  verifyShopifyHmac,
} from "./shopify";

const secret = "shopify_app_secret_synthetic_001"; // gitleaks:allow
const sign = (body: string, s = secret) => createHmac("sha256", s).update(body).digest("base64");

describe("normalizeShopDomain", () => {
  it.each([
    ["tindahan-ni-ana.myshopify.com", "tindahan-ni-ana.myshopify.com"],
    ["  Tindahan-Ni-Ana.MyShopify.com ", "tindahan-ni-ana.myshopify.com"],
    ["https://tindahan-ni-ana.myshopify.com", "tindahan-ni-ana.myshopify.com"],
    ["https://tindahan-ni-ana.myshopify.com/admin/settings/apps", "tindahan-ni-ana.myshopify.com"],
    ["a1.myshopify.com", "a1.myshopify.com"],
  ])("accepts %s", (input, shop) => {
    expect(normalizeShopDomain(input)).toBe(shop);
  });
  it.each([
    "",
    "myshopify.com",
    ".myshopify.com",
    "shop.example.com",
    "shop.myshopify.com.evil.test",
    "evil.test/shop.myshopify.com",
    "https://evil.test@shop.myshopify.com",
    "https://user:pw@shop.myshopify.com",
    "shop.myshopify.com:8443",
    "http://127.0.0.1",
    "shop_name.myshopify.com",
    "-shop.myshopify.com",
    "shop-.myshopify.com",
    "sh op.myshopify.com",
    "admin.shopify.com/store/shop",
    "a".repeat(64) + ".myshopify.com",
  ])("rejects %j", (input) => {
    expect(normalizeShopDomain(input)).toBeNull();
  });
});

describe("verifyShopifyHmac", () => {
  const body = '{"id":820982911946154508,"name":"#1001"}';
  it("accepts the base64 HMAC-SHA256 of the exact bytes, as text or Buffer", () => {
    expect(verifyShopifyHmac(body, sign(body), secret)).toBe(true);
    expect(verifyShopifyHmac(Buffer.from(body), sign(body), secret)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyShopifyHmac(body.replace("1001", "1002"), sign(body), secret)).toBe(false);
    expect(verifyShopifyHmac(`${body} `, sign(body), secret)).toBe(false);
  });
  it("rejects a signature made with another secret", () => {
    expect(verifyShopifyHmac(body, sign(body, "another_secret_value_1"), secret)).toBe(false);
  });
  it("fails closed on a missing header, an empty secret and malformed headers", () => {
    expect(verifyShopifyHmac(body, undefined, secret)).toBe(false);
    expect(verifyShopifyHmac(body, "", secret)).toBe(false);
    expect(verifyShopifyHmac(body, sign(body), "")).toBe(false);
    expect(verifyShopifyHmac(body, "not base64 !!", secret)).toBe(false);
    expect(verifyShopifyHmac(body, sign(body).slice(0, -4), secret)).toBe(false);
    expect(verifyShopifyHmac(body, `${sign(body)}AAAA`, secret)).toBe(false);
    // The hex form is not what Shopify sends, so it never passes.
    // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    expect(verifyShopifyHmac(body, createHmac("sha256", secret).update(body).digest("hex"), secret)).toBe(false);
  });
  it("is the same answer for a replay: the check has no clock, the webhook id does the de-duplication", () => {
    expect(verifyShopifyHmac(body, sign(body), secret)).toBe(verifyShopifyHmac(body, sign(body), secret));
  });
});

describe("parseShopifyOrder", () => {
  const order = {
    // eslint-disable-next-line no-loss-of-precision -- Shopify sends ids past 2^53 as JSON numbers, which is what the parser must cope with
    id: 820982911946154508,
    admin_graphql_api_id: "gid://shopify/Order/820982911946154508",
    created_at: "2026-11-22T09:15:00+08:00",
    currency: "PHP",
    email: "ana@example.test",
    phone: null,
    name: "#1001",
    order_number: 1001,
    total_price: "1250.50",
    financial_status: "pending",
    customer: { first_name: "Ana", last_name: "Reyes", email: "ana.customer@example.test", phone: "+639171234567" },
    shipping_address: { name: "Ana R. Reyes", phone: "0917 000 0000" },
    line_items: [
      { title: "Tote bag", variant_title: "Blue", quantity: 2, price: "500.00", sku: "TOTE-BLU" },
      { title: "Sticker", variant_title: null, quantity: 1, price: "250.50", sku: null },
    ],
  };
  it("maps the order number, customer, total and line items", () => {
    expect(parseShopifyOrder(order, "tindahan-ni-ana.myshopify.com")).toEqual({
      order_id: "820982911946154508",
      order_number: "#1001",
      customer_name: "Ana Reyes",
      customer_email: "ana@example.test",
      customer_phone: "+639171234567",
      total: "1250.50",
      currency: "PHP",
      financial_status: "pending",
      created_at: "2026-11-22T09:15:00+08:00",
      shop: "tindahan-ni-ana.myshopify.com",
      item_count: 3,
      items: "2 x Tote bag (Blue) [TOTE-BLU]\n1 x Sticker",
      line_items: [
        { title: "Tote bag", variant_title: "Blue", quantity: 2, price: "500.00", sku: "TOTE-BLU" },
        { title: "Sticker", variant_title: "", quantity: 1, price: "250.50", sku: "" },
      ],
    });
  });
  it("falls back to the shipping or billing name, the customer email and the shipping phone", () => {
    const o = { ...order, email: null, customer: { first_name: null, last_name: null, email: "c@example.test", phone: null }, phone: null };
    const p = parseShopifyOrder(o, "s.myshopify.com")!;
    expect(p.customer_name).toBe("Ana R. Reyes");
    expect(p.customer_email).toBe("c@example.test");
    expect(p.customer_phone).toBe("0917 000 0000");
    const q = parseShopifyOrder({ ...o, customer: null, shipping_address: null, billing_address: { name: "Bea Cruz", phone: "123" } }, "s.myshopify.com")!;
    expect(q.customer_name).toBe("Bea Cruz");
  });
  it("uses order_number when name is missing, and keeps the total as the text Shopify sent", () => {
    const p = parseShopifyOrder({ id: 5, order_number: 1234, total_price: 99.5, line_items: [] }, "s.myshopify.com")!;
    expect(p.order_number).toBe("#1234");
    expect(p.total).toBe("99.5");
    expect(p.items).toBe("");
    expect(p.item_count).toBe(0);
  });
  it("ignores things that are not an order and caps long lists and strings", () => {
    expect(parseShopifyOrder(null, "s.myshopify.com")).toBeUndefined();
    expect(parseShopifyOrder([], "s.myshopify.com")).toBeUndefined();
    expect(parseShopifyOrder({ name: "#1" }, "s.myshopify.com")).toBeUndefined();
    const many = parseShopifyOrder({ id: 1, line_items: Array.from({ length: 80 }, (_, i) => ({ title: `Item ${i}`, quantity: 1 })) }, "s.myshopify.com")!;
    expect(many.line_items).toHaveLength(50);
    expect(many.item_count).toBe(80);
    const long = parseShopifyOrder({ id: 1, customer: { first_name: "x".repeat(500) } }, "s.myshopify.com")!;
    expect(long.customer_name).toHaveLength(200);
  });
});

describe("textToHtml", () => {
  it("escapes markup and keeps line breaks, so trigger data cannot add HTML to the storefront", () => {
    expect(textToHtml('<script>alert(1)</script> & "q"\nline 2')).toBe("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;<br>line 2");
    expect(textToHtml("")).toBe("");
  });
});

describe("parseShopifyCredential", () => {
  it("reads the encrypted JSON and refuses anything else", () => {
    expect(parseShopifyCredential(JSON.stringify({ accessToken: "shpat_x", appSecret: "sec" }))).toEqual({ accessToken: "shpat_x", appSecret: "sec" });
    expect(parseShopifyCredential(JSON.stringify({ clientId: "cid", appSecret: "sec" }))).toEqual({ clientId: "cid", appSecret: "sec" });
    expect(() => parseShopifyCredential("nope")).toThrow(ProviderError);
    expect(() => parseShopifyCredential(JSON.stringify({ accessToken: "x" }))).toThrow(/again/);
  });
});

describe("Shopify Admin API against the fake", () => {
  const fake = createFakeShopify();
  let server: Server;
  let urls: ProviderUrls;
  const conn = () => ({ shop: fake.state.shopDomain, accessToken: fake.state.token });
  const base = { googleToken: "", sheets: "", calendar: "", drive: "", slack: "", telegram: "", airtable: "", notion: "", trello: "" };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (!fake.handle(req, res, new URL(req.url ?? "/", "http://x").pathname, Buffer.concat(chunks).toString())) res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    urls = { ...base, shopify: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 300 };
  });
  afterAll(() => server.close());
  beforeEach(() => {
    fake.state.products.length = 0;
    fake.state.calls.length = 0;
    fake.state.forced.length = 0;
    fake.state.webhooks.length = 0;
    fake.expireTokens();
    fake.state.tokenCalls = 0;
    fake.state.otherOrganization = false;
    fake.state.token = "shpat_fake_token_0001"; // gitleaks:allow
  });

  it("pins the API version the fake speaks", () => {
    expect(SHOPIFY_API_VERSION).toBe("2026-10");
  });

  it("checks the connection with one read call and reports the shop and missing scopes", async () => {
    const ok = await checkShopifyConnection(urls, conn());
    expect(fake.state.calls).toEqual(["shop"]);
    expect(ok).toMatchObject({ name: "Tindahan ni Ana", domain: "tindahan-ni-ana.myshopify.com", missingScopes: [] });
    fake.state.scopes = ["read_orders"];
    expect((await checkShopifyConnection(urls, conn())).missingScopes).toEqual(["write_products"]);
    fake.state.scopes = ["read_orders", "write_products"];
  });

  it("maps errors: wrong token, throttled, no access, frozen shop, unknown store, server error, timeout", async () => {
    const kind = async (f: () => Promise<unknown>) => ((await f().catch((e: unknown) => e)) as ProviderError).kind;
    const read = () => checkShopifyConnection(urls, conn());
    expect(await kind(() => checkShopifyConnection(urls, { ...conn(), accessToken: "wrong" }))).toBe("auth");
    fake.state.forced.push({ status: 200, body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } });
    expect(await kind(read)).toBe("quota");
    fake.state.forced.push({ status: 429, headers: { "retry-after": "3" } });
    const limited = (await read().catch((e: unknown) => e)) as ProviderError;
    expect([limited.kind, limited.retryAfterMs]).toEqual(["quota", 3000]);
    fake.state.forced.push({ status: 200, body: { errors: [{ message: "Access denied for shop field. Required access: `read_products` access scope.", extensions: { code: "ACCESS_DENIED" } }] } });
    const denied = (await read().catch((e: unknown) => e)) as ProviderError;
    expect(denied.kind).toBe("permission");
    expect(denied.message).toMatch(/access scope/i);
    fake.state.forced.push({ status: 402 });
    expect(await kind(read)).toBe("permission");
    fake.state.forced.push({ status: 404 });
    expect(await kind(read)).toBe("invalid");
    fake.state.forced.push({ status: 423 });
    expect(await kind(read)).toBe("unavailable");
    fake.state.forced.push({ status: 503 });
    expect(await kind(read)).toBe("unavailable");
    fake.state.forced.push({ hang: true });
    expect(await kind(read)).toBe("unavailable");
  });

  it("treats a write that fails after it was sent as ambiguous, and a write refused before as not sent", async () => {
    fake.state.forced.push({ status: 503 });
    const err = (await createShopifyProduct(urls, conn(), { title: "Tote" }).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe("ambiguous");
    fake.state.forced.push({ hang: true });
    expect(((await createShopifyProduct(urls, conn(), { title: "Tote" }).catch((e: unknown) => e)) as ProviderError).kind).toBe("ambiguous");
    expect(fake.state.products).toHaveLength(0);
  });

  it("creates a product with price, SKU, status and an image", async () => {
    const out = await createShopifyProduct(urls, conn(), { title: "Tote bag", description: "Canvas <b>bag</b>\nBlue", price: "499.50", sku: "TOTE-BLU", status: "draft", imageUrl: "https://cdn.example.test/tote.jpg" });
    const p = fake.state.products[0]!;
    expect(p).toMatchObject({ title: "Tote bag", status: "DRAFT", descriptionHtml: "Canvas &lt;b&gt;bag&lt;/b&gt;<br>Blue", images: ["https://cdn.example.test/tote.jpg"] });
    expect(p.variants[0]).toMatchObject({ sku: "TOTE-BLU", price: "499.50", tracked: false });
    expect(out).toMatchObject({ productId: fake.numericId(p.id), title: "Tote bag", status: "draft", sku: "TOTE-BLU", created: true });
    expect(out.adminUrl).toBe(`https://tindahan-ni-ana.myshopify.com/admin/products/${out.productId}`);
    expect(fake.state.calls).toEqual(["productVariants", "productCreate", "productVariantsBulkUpdate"]);
  });

  it("creates with only a title: one call, no variant mutation", async () => {
    const out = await createShopifyProduct(urls, conn(), { title: "Plain" });
    expect(fake.state.calls).toEqual(["productCreate"]);
    expect(out).toMatchObject({ status: "active", sku: "" });
  });

  it("refuses a second product with the same SKU, so a retried step cannot make a duplicate", async () => {
    await createShopifyProduct(urls, conn(), { title: "Tote", sku: "TOTE-1" });
    const err = (await createShopifyProduct(urls, conn(), { title: "Tote again", sku: "TOTE-1" }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("invalid");
    expect(err.message).toMatch(/TOTE-1.*already/);
    expect(fake.state.products).toHaveLength(1);
  });

  it("reports Shopify's own refusal (a blank title) as invalid", async () => {
    const err = (await createShopifyProduct(urls, conn(), { title: "  " }).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe("invalid");
    expect(err.message).toMatch(/title/i);
  });

  it("sends a review, not a retry, when the product was made but the price call failed", async () => {
    // The fake refuses a price that is not a number, the way Shopify answers with userErrors.
    const err = (await createShopifyProduct(urls, conn(), { title: "Tote", sku: "T-2", price: "abc" }).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe("review");
    expect(err.message).toMatch(/made the product/i);
    expect(fake.state.products).toHaveLength(1);
  });

  it("on a retry after an unknown outcome, takes the product with that SKU as the one already made", async () => {
    const first = await createShopifyProduct(urls, conn(), { title: "Tote", sku: "T-3", price: "10" });
    fake.state.calls.length = 0;
    const again = await createShopifyProduct(urls, conn(), { title: "Tote", sku: "T-3", price: "10" }, { retrying: true });
    expect(again).toMatchObject({ productId: first.productId, reconciled: true });
    expect(fake.state.calls).toEqual(["productVariants"]);
    expect(fake.state.products).toHaveLength(1);
  });

  describe("update", () => {
    let id: string;
    beforeEach(async () => {
      id = (await createShopifyProduct(urls, conn(), { title: "Tote", price: "100", sku: "TOTE-1" })).productId;
      fake.state.calls.length = 0;
    });

    it("finds by SKU and changes only the chosen fields", async () => {
      const out = await updateShopifyProduct(urls, conn(), { by: "sku", key: "TOTE-1" }, { price: "120.00", status: "draft" });
      const p = fake.state.products[0]!;
      expect(p).toMatchObject({ title: "Tote", status: "DRAFT" });
      expect(p.variants[0]).toMatchObject({ price: "120.00", sku: "TOTE-1" });
      expect(out).toMatchObject({ productId: id, created: false, status: "draft" });
    });

    it("finds by product id (number, GID or admin link) and renames it", async () => {
      for (const key of [id, `gid://shopify/Product/${id}`, `https://tindahan-ni-ana.myshopify.com/admin/products/${id}`]) {
        await updateShopifyProduct(urls, conn(), { by: "id", key }, { title: `Tote ${key.length}` });
        expect(fake.state.products[0]!.title).toBe(`Tote ${key.length}`);
      }
      expect(fake.state.calls).not.toContain("productVariantsBulkUpdate");
    });

    it("changes the SKU and adds an image", async () => {
      await updateShopifyProduct(urls, conn(), { by: "id", key: id }, { sku: "TOTE-2", imageUrl: "https://cdn.example.test/new.jpg" });
      expect(fake.state.products[0]!.variants[0]!.sku).toBe("TOTE-2");
      expect(fake.state.products[0]!.images).toEqual(["https://cdn.example.test/new.jpg"]);
    });

    it("says so when nothing matches, and never guesses between two products with one SKU", async () => {
      const none = (await updateShopifyProduct(urls, conn(), { by: "sku", key: "NOPE" }, { title: "x" }).catch((e: unknown) => e)) as ProviderError;
      expect([none.kind, /NOPE/.test(none.message)]).toEqual(["invalid", true]);
      const gone = (await updateShopifyProduct(urls, conn(), { by: "id", key: "999" }, { title: "x" }).catch((e: unknown) => e)) as ProviderError;
      expect(gone.kind).toBe("invalid");
      fake.state.products.push({ ...structuredClone(fake.state.products[0]!), id: "gid://shopify/Product/777" });
      const two = (await updateShopifyProduct(urls, conn(), { by: "sku", key: "TOTE-1" }, { title: "x" }).catch((e: unknown) => e)) as ProviderError;
      expect([two.kind, /more than one/.test(two.message)]).toEqual(["invalid", true]);
    });

    it("refuses a price change by id when the product has several variants", async () => {
      fake.state.products[0]!.variants.push({ id: "gid://shopify/ProductVariant/9", sku: "TOTE-9", price: "1", inventoryItemId: "gid://shopify/InventoryItem/9", tracked: false });
      const err = (await updateShopifyProduct(urls, conn(), { by: "id", key: id }, { price: "5" }).catch((e: unknown) => e)) as ProviderError;
      expect([err.kind, /variants/.test(err.message)]).toEqual(["invalid", true]);
      expect(fake.state.products[0]!.variants[0]!.price).toBe("100");
    });
  });

  describe("client credentials (an app made in the Dev Dashboard)", () => {
    const cred = () => ({ clientId: fake.state.clientId, appSecret: fake.state.clientSecret });
    it("gets a token once and reuses it until it runs out", async () => {
      const a = await shopifyConn(urls, fake.state.shopDomain, cred());
      expect(a.accessToken).toMatch(/^shpat_cc_/);
      await checkShopifyConnection(urls, a);
      await checkShopifyConnection(urls, await shopifyConn(urls, fake.state.shopDomain, cred()));
      expect(fake.state.tokenCalls).toBe(1);
    });
    it("gets a new token after a 401 and repeats the call once", async () => {
      const c = await shopifyConn(urls, fake.state.shopDomain, cred());
      const made = await createShopifyProduct(urls, c, { title: "Mug" });
      fake.expireTokens();
      const out = await updateShopifyProduct(urls, c, { by: "id", key: made.productId }, { title: "Mug 2" });
      expect(out.title).toBe("Mug 2");
      expect(fake.state.tokenCalls).toBe(2);
      expect(fake.state.products).toHaveLength(1);
    });
    it("refuses a wrong secret and a store outside the app's organization, as auth", async () => {
      const wrong = (await shopifyConn(urls, fake.state.shopDomain, { ...cred(), appSecret: "not-the-secret" }).catch((e: unknown) => e)) as ProviderError;
      expect([wrong.kind, /client ID and secret/.test(wrong.message)]).toEqual(["auth", true]);
      fake.state.otherOrganization = true;
      const other = (await shopifyConn(urls, "another-shop.myshopify.com", cred()).catch((e: unknown) => e)) as ProviderError;
      expect([other.kind, /same Shopify organization/.test(other.message)]).toEqual(["auth", true]);
    });
    it("never asks for a token for a host that is not a shop domain", async () => {
      const err = (await shopifyConn(urls, "evil.test", cred()).catch((e: unknown) => e)) as ProviderError;
      expect(err.kind).toBe("invalid");
      expect(fake.state.tokenCalls).toBe(0);
    });
  });

  describe("order webhook", () => {
    const uri = "https://daloy.example.test/hooks/shopify/abc";
    it("registers orders/create once, and again is a no-op", async () => {
      expect(await ensureOrderWebhook(urls, conn(), uri)).toEqual({ state: "registered" });
      expect(fake.state.webhooks).toEqual([expect.objectContaining({ topic: "ORDERS_CREATE", uri })]);
      expect(await ensureOrderWebhook(urls, conn(), uri)).toEqual({ state: "registered" });
      expect(fake.state.webhooks).toHaveLength(1);
    });
    it("removes only an older Daloy subscription at another path and leaves the owner's own alone", async () => {
      fake.state.webhooks.push({ id: "gid://shopify/WebhookSubscription/1", topic: "ORDERS_CREATE", uri: "https://daloy.example.test/hooks/shopify/old" });
      fake.state.webhooks.push({ id: "gid://shopify/WebhookSubscription/2", topic: "ORDERS_CREATE", uri: "https://other.example.test/hook" });
      await ensureOrderWebhook(urls, conn(), uri, "https://daloy.example.test/hooks/shopify/");
      expect(fake.state.webhooks.map((w) => w.uri).sort()).toEqual([uri, "https://other.example.test/hook"].sort());
    });
    it("reports a refusal instead of throwing, so the connection can still be saved", async () => {
      const out = await ensureOrderWebhook(urls, conn(), "not a url");
      expect(out.state).toBe("failed");
      expect((out as { message: string }).message).toMatch(/address/i);
    });
  });
});
