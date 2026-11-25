# 0144: AI quota refund and honest preflight

- Date: 2026-11-25
- Status: Accepted

## Context

Pilot usability testing surfaced three trust and safety gaps during first-run setup and error states:

1. Failed, timing-out, or unconfigured AI calls (settings connection test, Build with AI, Reword run error, and worker AI/Answer steps) incremented monthly `ai` usage even when no response was returned to the owner or customer.
2. Routes and preflight checks hid or misled owners: `Chat as your customer` attempted runs against an empty Knowledge Base and sent `POST /runs/:id/cancel` on already-finished runs (returning 409), `#/ai` logged failed turn-1 builds as `In progress` and linked operators to `#/settings/ai` even though only workspace admins can view it, and the editor required PayMongo for manual QR Ph (`payment_status`) while failing to check Booking Resources, SMS availability/quota, and Knowledge before `Try a sample` and `Publish > Turn on`.

## Decision

- Refund claimed `ai` usage via `refundUsage` whenever `/settings/ai/test`, `/ai/chat`, `/ai/draft`, `/runs/:id/explain`, or worker `runAnswer` / `runAi` fails before producing a valid result. Check `readKnowledge` in the worker before claiming an AI action for `answer` steps.
- Surface plain owner outage messages (`explainForOwner`) instead of raw upstream status codes or internal error text across settings, Build with AI, and run explanations.
- Pre-check `GET /knowledge` in `Chat as your customer`, offer a direct `#/knowledge` link when no Q&As are published, and guard `/cancel` calls to `pending` or `waiting` runs.
- Track `"failed"` AI build logs in `Build with AI`, hide `Build it now` / `Start over` until an assistant reply or draft exists, suggest keyword-matched fallback templates on failure, remove `#/settings/ai` links for non-admins, and render `NotFoundPage` on `#/settings/ai` for non-admins.
- Decouple `payment_status` from PayMongo (manual GCash / QR Ph works without API keys), and add preflight checks (`missing_resource`, `sms_unavailable`, `sms_plan`, `sms_quota`, `knowledge`) with inline Resource creation and hard-blocker gating on `Publish > Turn on`.
