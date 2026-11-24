# kymavo security review, 22 November 2026

This repeats the N11 real-accounts review for the surfaces added after N11a to N11d. The earlier reviews are [19 November](security-review-2026-11-19.md) and [the release candidate](security-review-release.md). The reviewed revision is `main` at `69b524a`, on branch `claude/n11-refresh-6c267e`.

It is a source review. I traced each new route from the controller through validation, the database queries and the worker. I ran the unit and integration tests, including the new regression tests below, against the disposable test database and the fake providers. No live provider, deployed host or real data was touched. The owner's live checks in `docs/live-*.md` are still the owner's to run.

Result: no High findings, 4 Medium (all fixed, each with a test that failed before the fix), 8 Low (all listed with a reason, none fixed in this pass).

Severity follows the 19 November review: High means a public or less trusted caller can cross an authorization or payment boundary with material consequences. Medium means a real weakness that needs a setting, a timing or a holder of a link. Low means hardening, or a weakness with little reach today.

## Scope

- Public pages E7 to E11: `/forms/:id`, `/forms/:id/embed`, the booking form and `/forms/:id/slots`, the approval landing and decision (`apps/api/src/public.ts`, `public-pages.ts`, `approvals.ts`, `apps/web/src/FormEmbed.tsx`).
- R3 payments: the pay page `/pay/:token` with the manual QR Ph receipt upload, Receipts to review (`/payments/*`), PayMongo checkout settlement for dues, nudges, migration 0043 (`apps/api/src/payments.ts`, `packages/db/src/payment-review.ts`).
- R6 privacy: customer export and delete, receipt retention (`apps/api/src/privacy.ts`, `packages/db/src/privacy.ts`).
- N7 UniSMS and N16 Messenger and Instagram: the Meta webhook, the 24-hour reply window, the receipt image download and vision check (`MetaHooksController`, `packages/db/src/meta.ts`, the `meta_reply`, `sms` and `ai` steps).
- R1 onboarding, R5 digest and payments CSV, and U1 to U7 where they touch the API (`onboarding.ts`, `digest.ts`, `workflows.ts` overview, disable a step).

## Medium findings

### M1. The pay page reads receipt uploads outside the shared upload budget, for any token

The form routes reserve the declared body size from one budget before multer reads a byte, and refuse an unknown form first (19 November, before release 2). The pay page `POST /pay/:token` had only the per-IP limit of 10 a minute. Multer buffered up to 5 MB per request in memory before the handler checked the token, so a caller with no valid link could hold memory from many addresses at once, outside the budget the forms share.

- Where: `apps/api/src/payments.ts:220` (the guard list), `apps/api/src/payments.ts:226` (the token check after multer).
- Proof: `apps/api/src/upload-budget.test.ts`, "holds the pay page to the same budget, and answers an unknown pay link before reading the body". Before the fix, a headers-only post to an unknown pay link waited for the body instead of answering 404.
- Fix: `UploadBudget` now takes the route's size limit and a lookup, and every multipart route draws from one counter. The pay page refuses an unknown token (404) and a declared size above one receipt (413) before reading the body, and answers 503 while the budget is full.

### M2. One pay link can flood Receipts to review and spend the workspace's upload allowance

The handler charged one upload before `submitTransferClaim` checked for a repeat of the same reference, and it charged for files that turned out not to be images and were never stored. There was also no bound on how many different references one order could have waiting. Anyone holding a pay link (the customer, or whoever the link was forwarded to) could post 10 references a minute with 5 MB images, filling the review queue and the database, and use up the office's daily uploads so real customers could not attach receipts. This is the 19 November M15 pattern on a new route.

- Where: `apps/api/src/payments.ts:252` (the charge before the call), `packages/db/src/payment-review.ts:98` (no cap).
- Proof: `apps/api/src/payments.test.ts`, "charges one upload for a repeated reference and caps the open references on one order".
- Fix: the upload is charged inside the claim transaction, after the repeat check, and only for an image that is stored. One order can have at most `OPEN_CLAIMS_PER_DUE` (5) transfer references open or waiting for the customer; the next one gets 429 and a message to wait for the seller. A quota or cap refusal stores nothing. See decision 0102.

### M3. The customer data export skips the secret redaction every other history reader applies

The export returns raw `runs`, `step_runs` and `deliveries` rows. A step's input or error can hold a resolved workspace secret (an API key in a URL, a provider error that echoes it). The run page, run status, request lists and approvals hide current and retired secret values at read time (N11 read-side redaction), but the export did not. The file is meant to be handed to the customer, so a secret would leave the business.

