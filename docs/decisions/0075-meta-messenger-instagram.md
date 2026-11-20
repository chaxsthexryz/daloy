# 0075: Facebook Messenger and Instagram DM intake, receipt vision, and 24-hour replies

## Context

Small shops in the Philippines receive many customer orders and GCash or bank transfer screenshots through Facebook Messenger and Instagram direct messages. Checking screenshots by hand is slow, and a screenshot is easy to edit or reuse across multiple orders. At the same time, Meta enforces strict platform rules: webhook events must be verified with an app secret, image attachment URLs come from Meta CDN hosts and are untrusted input, and standard replies are only allowed within 24 hours of the customer's last message. Live messaging to external customers also requires Meta App Review with `pages_messaging` and `instagram_manage_messages`.

## Options

1. Use Meta OAuth and webhooks with automatic payment confirmation from receipt photos. Rejected because a screenshot is never proof of payment and Meta OAuth adds review surface before any pilot has requested it.
2. Connect each workspace's Facebook Page and optional Instagram Business Account with pasted, encrypted credentials (Page Access Token, App Secret, Verify Token), receive signed webhooks on a random per-workspace path, safely download verified images for AI vision extraction, flag reused receipt references, and queue 24-hour replies through the existing delivery runner after human approval.

## Decision

We adopt option 2.

- Connection storage: `connections` gains the `meta_messenger` provider (`authMethod = 'token'`), widened in `packages/db/migrations/0041_meta_dm.sql` alongside `deliveries` and `oauth_flows`. The encrypted credential JSON holds `{ pageAccessToken, appSecret, verifyToken }` bound to `${userId}:connection:meta_messenger`. The destination holds `{ pageId, pageName?, instagramAccountId?, webhookPath }`, where `webhookPath` is a random 32-byte base64url path generated once and preserved across credential updates.
- Webhook intake (`GET` and `POST /hooks/meta/:path`): `GET` checks `hub.mode === "subscribe"` and constant-time compares `hub.verify_token` before returning `hub.challenge` as `text/plain` (403 otherwise). `POST` enforces the 60 requests per minute per IP limit and 256 KB body limit, verifies `X-Hub-Signature-256` against the raw request bytes using HMAC-SHA256 and `timingSafeEqual` (401 on failure), parses Messenger (`object === "page"`) and Instagram (`object === "instagram"`) messaging events matching the connected `pageId` or `instagramAccountId`, and ignores echoes (`is_echo === true`) and delivery or read receipts.
- Atomic trigger lookup and deduplication: published `meta_dm` workflows and their latest published versions are loaded in one query snapshot. Each incoming message is deduplicated per `(workflowId, test: false, key: "meta:" + mid)` in `run_keys`, so Meta retries and concurrent duplicates start at most one run. Paused workflows are skipped with HTTP 200 so Meta does not disable the webhook.
- Safe image download: up to three image attachments per message are downloaded before inserting the run, respecting the workspace's daily `upload` quota. Only `https:` port 443 URLs on `*.fbcdn.net`, `lookaside.fbsbx.com`, or `*.cdninstagram.com` are accepted (with a test-only `ProviderUrls.metaCdn` override). Downloads use IP-pinned DNS lookup blocking private, loopback, link-local, and metadata ranges, refuse redirects, enforce a 10-second timeout and 5 MB streaming cap, and verify JPEG, PNG, or WebP magic bytes via `fileType`. Verified bytes are saved in `uploads` in the run's transaction, while `triggerPayload.image` carries only `{ id, name, type, size }` references.
- Duplicate receipt reference flagging: migration `0041_meta_dm.sql` adds `receipt_references` keyed by `(user_id, normalized_ref)`. When an AI extract step reads attached files and returns a non-trivial `reference` on a live run, Daloy records the normalized reference on first sight and sets `duplicate_reference: "yes"` plus a warning string when a different live run in the same workspace already used it. Retries of the first run and test runs are never flagged.
- Starter template (`meta-receipt-intake`): reads the receipt photo, saves it to Google Drive, checks `is_receipt === "yes"`, logs a Google Sheets row explicitly marked "Pending verification" (never "Paid"), and sends an approval to the owner warning them to check their real GCash or bank inbox before approving. Only after approval or rejection does `meta_reply` message the customer; timeout emails the owner instead of echoing untrusted text to a stranger.
- 24-hour replies (`meta_reply` step and `meta_messenger` delivery): replies are queued as deliveries and sent to `POST /v21.0/me/messages` with `messaging_type: "RESPONSE"` and `redirect: "error"`. Meta error code 10 with subcode 2018278 (outside the 24-hour window) fails cleanly as non-retryable without marking the connection failed. HTTP 401, 403, or OAuth code 190 marks the connection failed, fenced by credential IV. HTTP 429 backs off honouring `Retry-After`. Timeouts and 5xx answers park the delivery in `needs_review`.
- Secret redaction: `secretValuesToHide` includes `pageAccessToken`, `appSecret`, and `verifyToken` from `meta_messenger` connections so `historyHider` redacts all three across run history, deliveries, connection reads, and test errors.

## Consequences

- Workspaces can automate receipt intake and manual verification for Messenger and Instagram DMs without ever auto-confirming a screenshot as paid.
- Replies past 24 hours fail honestly and point the owner to their Page or Instagram inbox.
- Automated tests run entirely against local fakes in `test/fake-providers.ts`. Live Meta verification (`docs/live-meta-check.md`) and Meta App Review remain with the owner.
