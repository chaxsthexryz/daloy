# 0093: Morning digest, payments CSV, Taglish templates and photo compression

## Context

R5 adds four daily tools for a seller: one email each morning with what needs a person, a CSV of confirmed payments for bookkeeping, Taglish wording for the templates that message customers, and smaller photos from the phone. The owner pre-approved the phase, so this record is the plan and the decisions in one. The next free decision number was 0092 when this was written (R2b and R6 run at the same time and may take the same number; renumber at merge time). The migration is 0044 for the same reason.

## Options

- Digest: a scheduler row per workspace, or one more check in the worker's existing one minute tick.
- Digest channel: email, Messenger or Telegram.
- Digest default: on for everyone, or off until the owner turns it on.
- CSV: a new writer, or the N19 helper (`apps/api/src/csv.ts`) that already escapes formula cells.
- Taglish: a third workspace language, or a wording choice on the templates.
- Compression: in the browser before upload, or on the server after upload.

## Decision

- The digest runs in the worker's existing minute tick (`apps/worker/src/digest.ts`), next to the N17 watchdog and the broken-grant alert. It sends from 8 am until noon Manila time, once per Manila day. `users.digest_sent_on` is claimed with a conditional UPDATE, so two workers send one email, and a failed send gives the day back. A morning with nothing to do sends nothing and uses up the day: a receipt that arrives at 10 waits for tomorrow. A worker that was down at 8 still sends at 9, but not in the afternoon.
- It counts three things for real (not test) runs of the workspace: open or clarify receipts, pending dues, and SMS or Messenger deliveries in `failed` or `needs_review` from the last 7 days. The email has counts and one link per line (`#/receipts`, `#/activity`) and no customer name, number or reference, because email is the least private channel we have. English and Tagalog copy follow the workspace language.
- Email only. Messenger and Telegram are not built: they need a recipient stored for the owner and, for Messenger, the 24 hour reply window, which a morning message would usually miss. Left for a later phase.
- It goes through the installation's server to the owner's login address, like the broken-grant alert, so it never uses the owner's Gmail daily cap (N11b) and does not depend on a connected mailbox.
- Off by default (`users.digest_enabled`). Nobody gets a new daily email they did not ask for, and the e2e mail sink does not see surprise messages. The owner turns it on under Receipts to review (`PUT /settings/digest`, owner only).
- The CSV is `GET /payments/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` for owners and operators, through `toCsv` and its formula escaping. It lists confirmed and refunded dues of real runs, by the Manila day of the confirmation, both ends included, at most one year. Columns: `confirmed_on, confirmed_at, reference, booking, kind, amount_php, total_php, status, source, transfer_reference, confirmed_by`. Money is formatted from integer centavos with no floats. The reference and the transfer reference come from customers and workflows, so the escaping matters: a leading `=`, `+`, `-`, `@`, tab or return gets a quote.
- Taglish is a wording style, not a language: `templatesForLanguage(language, "taglish")`. It replaces only the customer messages of `booking-deposit-review`, `order-gcash-checkout`, `invoice-follow-up`, `appointment-reminder`, `no-show-follow-up` and `store-orders` (`packages/engine/src/taglish.ts`). Steps, branches, waits, amounts and placeholders stay, which a test checks. The console, the pay page and the emails stay in the workspace language, so the language list does not grow a third value. The choice is on the New automation page, next to Start from.
- Compression is a small static script (`/public/compress.js`, so `script-src 'self'` holds) loaded by the pay page and by public forms with a file field. On choosing a JPEG, PNG or WebP it draws the image to a canvas whose longest side is at most 2000 px and encodes a JPEG at quality 0.8. It keeps the original when decoding fails, when the result is not smaller, and when the file is 300 KB or less and already fits. HEIC, PDF and anything else are untouched. The submit button is disabled while it works. The server is unchanged: it still reads the type from the bytes and refuses files over 5 MB (N21 and decision 0091), so a skipped or edited script changes nothing. A receipt is still readable at 2000 px, and a 4000 x 3000 camera photo drops from several MB to a few hundred KB.

## Consequences

- The digest says "unpaid orders" for every pending due, including ones the nudge steps are already handling, so a seller with many open orders sees a large number. It is a count, not a to-do list; the orders are in Activity.
- Manila time is fixed (UTC+8, no daylight saving), as for the daily quotas. A seller abroad gets it at Manila morning.
- The digest needs a working SMTP server for the installation. Without one, the send fails, the day is given back and the worker logs the error each minute until noon.
- Compression re-encodes screenshots as JPEG, which softens fine text slightly. A phone that cannot decode an image uploads it as it is.
- The Taglish copy is written by hand for six templates. Other templates keep their English or Tagalog copy until they get Taglish text.