- Where: `apps/api/src/privacy.ts:23`.
- Proof: `apps/api/src/privacy.test.ts`, "hides the workspace's secret values that a step saw".
- Fix: the export passes through `historyHider` (current and retired secret values, then secret-looking keys), after a JSON round trip so dates are text. Base64 file data and the customer's own content are unchanged. The hider errs on the side of masking, so a key such as `token` on a due shows `[secret]` in the file.

### M4. The price of a due can come from a public visitor

A `payment_due` step takes its amount and total as templates. A builder could set `{{trigger.amount}}` on a public form, an unsigned webhook, an inbound email or a direct message. The PayMongo path then confirms the due when the paid amount matches the due, and the manual path shows staff the visitor's own number as the amount owed. A buyer would pay the price they typed and get "payment confirmed". This is 19 November H1 on the new step: the stock starters are safe (a fixed 350 deposit, and an order webhook with a required signature), but the definition allowed the unsafe form.

- Where: `packages/engine/src/definition.ts:112` (the amount template), `packages/db/src/payment-review.ts:208` (`settleCheckout` matches on that amount).
- Proof: `packages/engine/src/definition.test.ts`, "payment_due amount".
- Fix: the definition refuses a `payment_due` amount or total that reads `{{trigger.*}}` unless the trigger is manual, a schedule, a payment, or a webhook with a signing secret. Fixed amounts work everywhere. Saved definitions are checked when they are parsed, so an existing unsafe one fails closed at intake. See decision 0102.

## Low findings

### L1. Receipts to review returns delivery error text without read-time redaction (listed)

`reviewList` returns `deliveries.last_error` for failed replies (`packages/db/src/payment-review.ts:302`). The other readers of the same column pass it through `historyHider`. Today the text comes from fixed `ProviderError` messages for UniSMS and Meta, plus UniSMS's own rejection reason (`packages/db/src/providers.ts:835`), and holds no workspace secret. Reason not fixed now: no secret can reach it on the current providers. Fix when another provider writes there: hide it in `PaymentsController.review`.

### L2. The privacy export takes the customer's email or phone in the query string (listed)

`GET /privacy/customer?email=...` puts the identifier in proxy and access logs (`apps/api/src/privacy.ts:22`). It is owner only and rate limited. Reason not fixed now: it needs a web client change and the deployment's log settings are an owner check. Fix: make the export a POST with a JSON body before the pilot's proxy logs are kept.

### L3. CSV formula guard does not cover a cell that starts with spaces before `=` (listed)

`cell()` in `apps/api/src/csv.ts` guards `= + - @`, tab and CR at the first character, which is the OWASP list. Some spreadsheet imports trim leading spaces. In the payments export the only visitor-controlled text is the transfer reference, which is trimmed and limited to letters, digits, spaces and `# . / -`, so it cannot start with a space. Order references come from the workflow. Reason not fixed now: no current column can carry it.

### L4. The embed may be framed by any http or https site (listed, by design)

`frame-ancestors 'self' https: http:` on `/forms/:id/embed` (`apps/api/src/app.ts`). Small business sites are often plain http. An embedded submission ignores the session (decision 0057), so framing cannot act as a signed-in member. Other routes keep `frame-ancestors 'self'`.

### L5. The Meta webhook path is not validated before the lookup (listed)

`GET` and `POST /hooks/meta/:path` pass the raw path to a parameterised query (`apps/api/src/public.ts:263`) and answer 403 for an unknown path. No injection is possible and the per-IP limit applies. Reason not fixed now: cosmetic. Fix with the 43-character pattern the generic webhook uses when the controller is next touched.

### L6. A Messenger reply after the 24-hour window fails at send time (listed, by design)

`meta_reply` and payment confirmations through Messenger have no pre-check of Meta's standard messaging window. Meta's refusal (subcode 2018278) becomes a non-retryable "invalid" delivery with a fixed message, and a payment reply shows in Receipts to review as a failed reply. The recipient must equal the incoming sender (`apps/worker/src/steps/index.ts`, `meta_reply`), so a reply cannot be redirected.

### L7. The M4 rule does not follow a price through a step output (listed)

