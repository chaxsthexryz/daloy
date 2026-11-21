# 0088: Payment dues and manual transfer review

## Context

Roadmap R3 (`docs/roadmap.md`, section 4) asks for two payment paths that end in the same answer to "which orders still need my attention?". Many Philippine sellers share a QR Ph code or a GCash number and get a screenshot back. A screenshot is easy to edit or reuse, so it can never confirm a payment. Until now Daloy only knew payments as PayMongo checkout rows (decision 0045), keyed by run and step, with no order behind them and no way to record a manual transfer.

## Options

1. Widen the `payments` table so a row can also be a manual transfer.
2. A new row for what is owed on an order or booking (a due), with manual receipts and checkout exceptions as claims against it.
3. Approve manual transfers with the existing approval step.

## Decision

Option 2. Migration 0043 adds:

- `payment_dues`: one row per run and step (the new `payment_due` step), with the order reference, an optional booking, the kind (`deposit`, `full` or `balance`), the amount and optional total in integer centavos, and the status `pending`, `confirmed`, `cancelled` or `refunded`. It only moves forward. A check constraint makes `confirmed_source` and `confirmed_at` present exactly when it is confirmed or refunded. A partial unique index allows one open or confirmed due of each kind per order, so a second deposit request for D-1042 is refused.
- `payment_claims`: something a person decides about a due. A customer's transfer receipt is one (channel `transfer`). A PayMongo payment that did not match is another (channel `checkout`, decision 0089). Each claim has flags, a status (`open`, `clarify`, `confirmed`, `rejected`), a reason, who decided and when, and a version.
- `payment_history`: every change to a due, written in the same transaction as the change, in `clock_timestamp()` order. It is the one payment history a booking shows.

Option 1 would mix two lifecycles in one table, and option 3 confirms by run state instead of by order, so two paths could each confirm the same order.

Manual path rules:

- A claim never confirms anything. The order stays pending until a reviewer records a decision.
- Flags at submission: `duplicate_reference` (the normalized transfer reference was used in this workspace before, by a claim or by the Messenger receipt check of decision 0075), `amount_mismatch` (the amount the customer typed differs), `unreadable_upload` (the file is not JPEG, PNG, WebP or HEIC by its bytes; it is not stored), `already_confirmed` and `late_payment` (the due was confirmed or cancelled already). The same reference sent twice for the same order is one claim.
- Decisions: confirm, reject with a reason, or ask the customer (clarify) with a question. The reason or question goes to the customer on the due's reply channel. A clarify claim stays in the list and can be confirmed or rejected later.
- The assigned reviewer (the step's `reviewer`, an owner or operator) decides, or the owner. Without one, any owner or operator decides.
- Two reviewers at once: each decision sends the claim version it showed. The due row is locked first, then the claim, the same order the webhook uses, so the two never deadlock. The second reviewer gets a 409.
- Confirming records the source (`transfer`), the reviewer and the time, flags the due's other open claims `already_confirmed`, and queues the confirmation reply (decision 0089).

## Consequences

- A test run (mocked) makes no due. A live test run makes a test due that messages nobody and stays out of the Receipts list and booking views.
- Refunding a manual transfer is the seller's job in their own wallet. Daloy records no manual refund yet.
- Migration number 0043: R1 may take 0042. The journal entry has `idx` 43 and a `when` of 1795400000000, later than R1 is likely to generate, so a database that already applied 0043 still applies a 0042 that arrives later. At merge, check that 0042's `when` is lower and that the snapshot chain is re-pointed.
