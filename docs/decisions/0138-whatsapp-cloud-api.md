# 0138: WhatsApp Cloud API (C10 / N25)

## Context

kymavo already supports Meta Messenger and Instagram DMs (`meta_messenger`, decision 0075), C1 conversation tracking (decision 0115), C6 DM receipt claims (decision 0121), and R6 guest privacy export/deletion (decision 0094). Resorts and service businesses also receive bookings, deposit receipts, and inquiries over WhatsApp. Meta bills WhatsApp Cloud API per delivered message to a verified Meta Business account and restricts free-form service messages to a 24-hour customer service window, requiring pre-approved Meta utility or marketing templates outside that window.

## Options

1. Third-party BSP (Twilio / Vonage / WABA resellers): extra vendor dependency, per-message markup, and separate webhook/signing models.
2. Direct Meta WhatsApp Cloud API (`graph.facebook.com/v21.0`): reuses Meta's `X-Hub-Signature-256` verification, `hub.challenge` handshake, SSRF-protected Meta CDN download pipeline, and keeps billing directly between the workspace owner and their verified Meta Business account.

## Decision

- Added `"whatsapp"` to `connections_provider`, `deliveries_provider`, and `conversations_channel` in migration `0058_whatsapp_cloud.sql`.
- Connections (`PUT /settings/connections/whatsapp`, `POST /settings/connections/whatsapp/test`): store `accessToken`, `appSecret`, and `verifyToken` encrypted JSON in `connections` (redacted across both `secretValuesToHide` and `extractRetiredSecretValues` in `packages/db/src/crypto.ts`) alongside `phoneNumberId`, optional `wabaId`, `displayPhone`, `verifiedName`, and a random `webhookPath` preserved on credential rotation.
- Webhook intake (`GET /hooks/whatsapp/:path`, `POST /hooks/whatsapp/:path`): answers `hub.challenge` with constant-time `verifyToken` check, verifies `X-Hub-Signature-256` against raw request bytes, ignores status callbacks and mismatched `phone_number_id` events, normalizes guest WhatsApp phone numbers (`09...` and `+639...` -> `639...`), downloads inbound receipt images via Bearer-authenticated Graph API lookup + SSRF/magic-byte check (`downloadWhatsAppMedia`), attaches C6 transfer claims to open `payment_dues`, records C1 conversations on channel `"whatsapp"`, and deduplicates runs via `wa:${messageId}`.
- Workflow authoring & execution: added `whatsapp_message` trigger and `whatsapp_reply` step with two modes:
  - `mode: "text"`: service reply enforced inside the 24-hour window (routes to `outside_window` or `paused` edges when closed or staff-handled), sends inline interactive buttons (up to 3) or numbered text choices (4+), and includes the RA 10173 privacy notice once per conversation.
  - `mode: "template"`: pre-approved Meta utility/marketing template (`templateName`, `templateLanguage`, ordered body `templateParams`), allowed outside the 24-hour window.
- R6 privacy search, export, and deletion match `"whatsapp"` conversations by normalized phone number, and `ConversationsController.depositRequest` populates `phone` and `senderId` for WhatsApp threads.
- UI (`Apps`, `WhatsAppConnection`, `Editor`): states that Meta bills per delivered WhatsApp Cloud API message directly to the owner's verified Meta Business payment method and that outside-24h reminders require approved Meta utility templates.

## Consequences

- Workspaces can connect WhatsApp Cloud API without kymavo acting as a billing intermediary or BSP.
- Live guest traffic still requires the owner to hold a verified Meta Business account, attach a Meta payment method, and obtain Meta approval for any utility templates used outside the 24-hour window.
