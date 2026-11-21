# 0094: Customer privacy: form notice, receipt image retention, export and delete (R6)

## Context

Daloy holds personal data about the customers of each workspace: what they type into public forms and the pay page, receipt photos, DM text, and the messages Daloy sends them. The Philippine Data Privacy Act (RA 10173) gives those customers the right to be told what is collected and to ask for access and erasure. The owner of each workspace is the one who answers those requests. Daloy has to make that possible. It does not make the owner compliant: registering with the National Privacy Commission, naming a Data Protection Officer and writing a full privacy policy stay the owner's own tasks (listed in docs/how-it-works.md).

Where customer data lives today (one workspace = `user_id`):

| Table | What it holds about a customer |
|---|---|
| `runs.trigger_payload` | Every form, email, DM or API submission, as given |
| `step_runs.input`, `step_runs.output` | Resolved step configs and results, including AI prompts and answers (the AI usage notes) |
| `uploads` | Files sent through a form (already purged after 7 days) |
| `deliveries.payload`, `deliveries.result` | Rows, messages, recipients and SMS numbers sent to apps |
| `requests.subject` | The office request subject line |
| `bookings` | A time and a resource; the customer is known through the linked run |
| `booking_results.output`, `booking_changes.result` | Copies of booking step output |
| `calendar_events.title`, `.description` | Event text built from the customer's answers |
| `payment_dues.reply_to`, `.reply_text` | The customer's phone or Messenger id and the reply text |
| `payment_claims.image`, `.transfer_ref` | The receipt photo and the bank or GCash reference |
| `payment_history.detail` | Amounts and references for each change to a due |
| `paymongo_events.payload` | Kept PayMongo events, which carry billing name, email and phone |
| `receipt_references` | Normalized receipt references, used to catch a reused receipt |

`usage_counts` and `usage_claims` hold counts and step keys only, no customer data.

## Options

1. Delete the customer's runs outright. Cascades remove step runs, uploads, deliveries, requests and payments in one statement. It also removes payment dues and their history, which the owner needs for bookkeeping, so it was rejected.
2. Redact in place: keep the rows the accounting needs, blank every field that holds what the customer said or sent, and delete rows that have no other use. Chosen.
3. Pseudonymize with a per-customer key. More moving parts than a small business needs; rejected.

## Decision

Finding a customer. The owner types an email or a phone number. A run matches when any string in its trigger payload holds the email as a whole address (case-insensitive, so `maria@gmail.com` does not match `annamaria@gmail.com`), or holds a phone-shaped run of digits that, read as a Philippine number (`09...`, `639...`, `+63 9...`), equals the phone's. A due matches when its `reply_to` matches the same way; its run joins the set. PayMongo events match on the same test over their payload. Matching is done in code over the workspace's runs.

Export (`GET /privacy/customer?email=` or `?phone=`, owner only): one JSON file with the matched runs, their step inputs and outputs, uploads (base64), deliveries, requests, bookings with their changes and calendar text, dues with claims (receipt image base64) and history, and matched PayMongo events. Nothing from runs that did not match.

Delete (`POST /privacy/customer/delete`, owner only, typed confirmation): one transaction.

- Runs: `trigger_payload` becomes `{"erased": true}`, `error` is cleared, unfinished runs move to cancelled so nothing more is sent.
- Step runs: `input` and `output` set to null, `error` cleared. AI token counts stay (usage, not content).
- Uploads and deliveries of those runs: deleted.
- Requests: subject replaced with "Deleted on request". The reference stays.
- Bookings: the row stays as a held time (no name or contact on it). Booking result output and change results become `{}`. Calendar event rows are deleted; the event already in the owner's Google Calendar is the owner's to remove.
- Dues: `reply_to` and `reply_text` cleared. Amount, status, reference and confirmation stay, marked kept for bookkeeping.
- Claims: the receipt image is deleted. A confirmed claim keeps its transfer reference and amount for bookkeeping; other claims lose the reference too.
- Payment history: kept (amounts, events, who decided), marked kept for bookkeeping.
- Receipt references: kept, marked kept to catch reused receipts. They hold a reference number, no name.
- PayMongo events that match: payload set to null.

Audit: a new `privacy_requests` table records the workspace, who acted, export or delete, when, the counts per table and the kept items with their reasons. It never stores the email, the phone or any deleted value.

Retention: `payment_settings.receipt_retention_days`, default 90, from 1 to 3650, set on the Payments settings page. The worker's existing upload sweep also clears `image`, `image_type` and `image_size` on claims whose due closed (confirmed, cancelled or refunded) more than that many days ago, by the due's `updated_at`. Claims on open dues keep their image. Decisions and amounts stay in the payment history.

Notice: every public form and the pay page show one short line under the send button, in the workspace's language: who gets the answers, what they are used for, and that the customer can ask the business to see or delete them. It names the business. The owner cannot edit it in this phase. DM intake gets no notice in this phase, because Daloy only reads DMs after the customer has already written.

## Consequences

- A run that matched keeps its state, time and step trail, so run history and quotas stay consistent, but shows no customer content.
- Matching is a scan of the workspace's runs. Fine at small-business volumes; a large workspace would need an index or a customer table.
- A customer who wrote with a different email or number is not found. The owner can run the request again with each identifier.
- Data already sent to Google Sheets, Slack, Telegram, Airtable, Notion, Trello, Drive or by email is outside Daloy. The export lists those deliveries so the owner knows where to look; the delete cannot reach them.
- Backups, if the owner keeps any, still hold the old data until they roll over.
