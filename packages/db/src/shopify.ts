import { createHmac, timingSafeEqual } from "node:crypto";
import { call, ProviderError, providerUrls, retryAfter, type ProviderUrls, type Reply } from "./providers";

/**
 * Shopify Admin GraphQL API (decision 0105). The version is pinned: Shopify serves an unsupported version with the
 * oldest supported one without an error, so a moving default would change behaviour silently. 2026-10 is supported
 * until 16 October 2027. Raise it on purpose, with the shapes below re-read from shopify.dev, never by default.
 */
export const SHOPIFY_API_VERSION = "2026-10";

/** What the owner's app must be allowed to do: read_orders for the order webhook, write_products for the product steps. Nothing else. */
export const SHOPIFY_SCOPES = ["read_orders", "write_products"] as const;

/**
 * The encrypted credential. appSecret is the app's client secret: it signs the order webhook and, with clientId, gets
 * access tokens through the client credentials grant (an app made in the Dev Dashboard). An app made in the store admin
 * before Shopify closed that path has a fixed accessToken instead of a clientId.
 */
export type ShopifyCredential = { appSecret: string } & ({ clientId: string; accessToken?: undefined } | { accessToken: string; clientId?: undefined });
/** What a call needs: the shop domain (kept in the connection's destination, not secret) and an Admin API access token. renew gets a new one after a 401. */
export type ShopifyConn = { shop: string; accessToken: string; renew?: () => Promise<string> };

/** Parses the encrypted JSON credential of a shopify connection. */
export function parseShopifyCredential(raw: string): ShopifyCredential {
  try {
    const p = JSON.parse(raw) as { appSecret?: unknown; clientId?: unknown; accessToken?: unknown } | null;
    if (p && typeof p.appSecret === "string" && typeof p.clientId === "string") return { appSecret: p.appSecret, clientId: p.clientId };
    if (p && typeof p.appSecret === "string" && typeof p.accessToken === "string") return { appSecret: p.appSecret, accessToken: p.accessToken };
  } catch {
    // malformed JSON
  }
  throw new ProviderError("Stored Shopify credentials could not be read. Connect Shopify again.", "auth");
}

// shortcut: client credentials tokens are cached in this process only, so each API and worker process asks once a day; move them to the connections row if Shopify limits the token endpoint.
const tokens = new Map<string, { token: string; until: number }>();

/**
 * A client credentials token (POST /admin/oauth/access_token with client_id, client_secret and grant_type). It lasts
 * 24 hours (expires_in 86399) and only works when the app and the store belong to the same Shopify organization.
 */
async function clientCredentialsToken(urls: ProviderUrls, shop: string, clientId: string, secret: string, fresh: boolean): Promise<string> {
  const cacheKey = createHmac("sha256", secret).update(`${shop}|${clientId}`).digest("base64url");
  const hit = tokens.get(cacheKey);
  if (!fresh && hit && hit.until > Date.now()) return hit.token;
  if (normalizeShopDomain(shop) !== shop) throw new ProviderError("The saved Shopify shop domain is not valid. Connect Shopify again.", "invalid");
  const body = new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: "client_credentials" }).toString();
  const res = await call(`${urls.shopify ?? `https://${shop}`}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body }, urls.timeoutMs ?? 10_000, false, "Shopify");
  if (res.status === 429) throw new ProviderError("Shopify is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers) ?? 1000);
  if (res.status >= 500) throw new ProviderError(`Shopify answered ${res.status}.`, "unavailable");
  if (res.body.error === "shop_not_permitted") throw new ProviderError("Shopify only gives this app a token for stores in the same Shopify organization as the app. Make the app in the Dev Dashboard of the organization that owns this store.", "auth");
  const token = res.body.access_token;
  if (res.status >= 400 || typeof token !== "string" || !token) throw new ProviderError("Shopify did not accept the client ID and secret for this store. Check them in the Dev Dashboard, and that the app is installed on the store.", "auth");
  const seconds = typeof res.body.expires_in === "number" ? res.body.expires_in : 3600;
  tokens.set(cacheKey, { token, until: Date.now() + Math.max(60, seconds - 300) * 1000 });
  return token;
}

/** Turns the stored credential into what a call needs. A Dev Dashboard app gets a token now, or from the cache. */
export async function shopifyConn(urls: ProviderUrls, shop: string, cred: ShopifyCredential): Promise<ShopifyConn> {
  if (cred.accessToken !== undefined) return { shop, accessToken: cred.accessToken };
  const clientId = cred.clientId;
  return { shop, accessToken: await clientCredentialsToken(urls, shop, clientId, cred.appSecret, false), renew: () => clientCredentialsToken(urls, shop, clientId, cred.appSecret, true) };
}

const SHOP = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?\.myshopify\.com$/;

/**
 * The shop domain from what an owner pastes: "name.myshopify.com", or a link that starts with it. Anything else is
 * null: another host, a port, a user name in the link, a longer host that merely ends in .myshopify.com. This is the only
 * way a host reaches a request, so the token can never be sent anywhere but Shopify.
 */
export function normalizeShopDomain(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!text || /\s/.test(text)) return null;
  let host: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    host = u.hostname;
  } else if (/[/?#@:]/.test(text.replace(/\/.*$/, ""))) {
    return null;
  } else {
    host = text.replace(/\/.*$/, "");
  }
  return SHOP.test(host) ? host : null;
}

