/* eslint-disable @typescript-eslint/no-explicit-any -- the fake reads loosely shaped GraphQL variables, as a server would */
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * A fake Shopify Admin GraphQL API for tests and the e2e suite (decision 0105). It is not a GraphQL engine: it picks an
 * operation by name out of the query text and answers the way Shopify's 2026-10 docs describe. It enforces the rules the
 * docs call out, so a request shaped for an older version fails here too:
 * - X-Shopify-Access-Token must be the legacy app's token or one the client credentials grant handed out, else 401.
 * - POST /admin/oauth/access_token takes client_id, client_secret and grant_type=client_credentials (form encoded) and
 *   answers access_token, scope and expires_in 86399. expireTokens() makes every handed-out token answer 401.
 * - productCreate has no price or SKU: those go through productVariantsBulkUpdate.
 * Real Shopify is never called from tests.
 */
export const FAKE_SHOPIFY_VERSION = "2026-10";

type Variant = { id: string; sku: string; price: string; inventoryItemId: string; tracked: boolean };
export type FakeProduct = { id: string; title: string; descriptionHtml: string; status: "ACTIVE" | "DRAFT" | "ARCHIVED"; variants: Variant[]; images: string[] };
/** One forced answer, used up by the next GraphQL request. */
export type Forced = { status?: number; headers?: Record<string, string>; body?: unknown; hang?: boolean };

