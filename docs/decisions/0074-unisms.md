# 0074: Philippine SMS confirmations and reminders through UniSMS

Superseded in part by [0100](0100-unisms-by-operator.md): credentials now come only from the server env, workspaces no longer save their own UniSMS key, and the credential resolution bullet below no longer applies. The rest of this decision still stands.

## Context

Phase N7 adds SMS confirmations and reminders for Philippine mobile numbers as a queued delivery with `needs_review` on unknown outcomes, strict monthly per-workspace quotas, and cancellation when a linked booking changes.

## Options

- Semaphore, UniSMS, or Twilio.
- Send SMS inline during step execution, or queue it as a delivery row like Outlook and Telegram.
- Require every workspace to hold its own gateway key, or also allow an operator-funded shared fallback for paid subscriptions.

## Decision

- Use UniSMS (`POST https://unismsapi.com/api/sms`) with HTTP Basic Auth (`Authorization: Basic base64("<secretKey>:")`), JSON body `{ recipient, content, sender_id, metadata }`, `redirect: "error"`, and a 10-second timeout. The base URL can be overridden via `UNISMS_API_URL` for local fake tests; users cannot set the URL.
- Add `unisms` to `PROVIDERS` and widen the `connections_provider`, `deliveries_provider`, and `oauth_flows_provider` CHECK constraints in migration `0040_unisms.sql`.
- Add monthly `sms` usage metering alongside `ai` in `packages/db/src/usage.ts` with plan limits `preview: 0`, `pilot: 50`, `business: 300`, and `business_plus: 1500` (unlimited when `plan` is null on private installs). Per-message SMS cost is passed through in the monthly subscription pricing.
- Add the `sms` step (`{ to, message, senderId? }`) with a pure Philippine mobile normalizer (`+639XXXXXXXXX`, `639XXXXXXXXX`, `09XXXXXXXXX` normalized to `+639XXXXXXXXX`) and a 670-character cap on rendered messages. Malformed or non-Philippine numbers fail with a non-retryable error.
- Queue SMS as a `unisms` delivery row so delivery retries and operator review happen apart from the workflow run. Before sending, the worker re-checks the linked booking version under a share lock (N2b) so cancelled or rescheduled bookings never text customers and spend no SMS quota.
- Claim 1 `sms` quota unit atomically inside the booking-locked transaction keyed by `delivery:<id>` so retries of the same delivery never double-bill. If the call returns an ambiguous outcome (timeout, dropped connection after connect, or 5xx), the quota claim commits and the delivery parks in `needs_review` so Daloy never blindly double-sends a paid SMS. On 429, Daloy honours `Retry-After` and rolls back the quota claim until a retry sends. On 401 or 403, the delivery fails without retry and marks the workspace connection failed only when using the workspace credential, fenced by its credential IV.
- Credential resolution prefers the workspace's own `unisms` connection. When a workspace has no `unisms` connection, `SHARED_UNISMS_KEY=open` with both `UNISMS_SECRET_KEY` and `UNISMS_SENDER_ID` set, and the workspace holds a paid plan (`pilot`, `business`, or `business_plus`), Daloy falls back to the operator credentials. Preview workspaces (`sms: 0`), unplanned workspaces (`plan: null`), failed workspace connections, and deliveries pinned to a disconnected workspace connection never fall back to operator credentials.
- Sender ID registration: UniSMS's default test Sender ID (`Unisoft`) reaches only Globe and DITO and blocks links. Reaching all Philippine networks (Globe, Smart, DITO, Sun, and TNT) and allowing links requires registering a custom Sender ID with UniSMS using a Letter of Authorization (LOA) and DTI or SEC business registration documents.

## Consequences

- Automated tests run entirely against `test/fake-providers.ts` and never send real SMS messages or spend real credits.
- Verification against a real UniSMS account and Philippine SIM cards remains a manual owner check in [docs/live-unisms-check.md](../live-unisms-check.md).
- UniSMS has no idempotent send lookup API, so a dropped response after connect always requires a human to check UniSMS delivery logs before choosing Mark as sent or Send again.