/** HTML-safe text for a product description. Trigger data is untrusted, so it is never written into the storefront as markup. */
export const textToHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r?\n/g, "<br>");

/**
 * Checks X-Shopify-Hmac-Sha256: the base64 HMAC-SHA256 of the exact raw bytes, keyed with the app's client secret. Compared
 * in constant time. Fails closed on an empty secret, a missing header or anything that is not a 32-byte base64 value.
 * There is no timestamp in what Shopify signs, so a replay is stopped by the webhook id, not here.
 */
export function verifyShopifyHmac(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const given = header.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(given)) return false;
  const want = createHmac("sha256", appSecret).update(rawBody).digest();
  const got = Buffer.from(given, "base64");
  return got.length === want.length && timingSafeEqual(want, got);
}

// ---------------------------------------------------------------- the order webhook payload

const MAX_LINES = 50;
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "").trim().slice(0, max);
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export type ShopifyOrderPayload = {
  order_id: string;
  order_number: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  total: string;
  currency: string;
  financial_status: string;
  created_at: string;
  shop: string;
  item_count: number;
  items: string;
  line_items: { title: string; variant_title: string; quantity: number; price: string; sku: string }[];
};

/** An orders/create body as the trigger fields a workflow reads, or undefined when the body is not an order. Text only: the total stays the string Shopify sent. */
export function parseShopifyOrder(body: unknown, shop: string): ShopifyOrderPayload | undefined {
  const o = rec(body);
  // Shopify ids go past 2^53, so a JSON number loses digits once parsed. The gid is text, so it keeps them.
  const id = /(\d{1,20})$/.exec(str(o.admin_graphql_api_id, 100))?.[1] ?? str(o.id, 40);
  if (!id) return undefined;
  const customer = rec(o.customer);
  const shipping = rec(o.shipping_address);
  const billing = rec(o.billing_address);
  const name = [str(customer.first_name), str(customer.last_name)].filter(Boolean).join(" ") || str(shipping.name) || str(billing.name);
  const number = str(o.name, 40) || (str(o.order_number, 20) ? `#${str(o.order_number, 20)}` : "");
  const all = Array.isArray(o.line_items) ? o.line_items : [];
  const lines = all.slice(0, MAX_LINES).map((raw) => {
    const l = rec(raw);
    const qty = typeof l.quantity === "number" && Number.isFinite(l.quantity) ? Math.max(0, Math.trunc(l.quantity)) : 0;
    return { title: str(l.title), variant_title: str(l.variant_title), quantity: qty, price: str(l.price, 40), sku: str(l.sku) };
  });
  const quantity = (l: unknown) => {
    const q = rec(l).quantity;
    return typeof q === "number" && Number.isFinite(q) ? Math.max(0, Math.trunc(q)) : 0;
  };
  return {
    order_id: id,
    order_number: number,
    customer_name: name.slice(0, 200),
    customer_email: str(o.email) || str(o.contact_email) || str(customer.email),
    customer_phone: str(o.phone, 40) || str(customer.phone, 40) || str(shipping.phone, 40) || str(billing.phone, 40),
    total: str(o.total_price, 40),
    currency: str(o.currency, 10),
    financial_status: str(o.financial_status, 40),
    created_at: str(o.created_at, 40),
    shop,
    item_count: all.reduce<number>((n, l) => n + quantity(l), 0),
    items: lines.map((l) => `${l.quantity} x ${l.title}${l.variant_title ? ` (${l.variant_title})` : ""}${l.sku ? ` [${l.sku}]` : ""}`).join("\n"),
    line_items: lines,
  };
}

