# 0089: Automatic checkout confirmation, exceptions and reconciliation

## Context

R3's automatic path reuses PayMongo Checkout Sessions (decision 0045). The roadmap asks that only an authenticated event that matches workspace, checkout, order, currency and amount confirms a payment, that repeated events give one transition and one confirmation, that mismatches go to review, that failed and expired checkouts and later refunds are handled, and that a manual transfer arriving while checkout is pending does not lead to a second confirmation.

## Options

For one confirmation: a flag on the due, or a unique key on the reply itself.

For mismatches: keep `payments.needs_review` as the only signal, or turn each one into a claim in the same review list as manual receipts.

For expiry: wait for an event, or expire the session from the deadline step.

## Decision

- `payment_due` with `checkout: true` makes the checkout with the existing `paymongoLink` code, so the session is idempotent per run and step. The payment row gets `due_id`.
- The webhook verifies the signature and mode as before (0045, 0056), moves the payment row with `markPaymentPaid` or `markPaymentRefunded`, then calls `settleCheckout`. That function locks the due, re-reads the payment and confirms the due only when the payment is `paid`, the paid amount and currency equal the due's, and the payment's reference equals the due's order reference. The workspace comes from the webhook path, and the checkout from the session id inside that workspace.
- `markPaymentPaid` now stores the paid amount and currency, and also moves an `expired` payment to `needs_review`, so a payment after the deadline is never taken as paid.
- Anything that does not confirm becomes a claim with channel `checkout`, keyed by the payment (`payment_claims.payment_id` is unique), so a replay adds nothing. Flags: `amount_mismatch`, `paid_twice` (the due was already confirmed by a transfer) or `late_payment` (the due was cancelled at the deadline). A reviewer confirms it (after checking the PayMongo dashboard) or rejects it with a reason, for example after refunding.
- One confirmation: the reply is a delivery with step id `<due step>#confirmed`, and deliveries are unique per run and step. It is queued only by the pending to confirmed update, inside the transaction that holds the due lock. Whichever path confirms first sends it; the other path finds the due confirmed and becomes a claim, or, for a transfer receipt, is flagged `already_confirmed` and cannot be confirmed.
- Failed checkout: PayMongo opens a new payment intent when a customer retries, and the session stays payable, so a `payment.failed` event changes nothing (it is answered 200 and recorded). The unpaid nudge and deadline cover a customer who gives up. Daloy does not read the failed event's payload, because PayMongo's documentation does not say how it maps to a session.
- Expiry: PayMongo sends no expiry webhook. The `payment_expire` step calls the Expire API (`POST /v1/checkout_sessions/{id}/expire`) before it cancels the due. A 400 means it is paid or a payment is in progress, and the step takes the `kept` branch so the paid webhook can settle it. Otherwise the due is cancelled, the payment row becomes `expired` and the booking slot is released through the booking step code (decision 0032), in that run.
- Refund: `payment.refunded` for the payment that confirmed a due moves the due to `refunded`, once.

## Consequences

- A manual transfer confirmed while a checkout is open does not expire the checkout. The decision answer says it is still open, and a later checkout payment shows as `paid_twice`.
- Partial refunds (`payment.refund.updated`) are still not handled.
- The Expire API and its 400 are taken from PayMongo's documentation and checked only against the fake provider until the owner's live check.
