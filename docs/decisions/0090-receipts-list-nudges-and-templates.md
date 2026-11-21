# 0090: Receipts to review, unpaid nudges and the payment templates

## Context

R3 asks for one Receipts to review list for manual cases and automatic exceptions, with payment state and reply state kept apart, unpaid-order nudges that are visible and editable in the workflow, and a receipt-review template plus an automatic-checkout example that onboarding (R1) can offer.

## Options

- Nudges as a scheduler inside Daloy that texts unpaid orders, or as ordinary steps of the workflow.
- The reply state as a column on the due, or read from the delivery that carries the reply.

## Decision

- Receipts to review (`#/receipts`, `GET /payments/review`) lists open and clarify claims oldest first, then confirmed dues whose confirmation reply is `failed` or `needs_review`. Each row shows the order and booking, the amount due, the submitted amount, the reference, the channel and the age. Owners and operators see it; approvers and requesters do not.
- Reply state is the state of the reply delivery, not a column. "Payment confirmed, Reply failed" offers Retry reply, which re-queues that delivery with `retryDelivery` and writes `reply_retried` to the history. The due is not touched. A reply in `needs_review` may have gone out, so the list sends staff to Activity instead of offering a blind resend.
- Nudges are steps: `delay`, `payment_status` (which now reads a `payment_due` step), a `condition` on `pending`, and an `sms` or `meta_reply` step. The deadline is `payment_expire`, with branches `expired` and `kept`. The seller sees and edits each step and its wait on the canvas, and there is no hidden scheduler to explain.
- Templates: `booking-deposit-review` (form, staff approve the booking, then a 350 peso deposit of a 1,200 peso total, a reminder after 6 hours, the slot released after 24) and `order-gcash-checkout` (a signed order webhook, PayMongo checkout, a reminder after a day, cancelled after three days). The booking template keeps the existing rule that a public form books only after an approval. Both have Tagalog copy.
- Deposits and balances: a deposit with a total shows the rest as the balance outstanding. A pay-later booking asks for a `balance` due and has no deadline step, so the booking stays active with the balance outstanding.

## Consequences

- A reminder SMS goes out when the customer has paid but the reviewer has not confirmed yet. A seller who expects that can add "Ignore this if you already sent your reference" to the reminder text.
- The deadline releases the slot only when no reviewer confirmed and PayMongo is not mid-payment. A receipt that arrives after the deadline is flagged `late_payment` for the seller to decide.
- R1 picks templates by slug.
