# 0136: Payment and booking lifecycle, resource limits, and low findings (S3, S4, S5)

## Context

The 24 November 2026 security audit (daloy-run-1 against 47f34a3) identified eleven medium and low findings grouped into S3, S4, and S5:

- S3 (Payment and booking lifecycle):
  1. Cancelling a booking (via staff/MCP or a `booking` step) left any open pending `payment_dues` for that booking in `pending`, holding `conversations.open_due_id` and keeping the order slot blocked under `payment_dues_open_order`.
  2. `POST /conversations/:id/deposit-request` attached `conversationVersion` to the manual deposit run, and `runSuperseded` treated `conversationVersion == null` as superseded. Any subsequent guest reply bumped `conversations.version` and cancelled the deposit request run before its reminder or unpaid expiry step could run.
  3. `markPaymentRefunded` only transitioned `payments` rows from `paid` to `refunded`. A PayMongo checkout that landed in `needs_review` (for example, an amount mismatch) and was confirmed by a staff reviewer through `decideClaim` stayed `needs_review` on `payments`, so a later `payment.refunded` webhook did not mark the payment or the confirmed due `refunded`.
- S4 (Resource limits):
  1. `resolveJsonTemplate` had no cumulative output length bound, allowing repeated large placeholders in a JSON HTTP body template to allocate megabytes beyond `EXPRESSION_LIMITS.maxOutputLength` (100,000 characters).
  2. PDF text extraction (`pdfText` and `pdf-text-worker.mjs`) capped page count at 10 but did not cap extracted character length or total PDF characters across multiple attachments, and did not clean up page/document handles inside the worker thread.
  3. `pollEmailSources` claimed only one mailbox per tick sequentially, and `connectImap.readBatch` had no cumulative batch byte cap across its 20-message window, allowing one slow or large mailbox to delay polling for other workspaces.
- S5 (Low findings):
  1. `deleteCustomer` (`eraseRuns`) cancelled runs and nulled `step_runs` inputs and outputs without clearing `step_runs.claim_id` or failing active `running`/`waiting` step rows, and `advance` did not catch `cancelledUnderUs` on final step completion, allowing an in-flight step attempt to write customer data back after erasure.
  2. R6 customer privacy exports (`PrivacyController` and `ConversationsController`) built `historyHider` after `exportCustomer` had already matched and collected rows, allowing a current or retired workspace secret value in a payload to match a customer search query before redaction.
  3. Mutating `browser` steps (`click` or `fill`) were not included in `unsafeToRepeat` in `advance.ts` and did not call `claimSend`, so a worker crash mid-job left `dispatched_at` unset and allowed a takeover worker to repeat the click or form fill.
  4. `checkSignature` in `apps/api/src/public.ts` checked `c.requireTimestamp` before verifying `validSignature` when `X-Daloy-Timestamp` was absent, disclosing the timestamp requirement to unauthenticated callers that could not even sign the legacy format.
  5. `definitionSchema` in `packages/engine/src/definition.ts` checked direct `{{trigger.*}}` references on `shopify_create_product` and `shopify_update_product`, but did not run `untrustedSource` to reject values piped through an `ai` step or an intermediate step reading an untrusted trigger.

## Decision

- S3:
  - `cancelDuesForBooking` in `packages/db/src/bookings.ts` runs inside the booking cancellation transaction for both `bookFromStep` (`action: "cancel"`) and `staffChange` (`action: "cancel"`), moving open `pending` `payment_dues` of that booking (by `bookingId` or matching unlinked `reference`) to `cancelled`, clearing `conversations.open_due_id`, expiring pending `payments`, and recording a `cancelled` row in `payment_history`. Confirmed and refunded dues are untouched.
  - `POST /conversations/:id/deposit-request` creates its run with `conversationId` only (no `conversationVersion`), and `runSuperseded` in `packages/db/src/conversations.ts` returns `false` when `run.conversationVersion == null` while the conversation still exists.
  - `markPaymentRefunded` in `packages/db/src/paymongo.ts` transitions both `paid` and `needs_review` payments to `refunded`, and `decideClaim` in `packages/db/src/payment-review.ts` checks whether a confirmed checkout claim's payment was already refunded out of order and transitions the due to `refunded` immediately.
- S4:
  - `resolveJsonTemplate` in `packages/engine/src/json-template.ts` tracks cumulative output size during traversal and caps the serialized JSON string at `JSON_TEMPLATE_MAX_OUTPUT_LENGTH` (100,000 characters), throwing `ExpressionError`.
  - `pdfText` (`apps/worker/src/steps/ai-files.ts`) and `pdf-text-worker.mjs` enforce `MAX_PDF_PAGES` (10), `MAX_PDF_CHARS` (50,000 per PDF), and `MAX_TOTAL_PDF_CHARS` (100,000 across all PDFs in one AI step) under tighter worker thread resource limits (`maxOldGenerationSizeMb: 128`, `maxYoungGenerationSizeMb: 32`, `stackSizeMb: 4`) and explicit page/document cleanup.
  - `pollEmailSources` (`apps/worker/src/email-in.ts`) claims up to `MAX_POLL_WORKSPACES` (10) due sources per pass, strictly at most one mailbox per workspace ordered by live status and least-recently-checked workspace, and polls them concurrently; `connectImap.readBatch` (`apps/worker/src/imap.ts`) stops fetching further message bodies once a batch reaches `MAX_BATCH_BYTES` (2 MB) and advances `throughUid` only to the last fetched UID.
- S5:
  - `eraseRuns` (`packages/db/src/privacy.ts`) marks active `running` and `waiting` `step_runs` as `failed` (`outcome: "not_sent"`), clears `claim_id = null`, expires unused approval links, and collects runs linked via `runs.booking_id`; `advance.ts` catches `cancelledUnderUs` on step completion and failure transitions so a fenced in-flight worker exits quietly without writing outputs or enqueueing another step.
  - `PrivacyController` and `ConversationsController` initialize `historyHider` before calling `exportCustomer` and pass `{ hide }` into `exportCustomer` so `collect` masks current and retired secrets before matching customer queries.
  - `unsafeToRepeat` in `apps/worker/src/advance.ts` includes `browser` steps with `click` or `fill` actions, and `browserStep` in `apps/worker/src/steps/browser.ts` claims `claimSend` before sending the `/run` request and releases the row lock once the request is dispatched.
  - `checkSignature` in `apps/api/src/public.ts` verifies `validSignature` first when `X-Daloy-Timestamp` is absent, returning `"bad signature"` before checking `requireTimestamp`.
  - `definitionSchema` in `packages/engine/src/definition.ts` runs `untrustedSource` across all string config fields of `shopify_create_product` and `shopify_update_product`.

## Consequences

- Zero database migrations are required.
- Cancelling a booking frees its open pending payment dues and conversation `open_due_id` atomically, and staff deposit requests keep running through reminders and expiry even when the guest replies in the meantime.
- Refunds on PayMongo checkouts that were confirmed from `needs_review` now move both the payment and the due to `refunded` and trigger `payment` refund listeners.
- JSON body templates, PDF text extraction, and multi-workspace IMAP polling have deterministic memory, character, byte, and concurrency bounds.
- Customer erasure fences in-flight workers, R6 exports never match on or leak current or retired secrets, mutating browser steps park in `needs_review` on worker crash takeover instead of repeating, unauthenticated legacy webhook probes learn nothing about timestamp settings, and Shopify product steps reject untrusted values even through intermediate steps.