export function createFakeShopify() {
  let seq = 1000;
  const state = {
    token: "shpat_fake_token_0001", // gitleaks:allow
    clientId: "fakeclientid0123456789",
    clientSecret: "fake-client-secret-0001", // gitleaks:allow
    /** Tokens the client credentials grant handed out, and how many times it was asked. */
    issued: new Set<string>(),
    tokenCalls: 0,
    /** Makes the token endpoint answer shop_not_permitted, like a store outside the app's organization. */
    otherOrganization: false,
    shopName: "Tindahan ni Ana",
    shopDomain: "tindahan-ni-ana.myshopify.com",
    scopes: ["read_orders", "write_products"],
    products: [] as FakeProduct[],
    webhooks: [] as { id: string; topic: string; uri: string }[],
    /** Operation names in the order they arrived, for assertions. */
    calls: [] as string[],
    forced: [] as Forced[],
    /** Makes webhookSubscriptionCreate answer ACCESS_DENIED, like an app without the read_orders scope. */
    denyWebhooks: false,
  };
  const gid = (type: string) => `gid://shopify/${type}/${++seq}`;
  const num = (g: string) => /(\d+)$/.exec(g)?.[1] ?? "";
  const productJson = (p: FakeProduct) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    variants: { nodes: p.variants.map((v) => ({ id: v.id, sku: v.sku, price: v.price, inventoryItem: { id: v.inventoryItemId } })) },
  });
  const userErrors = (...messages: [string[], string][]) => messages.map(([field, message]) => ({ field, message }));

  const mutations: Record<string, (v: Record<string, any>, q: string) => unknown> = {
    productCreate: (v) => {
      const input = v.product as { title?: string; descriptionHtml?: string; status?: string };
      if (!input.title?.trim()) return { productCreate: { product: null, userErrors: userErrors([["title"], "Title can't be blank"]) } };
      const p: FakeProduct = {
        id: gid("Product"),
        title: input.title,
        descriptionHtml: input.descriptionHtml ?? "",
        status: input.status === "DRAFT" ? "DRAFT" : "ACTIVE",
        variants: [{ id: gid("ProductVariant"), sku: "", price: "0.00", inventoryItemId: gid("InventoryItem"), tracked: false }],
        images: ((v.media ?? []) as { originalSource: string }[]).map((m) => m.originalSource),
      };
      state.products.push(p);
      return { productCreate: { product: productJson(p), userErrors: [] } };
    },
    productVariantsBulkUpdate: (v) => {
      const p = state.products.find((x) => x.id === v.productId);
      if (!p) return { productVariantsBulkUpdate: { productVariants: null, userErrors: userErrors([["productId"], "Product does not exist"]) } };
      for (const input of v.variants as { id: string; price?: string; inventoryItem?: { sku?: string; tracked?: boolean } }[]) {
        const variant = p.variants.find((x) => x.id === input.id);
        if (!variant) return { productVariantsBulkUpdate: { productVariants: null, userErrors: userErrors([["variants", "0", "id"], "Product variant does not exist"]) } };
        if (input.price !== undefined) {
          if (!/^\d+(\.\d+)?$/.test(String(input.price))) return { productVariantsBulkUpdate: { productVariants: null, userErrors: userErrors([["variants", "0", "price"], "Price must be a number"]) } };
          variant.price = String(input.price);
        }
        if (input.inventoryItem?.sku !== undefined) variant.sku = input.inventoryItem.sku;
        if (input.inventoryItem?.tracked !== undefined) variant.tracked = input.inventoryItem.tracked;
      }
      return { productVariantsBulkUpdate: { productVariants: p.variants.map((x) => ({ id: x.id, sku: x.sku })), userErrors: [] } };
    },
    productUpdate: (v) => {
      const input = v.product as { id: string; title?: string; descriptionHtml?: string; status?: string };
      const p = state.products.find((x) => x.id === input.id);
      if (!p) return { productUpdate: { product: null, userErrors: userErrors([["id"], "Product does not exist"]) } };
      if (input.title !== undefined) p.title = input.title;
      if (input.descriptionHtml !== undefined) p.descriptionHtml = input.descriptionHtml;
      if (input.status !== undefined) p.status = input.status as FakeProduct["status"];
      for (const m of (v.media ?? []) as { originalSource: string }[]) p.images.push(m.originalSource);
      return { productUpdate: { product: productJson(p), userErrors: [] } };
    },
    webhookSubscriptionCreate: (v) => {
      if (state.denyWebhooks) return { __error: { message: "Access denied for webhookSubscriptionCreate field. Required access: `read_orders` access scope.", extensions: { code: "ACCESS_DENIED" } } };
      const uri = (v.webhookSubscription as { uri?: string }).uri ?? "";
      if (!/^https?:\/\//.test(uri)) return { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: userErrors([["webhookSubscription", "callbackUrl"], "Address is invalid"]) } };
      if (state.webhooks.some((w) => w.topic === v.topic && w.uri === uri)) return { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: userErrors([["webhookSubscription", "callbackUrl"], "Address for this topic has already been taken"]) } };
      const w = { id: gid("WebhookSubscription"), topic: String(v.topic), uri };
      state.webhooks.push(w);
      return { webhookSubscriptionCreate: { webhookSubscription: { ...w, format: "JSON" }, userErrors: [] } };
    },
    webhookSubscriptionDelete: (v) => {
      const i = state.webhooks.findIndex((w) => w.id === v.id);
      if (i < 0) return { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: null, userErrors: userErrors([["id"], "Webhook subscription does not exist"]) } };
      state.webhooks.splice(i, 1);
      return { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: v.id, userErrors: [] } };
    },
  };

  const queries: [RegExp, string, (v: Record<string, any>) => unknown][] = [
    [/\bproductVariants\s*\(/, "productVariants", (v) => {
      const sku = /sku:"((?:[^"\\]|\\.)*)"/.exec(String(v.query ?? ""))?.[1]?.replace(/\\(.)/g, "$1");
      const nodes = state.products.flatMap((p) => p.variants.filter((x) => sku !== undefined && x.sku === sku).map((x) => ({ id: x.id, sku: x.sku, product: { id: p.id, title: p.title, status: p.status }, inventoryItem: { id: x.inventoryItemId } })));
      return { productVariants: { nodes } };
    }],
    [/\bproduct\s*\(\s*id:/, "product", (v) => {
      const p = state.products.find((x) => x.id === v.id);
      return { product: p ? productJson(p) : null };
    }],
    [/\bwebhookSubscriptions\s*\(/, "webhookSubscriptions", () => ({ webhookSubscriptions: { nodes: state.webhooks.map((w) => ({ id: w.id, uri: w.uri })) } })],
    [/\bshop\s*\{/, "shop", () => ({ shop: { name: state.shopName, myshopifyDomain: state.shopDomain }, currentAppInstallation: { accessScopes: state.scopes.map((handle) => ({ handle })) } })],
  ];

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

  /** Answers /admin/oauth/access_token and /admin/api/<version>/graphql.json. Returns false for any other path. */
  function handle(req: IncomingMessage, res: ServerResponse, path: string, raw: string): boolean {
    if (path === "/admin/oauth/access_token") {
      state.tokenCalls++;
      const f = new URLSearchParams(raw);
      if (!String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded") || f.get("grant_type") !== "client_credentials") return send(res, 400, { error: "unsupported_grant_type" }), true;
      if (f.get("client_id") !== state.clientId || f.get("client_secret") !== state.clientSecret) return send(res, 400, { error: "invalid_client", error_description: "Client authentication failed" }), true;
      if (state.otherOrganization) return send(res, 400, { error: "shop_not_permitted", error_description: "Client credentials cannot be performed on this shop." }), true;
      const token = `shpat_cc_${++seq}`; // gitleaks:allow
      state.issued.add(token);
      return send(res, 200, { access_token: token, scope: state.scopes.join(","), expires_in: 86399 }), true;
    }
    const m = /^\/admin\/api\/([^/]+)\/graphql\.json$/.exec(path);
    if (!m) return false;
    if (req.method !== "POST") return send(res, 405, { errors: "Method not allowed" }), true;
    if (m[1] !== FAKE_SHOPIFY_VERSION) return send(res, 404, { errors: "Not Found" }), true;
    const given = String(req.headers["x-shopify-access-token"] ?? "");
    if (given !== state.token && !state.issued.has(given)) return send(res, 401, { errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" }), true;
    const forced = state.forced.shift();
    if (forced?.hang) return true;
    if (forced) return send(res, forced.status ?? 200, forced.body ?? {}, forced.headers), true;
    let parsed: { query?: string; variables?: Record<string, any> };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return send(res, 400, { errors: "Bad request" }), true;
    }
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};
    const isMutation = /^\s*mutation\b/.test(query);
    if (isMutation) {
      const name = Object.keys(mutations).find((n) => new RegExp(`\\b${n}\\s*\\(`).test(query));
      if (!name) return send(res, 200, { errors: [{ message: "Field does not exist on Mutation", extensions: { code: "undefinedField" } }] }), true;
      state.calls.push(name);
      const out = mutations[name]!(variables, query) as { __error?: unknown };
      if (out.__error) return send(res, 200, { errors: [out.__error] }), true;
      return send(res, 200, { data: out }), true;
    }
    const q = queries.find(([re]) => re.test(query));
    if (!q) return send(res, 200, { errors: [{ message: "Field does not exist on QueryRoot", extensions: { code: "undefinedField" } }] }), true;
    state.calls.push(q[1]);
    return send(res, 200, { data: q[2](variables) }), true;
  }

  return { state, handle, numericId: num, expireTokens: () => state.issued.clear() };
}

export type FakeShopify = ReturnType<typeof createFakeShopify>;
