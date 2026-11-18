# 0056: Payment fixes from the 19 November review

## Context

The security review of 19 November (`docs/security-review-2026-11-19.md`) found six payment problems (roadmap N11c-1):

- H1. The order starter takes the price from the buyer's form, so a paid notification can be genuine for the wrong price. The pending row is in pesos and the paid row in centavos.
- H2. A sandbox payment starts the payment listeners as ordinary runs, which send real messages and write real rows. A builder test that made a live link loses its test flag the same way.
- M2. The invoice starter takes unsigned calls with no business key, so a retry or a captured call makes a second invoice. On a signed call the `Idempotency-Key` header, which the signature does not cover, decides what counts as a repeat. Operators can read the webhook URL.
- M3. PayMongo event ids are unique across the installation, so a workspace without the order can record an event first and the workspace that has the order then calls it a duplicate.
- M4. A refund that arrives before its paid event is recorded and dropped, so the later paid event leaves a refunded order marked paid. A paid event that arrives before Daloy stores the checkout session is dropped the same way.
- M5. Turning `PAYMONGO_LIVE` off does not stop new live checkouts from a live key saved earlier.

## Options

H1:

1. An owner-maintained price list that the link step reads. Rejected for now: it needs a new data model and a settings page, and shops that sell online get an authoritative total from their store (the review's WooCommerce note).
2. Put an owner approval in front of the link in the order starter, the way the quote starter already works. The owner sees the item and the amount and approves only a price they set. Chosen.
3. Refuse any payment link whose amount comes from a public field. Rejected: the quote and invoice starters use a reviewed or signed amount on purpose, and the engine cannot tell a reviewed value from an unreviewed one.

H2:

1. Start the listeners for a sandbox payment, or for a payment made by a builder test run, as test runs. The worker already mocks outside steps in a test run. Chosen.
2. Skip the listeners for sandbox payments. Rejected: the owner could not see what the follow-up would do.
3. A separate test destination per step. Not now: nothing else in Daloy has one.

M2:

1. The invoice starter names a signing secret, requires the timestamp and uses the invoice number as its event key, so the key is inside the signed body. On a timestamped signed call the signature, not the header, is the repeat key when there is no event key. Operators no longer see the webhook URL, and a New URL button in the editor replaces it (turning an automation off kept the old path). Chosen.
2. A new signature scheme that covers the header. Rejected: every sender would have to change again two weeks after decision 0054.

M3: the event table's key becomes workspace plus event id, and every lookup includes the workspace.

M4:

1. Keep an unmatched paid or refund event, with the fields needed to apply it, before answering 200. A paid event applies a kept refund for the same payment. Storing a checkout session applies a kept paid event for it. Chosen.
2. Answer an error so PayMongo retries. Rejected: PayMongo disables a webhook that keeps failing.

M5: the worker checks the live switch right before creating a session and refuses a live key while it is off. The webhook still settles live events, so payments already made are recorded.

## Decision

The chosen options above. The payment trigger payload gains `livemode` and `amountPesos` (text such as `150.50`), and the link step's output gains `amountPesos`, so both sheet rows of the order starter use pesos and the Daloy payment id as the order reference.

## Consequences

- An office whose PayMongo connection is in test mode sees its payment listeners run as test runs, with mocked emails and sheet rows. That is the point of test mode.
- A workspace that uses the order starter approves each order before the buyer gets a link. A price list is the follow-up if offices find that slow.
- A signed webhook sender that retries with a new timestamp must use an event key to avoid a second run. The `Idempotency-Key` header still works for unsigned and old-format calls.
- The migration may need renumbering if another N11c branch adds one first.
