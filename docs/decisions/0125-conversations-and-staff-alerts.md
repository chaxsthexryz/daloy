# 0125: Conversations inbox and staff alerts (C7)

## Context

C1 through C6 store Messenger, Instagram, and email conversations, quick replies, knowledge versions, stay bookings, and DM receipt claims. Staff still needed one workspace inbox to see waiting guests, pause or resume the bot, edit gathered details, confirm stays, launch deposit requests, receive handoff alerts, and run R6 export or delete for social guests without email or phone numbers.

## Options

1. Reuse `/bookings` or `/activity` tables for guest threads. Rejected: neither shows message history, 24-hour Meta reply window state, or quick Take over / Hand back controls.
2. Add `#/conversations` (`Conversations.tsx`) backed by `ConversationsController` and `@daloy/db` conversation helpers, plus `users.staff_alert_psid` (migration `0054`). Chosen.

## Decision

- `packages/db/migrations/0054_staff_alerts.sql` adds `users.staff_alert_psid` (nullable text up to 64 characters).
- `packages/db/src/conversations.ts` adds `listConversations` (sorting `status = 'staff'` first, then latest activity), `conversationDetail`, `takeOverConversation` (`status = 'staff'`, `staffUntil = null`), `handBackConversation`, `updateConversationFields`, `conversationSettings`, `saveConversationSettings`, `staffAlertStatus`, `sendStaffAlert`, and `findDepositWorkflow`.
- `sendStaffAlert` checks Meta's 24-hour standard messaging window for `staffAlertPsid` (`conversations` row for that PSID with `lastInboundAt` within 24 hours). When open, alerts go via Messenger; when closed or unconfigured, alerts fall back to Telegram, then to the owner's email through the installation mailer. Alert messages carry only guest first name, channel, stay dates/guests if known, short reason, and the `#/conversations` link, never full guest text.
- `apps/worker/src/steps/index.ts` triggers `takeOverConversation` and `sendStaffAlert` automatically when a live AI `answer` step returns `needsHuman: true`.
- `packages/db/src/digest.ts` and `packages/engine/src/digest.ts` include active staff-waiting conversations (`conversationsWaiting`) in the morning digest email.
- `packages/db/src/privacy.ts` accepts `{ conversationId }` in `CustomerQuery`, allowing `POST /conversations/:id/export` and `POST /conversations/:id/delete` (owner only) for guests without email/phone. `apps/api/src/privacy.ts` also exposes `POST /privacy/customer/export` (L2).

## Consequences

- Staff alerts work out of the box via email and automatically upgrade to Telegram or Messenger when connected.
- Because `users.staff_alert_psid` relies on Meta's 24-hour messaging rule, a staff member must message the Page every 24 hours to receive Messenger alerts; otherwise Daloy falls back cleanly and shows the active alert channel at the top of Conversations.