// ---------------------------------------------------------------- GraphQL calls

type GqlError = { message?: unknown; extensions?: { code?: unknown } };

const clip = (s: unknown) => String(s ?? "").slice(0, 300);

/** Reads a Shopify answer into data, or the ProviderError the caller should act on (decision 0021). No error echoes the token or the request. */
function failure(res: Reply, write: boolean): ProviderError | undefined {
  const s = res.status;
  if (s === 401) return new ProviderError("Shopify does not accept the access token. Connect Shopify again.", "auth");
  if (s === 402) return new ProviderError("Shopify says this store is frozen, usually an unpaid bill. Pay it in Shopify, then retry.", "permission");
  if (s === 403) return new ProviderError("Shopify refused this app for this store. Check the app's access in your Shopify admin.", "permission");
  if (s === 404) return new ProviderError("Shopify could not find that store. Check the shop domain.", "invalid");
  if (s === 423) return new ProviderError("Shopify says the store is locked right now. Daloy will try again.", "unavailable");
  if (s === 429) return new ProviderError("Shopify is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers) ?? 1000);
  if (s >= 500) return new ProviderError(`Shopify answered ${s}.`, write ? "ambiguous" : "unavailable");
  if (s >= 400) return new ProviderError(`Shopify refused the request (${s}).`, "invalid");
  const errors = res.body.errors;
  if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0)) {
    const first = (Array.isArray(errors) ? errors[0] : { message: errors }) as GqlError;
    const code = first.extensions?.code;
    if (code === "THROTTLED") return new ProviderError("Shopify is limiting requests right now. Daloy will try again.", "quota", 1000);
    if (code === "ACCESS_DENIED") return new ProviderError(`Shopify refused this: ${clip(first.message)} Add that access scope to the app, then retry.`, "permission");
    if (code === "SHOP_INACTIVE") return new ProviderError("This Shopify store is not active.", "permission");
    if (code === "INTERNAL_SERVER_ERROR") return new ProviderError("Shopify had an internal error.", write ? "ambiguous" : "unavailable");
    return new ProviderError(`Shopify refused the request: ${clip(first.message)}`, "invalid");
  }
  if (res.body.data === undefined || res.body.data === null) return new ProviderError("Shopify answered without data, so Daloy cannot tell what happened.", write ? "ambiguous" : "unavailable");
  return undefined;
}

