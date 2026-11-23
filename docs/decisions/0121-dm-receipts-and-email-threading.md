# 0121: DM receipt photo claims and email reply threading

## Context

C6 of the resort concierge plan (`docs/plans/resort-concierge.md`). Two gaps remained after C1 (decision 0115):

1. Guests often send a GCash or bank transfer screenshot directly in Messenger or Instagram instead of opening the pay page (`/pay/:token`). Until now those photos could only run through an AI step; they could not become a claim on the guest's open `payment_dues` row in Receipts to review.
2. Replies sent by the `email` step on an email-in conversation carried no `In-Reply-To` or `References` headers and were not recorded in `conversation_messages`, so mail clients split each concierge reply into a new thread.

## Options

1. Let a DM photo auto-confirm a due or attach to the latest due in the workspace. Rejected: a screenshot is never proof of payment (decision 0088), and guessing across conversations risks attributing a receipt to the wrong guest.
2. Link each conversation to at most one open due (`conversations.open_due_id`), turn a DM image into one manual transfer claim through the same flagging pipeline as the pay page, deduplicate by `(user_id, source_mid)`, and never change `payment_dues.status` from `pending`. Chosen.
3. Pass inbound `Message-ID` and `References` straight from `mailparser` into `nodemailer` on every email step in the run. Rejected: untrusted email headers can contain CR/LF header injection or non-Message-ID text, and an internal staff alert sent during the same run would leak the guest's thread headers to staff.
4. Strictly validate RFC 5322 Message-IDs (`<local@domain>`, no CR/LF or NUL, capped at 20 references keeping the thread root), store sanitized `email_references` on `conversation_messages`, and attach `In-Reply-To` and `References` only on a single-recipient reply whose address matches the email conversation's `external_id`. Chosen.

## Decision

- Migration `0052_dm_receipts_email_threading.sql`:
  - `conversations.open_due_id` (nullable uuid referencing `payment_dues.id` with `on delete set null`, partial index where not null).
  - `payment_claims.source_mid` (nullable text, partial unique index on `(user_id, source_mid)` where not null).
  - `conversation_messages.email_references` (`text[]`, default `'{}'`, check `cardinality <= 20`).
- Due lifecycle (`packages/db/src/payment-review.ts`, `apps/worker/src/steps/index.ts`):
  - `createDue` accepts an optional `conversationId` (from `runs.conversation_id` when `payment_due` executes). For live dues (`!test`), it sets `conversations.open_due_id` for that conversation scoped to `user_id` (or falls back to an existing Messenger conversation matching `replyTo` when `replyChannel === "messenger"` and no `conversationId` was passed).
  - `confirm` (manual review or PayMongo checkout), `expireDue`, and checkout refunds clear `conversations.open_due_id = null` wherever `open_due_id = due.id`.
- DM receipt claims (`submitDmReceiptClaim` in `packages/db/src/payment-review.ts`, `MetaHooksController.receive` in `apps/api/src/public.ts`):
  - When a Messenger or Instagram DM arrives with image attachments and `openDueForGuest` finds a live `pending` due on that conversation, the webhook downloads the images through the existing SSRF-safe Meta CDN downloader and calls `submitDmReceiptClaim` with the first verified image. A single message with multiple image attachments produces one claim row (all verified images still attach to any workflow run's uploads).
  - `submitDmReceiptClaim` runs in its own transaction that locks only `payment_dues` (never `conversations`), avoiding lock-order deadlocks against `confirm` and `expireDue` (which lock `payment_dues` then update `conversations`).
  - Claims use `channel: "transfer"` and share `evaluateTransferClaim` with the pay page: optional transfer reference (`extractDmReceiptRef`) and explicit peso amount (`extractDmReceiptAmount`) from the caption are checked for `duplicate_reference` (against both `payment_claims` and `receipt_references`), `amount_mismatch`, and `unreadable_upload`. `OPEN_CLAIMS_PER_DUE` (5) and upload quotas still apply, and `QuotaError` or `TooManyClaimsError` does not fail the webhook with 500.
  - Replaying the same Meta `mid` returns the existing claim without inserting a row or charging upload quota again. If the conversation has no open due or the due is already `confirmed`, `cancelled`, or `refunded`, no claim is created. The due always stays `pending` until a human reviewer or matching PayMongo event confirms it.
- R6 privacy (`packages/db/src/privacy.ts`): `collect()` includes any due referenced by a matched conversation's `open_due_id`, so `exportCustomer` includes DM receipt claims linked that way and `deleteCustomer` erases their receipt images while keeping `payment_dues`, `payment_history`, and confirmed references in `keptOf()`.
- Email reply threading (`packages/db/src/mail.ts`, `packages/db/src/conversations.ts`, `apps/worker/src/imap.ts`, `apps/worker/src/email-in.ts`, `apps/worker/src/steps/index.ts`):
  - `sanitizeMessageId` accepts only RFC 5322 `<local@domain>` up to 255 characters with no CR, LF, NUL, or whitespace. `sanitizeReferences` validates each token, rejects CR/LF-polluted values, deduplicates in order, and keeps at most 20 entries (preserving the thread root and the most recent entries).
  - `parseIncomingEmail` and `email-in.ts` sanitize `messageId`, `inReplyTo`, and `references` (falling back to `inReplyTo` when `References` is omitted) and store the sanitized list in `conversation_messages.email_references`. If `messageId` is missing or invalid, `mid` falls back to the internal `imap:` dedup key, which `sanitizeMessageId` rejects before sending so internal keys never appear in email headers.
  - When the `email` step runs on an `email` conversation and `to` resolves to exactly one address matching `conversations.external_id` (case-insensitive), it loads `emailThreadFor(db, conversation.id)` and passes `thread` into `sendAs`, which applies `In-Reply-To` and `References` inside `message()` for both SMTP (`sendEmail`) and Gmail OAuth (`rawMessage`). After a successful send, `recordOutboundEmail` stores the `out` message and its generated `Message-ID` in `conversation_messages`.
  - Any email to another address (such as a staff alert) or to multiple recipients receives no thread headers and is not stored in `conversation_messages`.

## Consequences

- Guests who reply with a GCash or bank transfer screenshot in Messenger or Instagram land directly in Receipts to review with duplicate and amount flags intact, without ever marking an order paid automatically.
- Email concierge replies stay in the guest's existing mail thread across SMTP, Gmail app passwords, and Gmail OAuth, while staff alerts stay separate.
- Not done here:
  - The Outlook step uses Microsoft Graph `sendMail`, which rejects standard RFC headers such as `In-Reply-To` in `internetMessageHeaders`, so email threading applies to the `email` step (SMTP and Gmail) only.
  - The booking-specific first-reply privacy notice from decision 0115 stays on `meta_reply` only; generic `email` workflows (such as office inquiries) are not prefixed automatically, and C8's email concierge template carries its notice in its reply copy.
  - A DM message with multiple receipt screenshots attaches only the first verified image to the payment claim; staff can inspect additional images in run history if a workflow ran.
