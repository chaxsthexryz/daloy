# 0105: Shopify product steps and a native order trigger

## Context

I2 asks for two things: steps that create and update products in the owner's Shopify store, and an order trigger that replaces the generic webhook template for Shopify. The API details below come from shopify.dev, read on 22 November 2026. None of it has run against a real store (see the live check).

- The latest stable Admin API version is 2026-10, supported until 16 October 2027. A request for a retired version is answered by the oldest supported one without an error.
- `productCreate` takes a title, description, status and media but no price or SKU. Those go through `productVariantsBulkUpdate` on the product's first variant. `productUpdate` does not change variants either.
- Shopify's idempotency directive (`@idempotent(key:)`) covers inventory, location and refund mutations. No product or webhook mutation takes a key.
- Shopify no longer lets anyone create a custom app in the store admin. Apps made there earlier keep a fixed Admin API token. New apps are made in the Dev Dashboard, and a store in the same Shopify organization as the app gets a token through the client credentials grant: `POST https://<shop>/admin/oauth/access_token` with `client_id`, `client_secret` and `grant_type=client_credentials`, answered with `access_token`, `scope` and `expires_in` (86399, so 24 hours). A store outside the organization gets `shop_not_permitted`.
- Webhook subscriptions are made with `webhookSubscriptionCreate(topic, webhookSubscription: { uri })` (`callbackUrl` is deprecated). Shopify signs each delivery with the app's client secret (base64 HMAC-SHA256 of the raw body in `X-Shopify-Hmac-Sha256`), sends `X-Shopify-Shop-Domain`, `X-Shopify-Topic` and `X-Shopify-Webhook-Id`, allows 5 seconds, retries 8 times over 4 hours, and then deletes a subscription made through the API.

## Options

1. REST Admin API. Shopify marks it legacy, so it was not considered further.
2. GraphQL Admin API with a pinned version, and credentials the owner pastes from their own app (the other paste apps in Daloy work this way).
3. A public app with an OAuth install flow. It needs app review by Shopify and a listing. Rejected for now: it adds a service dependency and the pilots have one store each.
4. Product steps that call Shopify inside the run, like the HTTP step, so a later step can read the new product id. Rejected: there is no pin, no Retry and no Post again, and a lost answer leaves a person guessing. Deliveries give all three, as for Airtable and Notion.
5. Deduplicate orders by webhook id. A retried delivery keeps its webhook id, but a second subscription or a manual resend gets a new one. The order id is the thing that must start one run.

## Decision

