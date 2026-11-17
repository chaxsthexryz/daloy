# 0045: PayMongo payments with Checkout Sessions and a webhook trigger

## Context

N12 asks for a payment link step and a signed webhook, so an order or invoice counts as paid only when PayMongo says so. A GCash screenshot is never proof. Test keys come first. Live mode needs the owner's PayMongo business verification.

## Options

- PayMongo Payment Links or Checkout Sessions.
- A step that waits for the payment in the same run, or a trigger that starts a new run.
- How old a webhook signature may be.

## Decision

- Checkout Sessions, not Payment Links. A session is created per request with an exact amount, a reference and metadata, and it takes an idempotency key. It offers GCash, Maya, card and QR Ph. A Payment Link is meant to be made once in the dashboard and shared.
- PayMongo is a sixth provider. Migration 0026 adds the `payments` table (one row per run and step, amount in integer centavos, status `pending`, `paid`, `refunded` or `needs_review`), the `paymongo_events` table (seen event ids), and widens the `connections_provider` and `deliveries_provider` checks.
- `PUT /settings/connections/paymongo { secretKey, webhookSecret }` stores both encrypted per workspace (AES-GCM, like the other connections) and never returns them. The mode comes from the key prefix. `sk_live_` is refused unless the server has `PAYMONGO_LIVE=on`. Each connection gets a random webhook path, kept when the keys are replaced.
- The base URL is `PAYMONGO_API_URL` (env only, default `https://api.paymongo.com`), so the fake server can stand in during tests. A user cannot set it.
- The step `paymongo_link` takes `amount` in pesos as text, `description` and `reference`. The amount is parsed from the string into integer centavos, with no floats, from 1.00 to 9,999,999.99. There is one link per run and step: a stored row is reused and PayMongo is not called again. The call carries `Idempotency-Key: runId:stepId` (PayMongo keeps it 24 hours). A timeout after the request left goes to needs_review, like an HTTP step (decision 0030). It counts as `http` usage for quotas. Mocked runs call nothing.
- The trigger "When a PayMongo payment is confirmed" starts a run for each published workflow that listens for the status (`paid`, `refunded`). The payload is `{ status, reference, amount, currency, paymentId, sourceRunId, providerPaymentId }`, with the amount in centavos.
- Webhook `POST /hooks/paymongo/:path`: the path finds the connection. `Paymongo-Signature` is `t=<unix>,te=<hex>,li=<hex>`. The signed string is `t.rawBody`, HMAC-SHA256 as hex, compared in constant time. Only `te` counts for a test connection and `li` for a live one. The event's `livemode` must match the connection.
- Paid: the payment row is found by the `cs_` session id inside the workspace. The paid amount and currency must equal the stored centavos and PHP. If not, the row goes to `needs_review` and no run starts. State only moves pending to paid to refunded, or pending to needs_review, never back.
- Runs are keyed `paymongo:<paymentId>:<status>` and are started whenever the payment is in that status, not only when this call changed it. A crash between the update and the run start is healed by PayMongo's retry, and a replay or a second event starts nothing. The event id is recorded after processing. A seen id answers 200 `duplicate`.
- Why a trigger and not a wait step: a payment can arrive minutes or days later, and a run that waits holds a step, a timeout and a quota for nothing. A second run, keyed by the payment, is simpler to retry and to read. The cost is that the follow-up run is a separate run (it gets `sourceRunId`).
- Why 72 hours: a retry may carry its original `t`, and PayMongo disables a webhook after repeated failures, so a tight window could switch the webhook off. A `t` more than 5 minutes in the future is refused. Tighten the window after the live check shows whether a resent event carries a fresh `t`.
- The API address is `urls.paymongo`, default `https://api.paymongo.com`, so the fake server can stand in during tests.
- Not handled: `payment.failed` (the checkout stays payable), expiry (PayMongo sends no webhook, so the row stays pending), partial refunds (`payment.refund.updated`), registering the webhook for the owner, and a "wait for payment" step in the same run.
- PayMongo's pages disagree on what is signed. One shows the body alone. We follow the Setup & Management page (`t.body`, `te` and `li`). The live check verifies it against a real delivery.

## Consequences

- The owner must make the webhook in PayMongo by hand (Developers, Webhooks, events `checkout_session.payment.paid` and `payment.refunded`) and paste the `whsk_` secret into Daloy. The URL is `<public URL>/hooks/paymongo/<path>`.
- A valid but unhandled event answers 2xx, so PayMongo does not disable the webhook. Only a bad signature, an unknown path or a server error is not 2xx.
- An expired or abandoned link leaves a pending row. Nothing marks it unpaid.
- Migration number: 0026, not 0025. 0024 and 0025 belong to the N8 and N13 branches. The journal entry has `idx` 26 and is non-contiguous on purpose. At merge the snapshot chain (`0026_snapshot.json` and the `prevId` of whatever follows) must be re-pointed at the real previous snapshot.
- Not tested against real PayMongo until [the live check](../live-paymongo-check.md) is run.
