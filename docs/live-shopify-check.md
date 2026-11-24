# Manual live Shopify check

The automated tests never contact Shopify. They use a fake server (`test/fake-shopify.ts`) and signed test orders. This page is the separate check against a real Shopify store. Run it by hand against a free development store, never against a store that sells to customers. Never paste a client secret, an access token or a webhook link into a ticket, chat or this file.

Status: not run yet. Record the date, the kymavo commit and what you saw at the end of this file when you do.

## Before you start

You need a Shopify Partner account with a development store (both are free), kymavo running with a public HTTPS address set as the public URL (a tunnel is fine, since Shopify only delivers webhooks to a public https address), and a way to see the worker logs.

The app and the store must belong to the same Shopify organization. If the store is outside it, Shopify refuses the token request with `shop_not_permitted` and kymavo says so.

## Part 1: make the app and connect it

1. In the Shopify Dev Dashboard, make an app in the organization that owns the development store. Give it the scopes `read_orders` and `write_products` and no others. Release a version, then install the app on the development store.
2. Copy the app's client ID and client secret from its Settings. Keep them out of anything you save or share.
3. In kymavo, open Apps, then Shopify. Enter the shop domain (`your-shop.myshopify.com`), the client ID and the client secret. Save. Expect a connection with the shop name and `webhook: registered`. If kymavo lists missing scopes, add them to the app, release a version, accept it on the store and save again.
4. Select Test. Expect the shop name, no missing scopes and the webhook state.
5. Try a shop domain that is not `*.myshopify.com` (for example `example.com`). Expect a refusal before anything is sent.
6. In the Shopify admin, open Settings, Notifications, Webhooks if the store shows it, or query `webhookSubscriptions` through the GraphQL API. Expect one `ORDERS_CREATE` subscription whose address is `<public URL>/hooks/shopify/<path>`. If the store hides webhooks created by an app, say so in the results.
7. Save again with the same details. Expect the same address and still one subscription.
8. Turn the public URL off or point it at plain http and save. Expect the connection to be saved with `webhook: failed` and the reason from Shopify.

## Part 2: orders

1. Make an automation from the Shopify orders template, or one with the trigger "When a new Shopify order comes in" and a visible step (an email to yourself or a Slack note) that uses `{{trigger.order_number}}`, `{{trigger.customer_name}}`, `{{trigger.total}}` and `{{trigger.items}}`. Publish it.
2. In the Shopify admin, enable the Bogus Gateway (Settings, Payments, Manage, Bogus Gateway) or use the store's test mode. Place an order from the storefront with card number `1` (success).
3. Expect exactly one run within a minute. Open it and check `order_id`, `order_number`, `customer_name`, `customer_email`, `customer_phone`, `total` (text, for example `"499.50"`), `currency`, `financial_status`, `created_at`, `shop`, `item_count`, `items` and `line_items`. Write down which customer fields were empty (see the open items below).
4. Resend the webhook. If the admin has no resend button, send the same delivery again with a saved copy of the signed request. Expect kymavo to answer 200 and no second run.
5. Place a second order. Expect a second run, keyed by that order.
6. Tamper check: send a request to the webhook address with a valid-looking body and a wrong or missing `X-Shopify-Hmac-Sha256`. Expect 401 and no run. A wrong path must give 403.
7. Pause the automation and place an order. Expect no run and no failed deliveries in Shopify (kymavo still answers 200). Resume it.
8. Cancel an order or edit it. Expect no run, since only `orders/create` is subscribed.

## Part 3: products

Make an automation with a manual trigger and one product step each time, so you can run them by hand. Use fixed values, not trigger fields from a form.

1. Create product with a title, a description with `<b>` and a line break in it, a price `499.50`, a SKU (for example `DALOY-TEST-1`), status draft and an `https://` image link. Expect a delivery that ends delivered, and a product in the admin with the price, the SKU, the image, and the description shown as text with the line break, not as bold.
2. Run the same step again. Expect a refusal that names the SKU already in the store (not a second product).
3. Create product with no SKU. Expect one product. This step has no check against duplicates, so do not retry it by hand.
4. Update product by SKU: set the price to `550.00` and the title to a new name. Expect the same product changed, nothing else touched.
5. Update product by id: paste the number from the product's admin link. Change the status to active. Expect the same product changed.
6. Update product by SKU with a SKU that matches nothing. Expect a plain refusal.
7. In the admin, add a second variant to the product and make a third product with two variants. Try to change the price by product id. Expect a refusal that says the product has several variants. Change the price by SKU for one variant. Expect that variant changed.
8. Try a price such as `12,50` or an `http://` image link. Expect a refusal when the automation is saved or run, before anything is queued.
9. Reconnect kymavo to a second development store (or another shop you own) while a delivery is waiting, then look at it. Expect `needs_review` with a message that the connection changed. Choose Post again and expect it in the new store.
10. Disconnect Shopify, run a product step, then reconnect and choose Retry. Expect it delivered.
11. To see a throttled or unknown outcome for real, you would need Shopify to fail. Do not try to force it. The fake covers it.

## Part 4: disconnect and secrets

1. Disconnect Shopify in kymavo. Expect the `ORDERS_CREATE` subscription kymavo made to be gone from the store, and any subscription you made yourself to still be there.
2. Place an order. Expect no run.
3. Search the run history, the deliveries list and the worker and API logs for the client secret, the client ID and any `shpat_` or access token value. Expect none.

## Open items to confirm

- Whether customer name, email and phone arrive in `orders/create` for this app. Shopify may withhold them until the app has protected customer data access, which is requested in the Dev Dashboard. Note what the payload held, and whether requesting access was needed.
- Whether `productVariantsBulkUpdate` accepts `inventoryItem.sku` for the pinned version, so the SKU is set in the same call as the price.
- Whether money sent as strings (`"499.50"`) is accepted by the price field.
- Which `WebhookSubscriptionFormat` Shopify uses when the subscription does not name one (kymavo sends none, and reads JSON).
- The real lifetime of the client credentials token (kymavo expects 24 hours and renews after a 401).
- Whether the older path still works for an existing app made in the store admin: connect with the shop domain, the Admin API access token (`shpat_...`) and the app's client secret, and place an order.
- Whether the 2026-10 API version is still the newest kymavo should pin, and that Shopify has not changed the shapes the code reads.

## Results

None recorded yet.