- Provider `shopify`, auth method `token`. The credential is `{ appSecret, clientId }` for a Dev Dashboard app or `{ appSecret, accessToken }` for an older app made in the store admin, encrypted like the other connections and write-only in the API. The shop domain, the shop name, the random 32-byte webhook path and the webhook state are the destination (not secret). Migration 0048 adds `shopify` to the `connections_provider` and `deliveries_provider` checks. The stored secrets are in `secretValuesToHide` and the retired-secret extractor, so run history and errors redact them.
- Client credentials tokens are fetched when needed and cached in the process for their lifetime less 5 minutes. A 401 gets one new token and repeats that call once (a 401 means nothing was applied). The token is never stored.
- Scopes: `read_orders` for the webhook and `write_products` for the steps, nothing else. Connect lists missing scopes and does not block, because an owner may only want one of the two.
- The shop must match `^[a-z0-9-]+\.myshopify\.com$` after trimming a pasted admin link (`normalizeShopDomain`). Another host, a port, a user name or another scheme is refused. The same check runs before every request, including the token request, so a secret is never sent anywhere but Shopify even if a stored value is edited.
- The version is a constant, `SHOPIFY_API_VERSION = "2026-10"`, in `packages/db/src/shopify.ts`. Raising it is a code change that starts with re-reading the shapes on shopify.dev. `SHOPIFY_API_URL` (env only) points the client at the fake in tests.
- Product steps are deliveries (`provider: "shopify"`): the step checks its fields, then queues one delivery per run and step, pinned to the shop connected at that moment. A reconnect to another store before it is sent holds it for review, and Post again sends it to the new store. Throttling (429, `THROTTLED`) waits for `Retry-After` and retries; a 401 marks the connection as needing a reconnect.
- Idempotency where Shopify allows it. An update sets each field to a value, so after an unknown outcome it is simply retried. A create with a SKU is retried too: the first attempt refuses a SKU already in the store, and a retry after an unknown outcome takes the one product with that SKU as the one it made (`reconciled: true`). A create without a SKU has nothing to look for, so an unknown outcome goes to needs_review with Mark as posted and Post again. If `productCreate` worked and the price call failed, the delivery goes to review and names the product id.
- Update finds the product by id (a number, a gid or the admin link) or by an exact, case-sensitive SKU. No match, or more than one, is refused. By id, a price or SKU change needs a product with one variant. Blank fields mean unchanged.
- The delivery result holds `productId`, `productGid`, `variantId`, `sku`, `title`, `status`, `adminUrl` and `created`. A later step of the same run cannot read them, because deliveries run apart from the run.
- Descriptions are plain text and are HTML-escaped (line breaks become `<br>`). The image must be an https link without credentials. Prices must look like `499` or `499.50` and are sent as text, never as a float.
- Trigger `shopify_order`: `POST /hooks/shopify/:path`, 60 calls a minute per address. The path finds an active connection (else 403). The HMAC is checked against the raw bytes with `timingSafeEqual` before anything in the body is used (else 401). A missing webhook id is 400. A shop header that is not the connected store is 403. Another topic or a body that is not an order answers 200 and starts nothing, so Shopify does not delete the subscription. Each published, unpaused listener gets a run keyed `shopify:<shop>:order:<order id>`, so a retry, a resend and a concurrent duplicate start one run. `order_id` comes from `admin_graphql_api_id`, because Shopify ids pass 2^53 and lose digits as JSON numbers.
- Order fields (text except `item_count` and `line_items`): `order_id`, `order_number`, `customer_name`, `customer_email`, `customer_phone`, `total`, `currency`, `financial_status`, `created_at`, `shop`, `item_count`, `items` and `line_items`.
- On connect, Daloy registers `ORDERS_CREATE` at `<PUBLIC_URL>/hooks/shopify/<path>`. An existing subscription to that address is kept, and an older one under Daloy's own `/hooks/shopify/` prefix is removed. The owner's other subscriptions are never touched. If Shopify refuses (it needs a public https address and `read_orders`), the connection is still saved with `webhook: failed` and the reason. Disconnect removes Daloy's subscription as a best effort.
- Turning on a workflow with the trigger or a product step needs a working Shopify connection, like the other apps.
- A product step cannot read `{{trigger.*}}` from a public form, an unsigned webhook, an inbound email or a DM, so a stranger cannot choose what is written to the owner's store. A Shopify order is in the trusted list (it is signed by Shopify).
- Templates: `shopify-orders` uses the native trigger and sends the receipt only when the order has an email. `store-orders` stays a generic webhook, renamed "WooCommerce or other store orders", because onboarding uses it as the stopgap for any seller (decision 0083).
- The app mark is Simple Icons' Shopify (CC0) in `apps/web/public/logos/shopify.svg`, recorded in the logos README.

## Consequences

- An owner makes an app in the Dev Dashboard of the organization that owns the store. A store owned by another organization (an agency's client, say) cannot use the client credentials grant; that needs a public app with OAuth, which is a separate phase.
- `read_orders` touches protected customer data. Whether name, email and phone arrive for a Dev Dashboard app without asking Shopify for that access was not confirmed from the docs. The live check records what a real delivery contains, and the order template copes with a blank email.
- Deliveries of one run are sent in no set order, so a run that creates a product and then updates the same product is not supported.
- Each API and worker process asks for its own token once a day. If Shopify limits the token endpoint, the token moves to the connections row.
- Not built: stock and inventory (they need two more scopes), deleting or archiving products, variants and options, collections, order updates, a reconciliation job for missed webhooks, and a "re-register webhook" button (saving the connection again does it).
- Not verified against a real store: `productVariantsBulkUpdate` accepting `inventoryItem.sku`, money values sent as strings, and the token lifetime. [The live check](../live-shopify-check.md) lists what to run.
- Orders larger than the API's 256 KB body limit are refused with 413 and Shopify retries them. A typical order is a few KB.
- Numbers: the Discord and Google Docs branch (I1) merged first with decision 0104 and migration 0047, so this phase took decision 0105 and migration 0048, regenerated with drizzle-kit on top of 0047 (decision 0101).
