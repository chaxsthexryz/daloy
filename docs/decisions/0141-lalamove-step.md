# 0141: Lalamove delivery booking step (L1)

## Context

Sellers who confirm an order then book a Lalamove rider by hand in the Lalamove app. L1 adds a step that books the rider for them. The plan gated the work on four checks against Lalamove's own pages, done on 25 November 2026:

- A third-party tool may use the seller's own key. The Lalamove API Terms & Conditions (https://partnerportal.lalamove.com/terms-of-use, last updated September 2021), section 2(a), let a user pass API access and credentials "to reputable third-party software developers for the sole purpose of facilitating your use", called an Authorized Third party. The user stays responsible for that use.
- A free sandbox exists. https://developers.lalamove.com/ says sandbox keys need "no additional credentials or approvals", and sandbox prices are mock values. The base URL is https://rest.sandbox.lalamove.com.
- The Philippines is a supported market: code `PH`, language `en_PH`, with Manila NCR and South Luzon, North and Central Luzon, and Cebu listed.
- The API costs nothing beyond deliveries. Terms section 4: the APIs "are currently provided for free", with the right to charge later after notice. Deliveries are paid under the normal Lalamove terms, and production keys need a Lalamove Wallet top-up first.

Other terms that bind how kymavo uses it: no scraping of Lalamove data (6(d)), no public claim of a partnership (3(c)), and no aggregated view that puts Lalamove next to a competing courier unless agreed (3(b)).

## Options

1. A new `lalamove` connection provider with its own Apps card. This needs a migration for three provider check constraints, an API endpoint and a web card. The web app is being revamped in the main checkout, so this phase may not touch web pages.
2. The existing Secrets store (`secrets` table, AES-256-GCM per workspace, already in the history redaction list). The seller saves `lalamove_api_key` and `lalamove_api_secret` on the existing Secrets page, and the step reads them with `readSecret`. No migration and no new page.
3. Let sellers call Lalamove from the HTTP step. The HTTP step cannot compute the HMAC signature, and it would put the secret in templates.

## Decision

Option 2. One `lalamove` step does a quotation and then places the order.

- Signing follows the docs: `HmacSHA256ToHex("<ms time>\r\n<METHOD>\r\n<path with /v3>\r\n\r\n<body>", secret)`, sent as `Authorization: hmac <key>:<time>:<signature>`, with `Market: PH` and a random `Request-ID`. The docs' worked example leaves its body out (`JSON.stringify({...})`), so the unit test pins the signature to a value computed separately with `openssl dgst -sha256 -hmac`.
- Sandbox is the default. `live: true` in the step config switches to https://rest.lalamove.com. The key's prefix must match: a `pk_prod` key on a step that is not live is refused, and so is a `pk_test` key on a live step, both before any request.
- A sample run and a test run (including "try this step for real") always return a fake booking and never read the keys or call Lalamove.
- The quotation is a read and may be retried. The order goes through `claimSend`, and `lalamove` is in `unsafeToRepeat`, so an attempt that died after sending the order goes to review instead of booking a second rider. Lalamove documents no idempotency key for orders.
- The step can only run from a manual run, a schedule, a PayMongo payment, a Shopify order or a signed webhook, and refuses fields from AI steps or steps that read a public trigger. A public form could otherwise book riders at the seller's cost.
- Phones go through `normalizePhMobile` (Philippine mobiles to `+63...`), and coordinates must be decimal degrees.
- The step uses the "link" line icon, because no Lalamove logo is bundled and this phase may not touch web assets.
- The local-model AI draft prompt leaves the step out (it is in `HOSTED_ONLY`), like the other paid-provider steps.

## Consequences

- Sellers paste coordinates or send them from their shop. kymavo does no geocoding, since a geocoding API would be a new paid or rate-limited dependency.
- One pick-up and one drop-off per step. Multi-stop orders, scheduled pick-ups, priority fees, order status webhooks and cancellation are left out until a seller asks.
- Service types differ by city. The step takes the name as typed (default `MOTORCYCLE`) and Lalamove refuses an unknown one with a plain error.
- Lalamove may start charging for the API after notice (terms section 4). If it does, the step has to be revisited against the free-only rule.
- The live path is checked against the docs and a fake server only. No live or sandbox call was made from this phase, since that needs a Lalamove account.