A due amount such as `{{steps.read.output.total}}` from an AI step that read a visitor's message is still accepted. Reason not fixed now: step outputs also carry legitimate prices (a sheet lookup), and tracing taint through templates is a larger change. The how-it-works page tells builders to take prices from the owner's own data.

### L8. `paymongo_link` still accepts a trigger amount from a public form (listed, unchanged from decision 0056)

The 19 November H1 fix put an owner approval between the buyer's amount and the link in the stock order starter. The step only produces a paid notification and does not confirm a due, so the M4 rule is not applied to it.

## Checked with no finding

| Area | What was traced |
| --- | --- |
| Authentication and workspace isolation | Every new staff route uses `SessionGuard` and a role guard: payments and Receipts to review `OPERATE`, payment settings PUT, privacy, onboarding, digest and connections `MANAGE`. Every query takes `user.workspaceId`. `decideClaim` checks the claim's workspace, locks the due in its workspace, and `claimImage`, `duesForBooking`, `retryReply`, `paymentsExport` and `reviewList` all filter on it. `privacy.test.ts` has a two-workspace test for export and delete. |
| Validation at the boundary | zod on every body and query: `decideInput`, `settingsInput` (QR as base64, magic bytes, 1 MB), `exportQuery` (real dates, at most a year), `payInput` (transfer reference charset), privacy `who` and `deleteInput` (literal DELETE), onboarding inputs from `@daloy/engine`, digest strict object, Meta connection strict object. Path tokens use fixed patterns. |
| Parameterised queries | All new SQL is Drizzle or `sql` template tags with bound values, including the overview's time zone (checked by ICU, then bound) and the privacy email matcher (a regular expression in application code, built from an escaped, validated email). |
| Rate limits on public routes | Forms and pay page 10 a minute per IP, slots 60, approvals 30 and 10, webhooks 60, plus the global 120. |
| Webhook signatures and replay | Meta: HMAC-SHA256 over the raw body, compared in constant time, before parsing; the verify token compared in constant time; duplicates keyed by message id per workflow. PayMongo: unchanged signature and timestamp window, mode must match, events kept per workspace. Generic webhooks: unchanged. UniSMS is outbound only and has no inbound route. |
| Uploads and private storage | Pay page and forms judge the type from the bytes, 5 MB per file. Receipt images live in Postgres, are served only to staff of the workspace with `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff` and `private, no-store`, and are cleared after the retention days (default 90). Meta images: https on 443, Meta CDN hosts only, DNS pinned with private ranges refused, no redirects, 5 MB streamed limit, 10 s timeout, JPEG, PNG or WebP by magic bytes. |
| CSV export | `toCsv` escapes formula starters and quotes per RFC 4180 (`csv.test.ts`). |
| Secrets in output | Connection routes never return credentials. The Meta webhook URL is returned to the owner only. Errors from the Meta CDN and Graph API carry fixed text. M3 closed the one reader that skipped redaction. |
| SSRF | The only new outbound fetches are the Meta image download (above), Meta Graph and UniSMS at fixed or installation-configured origins with redirects refused. |
| XSS in public pages | Every visitor or owner value in forms, receipts, the pay page, approvals and the privacy notice goes through `escapeHtml`. Colours must be `#rrggbb`. Field names follow the step-id charset. The checkout link must be https. Scripts are `script-src 'self'` (`slots.js`, `compress.js`), with no inline script. |
| CSP and framing | Console and public pages get Helmet's defaults (`frame-ancestors 'self'`, `X-Frame-Options`). Only the form embed path is frameable (L4). Pay pages send `Referrer-Policy: no-referrer` so the token does not leak to PayMongo. |
| Duplicate and racing requests | Due creation is unique per run and step and per open order. Claims lock the due; reviewers carry a version; the webhook and a reviewer lock in the same order. Checkout claims are unique per payment. Onboarding finish locks its row. The digest claims each day with a conditional update. Privacy delete runs in one transaction. |
| Migration 0043 | Check constraints on statuses, flags, amounts and image size; unique token, run and step, payment id. The app role keeps row privileges only (`docker/app-role.sql`). |

## Left for the owner

The live checks are unchanged: PayMongo test-mode deliveries and refunds (`docs/live-paymongo-check.md`), Meta webhook verification and the 24-hour window on a real Page (`docs/live-meta-check.md`), and UniSMS on real SIMs (`docs/live-unisms-check.md`). Before the pilot, also confirm on the deployed host that proxy logs drop query strings (L2) and that the trusted proxy hop count matches the topology.