async function gql(urls: ProviderUrls, conn: ShopifyConn, query: string, variables: Record<string, unknown>, write: boolean): Promise<Record<string, unknown>> {
  // Re-checked here, so a stored value that was changed by hand still cannot point the token at another host.
  if (normalizeShopDomain(conn.shop) !== conn.shop) throw new ProviderError("The saved Shopify shop domain is not valid. Connect Shopify again.", "invalid");
  const base = urls.shopify ?? `https://${conn.shop}`;
  const send = () =>
    call(
      `${base}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": conn.accessToken }, body: JSON.stringify({ query, variables }) },
      urls.timeoutMs ?? 10_000,
      write,
      "Shopify",
    );
  let res = await send();
  // A 24-hour token may have run out: one new token and one more try. A 401 means nothing was applied, so a write may repeat.
  if (res.status === 401 && conn.renew) {
    conn.accessToken = await conn.renew();
    res = await send();
  }
  const bad = failure(res, write);
  if (bad) throw bad;
  return res.body.data as Record<string, unknown>;
}

type UserError = { field?: unknown; message?: unknown; code?: unknown };
/** The payload of a mutation, or an "invalid" ProviderError built from its userErrors. */
function payload(data: Record<string, unknown>, name: string): Record<string, unknown> {
  const p = rec(data[name]);
  const errors = Array.isArray(p.userErrors) ? (p.userErrors as UserError[]) : [];
  if (errors.length > 0) {
    const text = errors.slice(0, 3).map((e) => `${Array.isArray(e.field) && e.field.length ? `${e.field.join(".")}: ` : ""}${clip(e.message)}`).join("; ");
    throw new ProviderError(`Shopify refused: ${text}`, "invalid");
  }
  return p;
}

const SHOP_QUERY = "query { shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }";

/** The one read call that proves the shop domain and token work, and lists which scopes are missing. */
export async function checkShopifyConnection(urls: ProviderUrls = providerUrls(), conn: ShopifyConn) {
  const data = await gql(urls, conn, SHOP_QUERY, {}, false);
  const shop = rec(data.shop);
  const handles = new Set((rec(data.currentAppInstallation).accessScopes as { handle?: unknown }[] | undefined ?? []).map((s) => String(s.handle)));
  // A write scope includes the matching read scope.
  const has = (scope: string) => handles.has(scope) || handles.has(scope.replace(/^read_/, "write_"));
  return { name: str(shop.name) || conn.shop, domain: str(shop.myshopifyDomain) || conn.shop, scopes: [...handles], missingScopes: SHOPIFY_SCOPES.filter((s) => !has(s)) };
}

// ---------------------------------------------------------------- the order webhook subscription

const WEBHOOK_LIST = "query { webhookSubscriptions(first: 50, topics: [ORDERS_CREATE]) { nodes { id uri } } }";
const WEBHOOK_CREATE = "mutation($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) { userErrors { field message } webhookSubscription { id topic uri } } }";
const WEBHOOK_DELETE = "mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { userErrors { field message } deletedWebhookSubscriptionId } }";

export type WebhookRegistration = { state: "registered" } | { state: "failed"; message: string };

/**
 * Makes sure Shopify posts orders/create to uri. Run when the owner connects. An existing subscription to the same
 * address is kept. One at another address under ours (ownPrefix) is removed, since a reconnect may change the path.
 * The owner's own subscriptions are never touched. A refusal comes back as { state: "failed" } so the connection is
 * still saved and the owner is told why (Shopify only delivers to a public https address).
 */
export async function ensureOrderWebhook(urls: ProviderUrls = providerUrls(), conn: ShopifyConn, uri: string, ownPrefix?: string): Promise<WebhookRegistration> {
  try {
    const listed = rec(await gql(urls, conn, WEBHOOK_LIST, {}, false)).webhookSubscriptions;
    const nodes = ((rec(listed).nodes as { id?: unknown; uri?: unknown }[] | undefined) ?? []).map((n) => ({ id: String(n.id), uri: String(n.uri) }));
    for (const n of nodes) if (ownPrefix && n.uri.startsWith(ownPrefix) && n.uri !== uri) payload(await gql(urls, conn, WEBHOOK_DELETE, { id: n.id }, true), "webhookSubscriptionDelete");
    if (nodes.some((n) => n.uri === uri)) return { state: "registered" };
    payload(await gql(urls, conn, WEBHOOK_CREATE, { topic: "ORDERS_CREATE", webhookSubscription: { uri } }, true), "webhookSubscriptionCreate");
    return { state: "registered" };
  } catch (err) {
    if (err instanceof ProviderError) return { state: "failed", message: err.message };
    throw err;
  }
}

/** Removes Daloy's subscription when the owner disconnects. Best effort: Shopify drops a dead one after 8 failed deliveries anyway. */
export async function removeOrderWebhook(urls: ProviderUrls = providerUrls(), conn: ShopifyConn, ownPrefix: string): Promise<void> {
  const listed = rec(await gql(urls, conn, WEBHOOK_LIST, {}, false)).webhookSubscriptions;
  for (const n of (rec(listed).nodes as { id?: unknown; uri?: unknown }[] | undefined) ?? []) {
    if (String(n.uri).startsWith(ownPrefix)) payload(await gql(urls, conn, WEBHOOK_DELETE, { id: String(n.id) }, true), "webhookSubscriptionDelete");
  }
}

// ---------------------------------------------------------------- products

export type ShopifyProductFields = {
  title?: string;
  /** Plain text. It is escaped into HTML. */
  description?: string;
  /** Decimal text such as "499.50", in the store's currency. */
  price?: string;
  sku?: string;
  status?: "draft" | "active";
  /** An https link Shopify downloads the image from. */
  imageUrl?: string;
};
export type ShopifyProductResult = { productId: string; productGid: string; variantId: string; sku: string; title: string; status: string; adminUrl: string; created: boolean };

const PRODUCT_CREATE = "mutation($product: ProductCreateInput!, $media: [CreateMediaInput!]) { productCreate(product: $product, media: $media) { product { id title status variants(first: 1) { nodes { id sku inventoryItem { id } } } } userErrors { field message } } }";
const PRODUCT_UPDATE = "mutation($product: ProductUpdateInput!, $media: [CreateMediaInput!]) { productUpdate(product: $product, media: $media) { product { id title status } userErrors { field message } } }";
const VARIANTS_UPDATE = "mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id sku } userErrors { field message } } }";
const BY_ID = "query($id: ID!) { product(id: $id) { id title status variants(first: 10) { nodes { id sku inventoryItem { id } } } } }";
const BY_SKU = "query($query: String!) { productVariants(first: 5, query: $query) { nodes { id sku product { id title status } inventoryItem { id } } } }";

const numeric = (g: string) => /(\d+)$/.exec(g)?.[1] ?? "";
const adminUrl = (shop: string, gid: string) => `https://${shop}/admin/products/${numeric(gid)}`;
const status = (s: unknown) => String(s ?? "").toLowerCase();
const mediaFor = (title: string, imageUrl?: string) => (imageUrl ? [{ originalSource: imageUrl, mediaContentType: "IMAGE", alt: title.slice(0, 250) }] : undefined);

/** A product id from an owner's text: digits, a gid, or the link to the product in the Shopify admin. */
export function productGid(text: string): string | undefined {
  const m = /^(?:gid:\/\/shopify\/Product\/|https:\/\/[a-z0-9.-]+\/(?:admin|store\/[a-z0-9-]+)\/products\/)?(\d{1,20})(?:[/?#].*)?$/i.exec(text.trim());
  return m ? `gid://shopify/Product/${m[1]}` : undefined;
}

type Variant = { id: string; sku: string; inventoryItemId: string };
async function variantsBySku(urls: ProviderUrls, conn: ShopifyConn, sku: string) {
  const data = await gql(urls, conn, BY_SKU, { query: `sku:"${sku.replace(/(["\\])/g, "\\$1")}"` }, false);
  // The search can match more than the exact text (wildcards, tokens), so only an exact, case-sensitive SKU counts.
  return ((rec(data.productVariants).nodes as { id?: unknown; sku?: unknown; product?: unknown; inventoryItem?: unknown }[] | undefined) ?? [])
    .filter((n) => n.sku === sku)
    .map((n) => ({ productId: String(rec(n.product).id), title: str(rec(n.product).title), status: status(rec(n.product).status), variant: { id: String(n.id), sku: String(n.sku), inventoryItemId: String(rec(n.inventoryItem).id) } }));
}

/** Price and SKU live on the variant, not on the product. */
async function setVariant(urls: ProviderUrls, conn: ShopifyConn, productGidValue: string, variantId: string, f: ShopifyProductFields) {
  const variant = { id: variantId, ...(f.price !== undefined ? { price: f.price } : {}), ...(f.sku !== undefined ? { inventoryItem: { sku: f.sku } } : {}) };
  payload(await gql(urls, conn, VARIANTS_UPDATE, { productId: productGidValue, variants: [variant] }, true), "productVariantsBulkUpdate");
}

/** After something was written, a failure is for a person: a retry would make a second product. */
async function afterCreate<T>(productId: string, what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ProviderError) throw new ProviderError(`Shopify made the product (${productId}) but could not ${what}: ${err.message} Check the product in your Shopify admin.`, "review");
    throw err;
  }
}

/**
 * One new product with its price, SKU and image. productCreate cannot take price or SKU (2026-10), so they follow as a
 * variant call. Shopify has no idempotency key for product mutations, so the SKU is the only way to see that a product
 * is there already: on a first attempt a SKU in the store is refused (Shopify allows duplicate SKUs without a word), and
 * on a retry after an unknown outcome (retrying) the one product with that SKU is taken as the one the first attempt made.
 */
export async function createShopifyProduct(urls: ProviderUrls = providerUrls(), conn: ShopifyConn, f: ShopifyProductFields & { title: string }, o: { retrying?: boolean } = {}): Promise<ShopifyProductResult & { reconciled?: true }> {
  const existing = f.sku ? await variantsBySku(urls, conn, f.sku) : [];
  if (existing.length === 1 && o.retrying) {
    const e = existing[0]!;
    return { productId: numeric(e.productId), productGid: e.productId, variantId: e.variant.id, sku: e.variant.sku, title: e.title, status: e.status, adminUrl: adminUrl(conn.shop, e.productId), created: true, reconciled: true };
  }
  if (existing.length > 0) throw new ProviderError(`A product with the SKU "${f.sku}" already exists in the store. Use Update product to change it.`, "invalid");
  const product = payload(
    await gql(urls, conn, PRODUCT_CREATE, { product: { title: f.title, ...(f.description !== undefined ? { descriptionHtml: textToHtml(f.description) } : {}), status: f.status === "draft" ? "DRAFT" : "ACTIVE" }, media: mediaFor(f.title, f.imageUrl) }, true),
    "productCreate",
  ).product as { id?: unknown; title?: unknown; status?: unknown; variants?: unknown } | null;
  if (!product?.id) throw new ProviderError("Shopify answered without the new product, so Daloy cannot tell whether it was made.", "ambiguous");
  const productId = String(product.id);
  const first = ((rec(product.variants).nodes as { id?: unknown }[] | undefined) ?? [])[0];
  const variantId = String(first?.id ?? "");
  if (f.price !== undefined || f.sku) {
    if (!variantId) throw new ProviderError(`Shopify made the product (${numeric(productId)}) without a variant to put the price on. Check it in your Shopify admin.`, "review");
    await afterCreate(numeric(productId), "set the price and SKU", () => setVariant(urls, conn, productId, variantId, f));
  }
  return { productId: numeric(productId), productGid: productId, variantId, sku: f.sku ?? "", title: String(product.title ?? f.title), status: status(product.status), adminUrl: adminUrl(conn.shop, productId), created: true };
}

/**
 * Changes the chosen fields of one product, found by id or by SKU. Fields left out stay as they are, and each field is
 * set to a value, never added to, so a second run leaves the same product. A SKU that matches nothing, or more than one
 * product, is refused instead of guessed. Price and SKU belong to a variant, so by id they need a product with one
 * variant; by SKU the matching variant is the one changed.
 */
export async function updateShopifyProduct(urls: ProviderUrls = providerUrls(), conn: ShopifyConn, find: { by: "id" | "sku"; key: string }, f: ShopifyProductFields): Promise<ShopifyProductResult> {
  let productId: string;
  let title: string;
  let currentStatus: string;
  let variant: Variant | undefined;
  const wantsVariant = f.price !== undefined || f.sku !== undefined;
  if (find.by === "sku") {
    const hits = await variantsBySku(urls, conn, find.key);
    if (hits.length === 0) throw new ProviderError(`No product in the store has the SKU "${find.key}".`, "invalid");
    if (hits.length > 1) throw new ProviderError(`The SKU "${find.key}" is on more than one product or variant. Use the product id instead.`, "invalid");
    const hit = hits[0]!;
    productId = hit.productId;
    title = hit.title;
    currentStatus = hit.status;
    variant = hit.variant;
  } else {
    const gidValue = productGid(find.key);
    if (!gidValue) throw new ProviderError(`"${find.key.slice(0, 60)}" is not a Shopify product id. Use the number from the product's link.`, "invalid");
    const p = rec((await gql(urls, conn, BY_ID, { id: gidValue }, false)).product);
    if (!p.id) throw new ProviderError(`No product in the store has the id ${numeric(gidValue)}.`, "invalid");
    productId = String(p.id);
    title = str(p.title);
    currentStatus = status(p.status);
    const variants = ((p.variants as { nodes?: { id?: unknown; sku?: unknown; product?: unknown; inventoryItem?: unknown }[] } | undefined)?.nodes ?? []).map((n) => ({ id: String(n.id), sku: String(n.sku ?? ""), inventoryItemId: String(rec(n.inventoryItem).id) }));
    if (wantsVariant && variants.length !== 1) throw new ProviderError(`This product has ${variants.length} variants, so the price or SKU cannot be changed by product id. Find it by SKU instead.`, "invalid");
    variant = variants[0];
  }
  if (f.title !== undefined || f.description !== undefined || f.status !== undefined || f.imageUrl) {
    const updated = rec(
      payload(
        await gql(urls, conn, PRODUCT_UPDATE, { product: { id: productId, ...(f.title !== undefined ? { title: f.title } : {}), ...(f.description !== undefined ? { descriptionHtml: textToHtml(f.description) } : {}), ...(f.status ? { status: f.status === "draft" ? "DRAFT" : "ACTIVE" } : {}) }, media: mediaFor(f.title ?? title, f.imageUrl) }, true),
        "productUpdate",
      ).product,
    );
    title = str(updated.title) || title;
    currentStatus = status(updated.status) || currentStatus;
  }
  if (wantsVariant && variant) await setVariant(urls, conn, productId, variant.id, f);
  return { productId: numeric(productId), productGid: productId, variantId: variant?.id ?? "", sku: f.sku ?? variant?.sku ?? "", title, status: currentStatus, adminUrl: adminUrl(conn.shop, productId), created: false };
}
