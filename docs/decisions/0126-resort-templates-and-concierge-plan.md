# 0126: Resort concierge templates and Concierge quota tier (C8)

## Context

Phases C1 through C7 provide conversation state, quick-reply and numbered email menus, published knowledge sheets, guarded AI answers (`guardReply` and `stay_quote`), multi-night stay bookings, DM receipt claims, and the Conversations inbox with staff alerts. Resort pilots still needed starter workflows in the Library tailored to Messenger/Instagram DMs, threaded email inquiries, and staff-initiated deposit requests with pre-arrival and post-checkout follow-ups, plus a quota tier sized for 3,000+ AI replies per month.

## Options

1. Raise the `business` tier AI quota from 500 to 3,000. Rejected: affects all workspaces on Business and bundles unrelated SMS/automation limits.
2. Add a dedicated `concierge` plan tier (migration `0055`) and three starter templates in a new `"Resorts and hotels"` Library category with English, Tagalog, and Taglish copy. Chosen.

## Decision

- `packages/db/migrations/0055_concierge_plan.sql` updates the `users_plan` constraint to include `'concierge'`. `packages/db/src/usage.ts` defines `concierge` with 10 live automations, 3,000 AI actions per cycle, 500 SMS per cycle, 500 emails per day, 2,000 HTTP requests per day, 1,000 uploads per day, and 15-minute minimum schedule intervals.
- `packages/engine/src/templates.ts` adds `"Resorts and hotels"` to `TEMPLATE_CATEGORIES` and three templates:
  1. `resort-concierge-dm` (`meta_dm`): skips when `status === "staff"`, answers direct `"staff"` menu taps politely, otherwise runs AI `answer`, saves extracted stay details (`conversation_update`), branches on `needsHuman` for handoff vs full menu reply (`quickReplies`), and schedules one 20-hour follow-up cancelled automatically by `runSuperseded` if the guest replies sooner.
  2. `resort-concierge-email` (`email`): mirrors the DM concierge flow in threaded email replies with matching numbered `menu` items and a 24-hour follow-up.
  3. `resort-deposit-and-stay` (`manual`, launched from Conversations): computes prices with `stay_quote`, holds the stay in `booking` stay mode, creates a PayMongo/QR deposit due (`payment_due`), sends the payment link via Messenger when an open DM sender exists (falling back to email on `outside_window` or `paused`), reminds after 6 hours, expires unpaid holds after 48 hours (`payment_expire`), and sends pre-arrival (2 days before check-in) and neutral post-checkout review emails.
- `packages/engine/src/template-language.ts`, `packages/engine/src/taglish.ts`, and `apps/web/src/lib/locale-guided.ts` provide Tagalog and Taglish translations while keeping all placeholders intact.
- `apps/api/src/conversations.ts` passes `resource`, `conversation_id`, `channel`, `senderId`, and email fallback into manual deposit runs, and `apps/worker/src/steps/index.ts` permits the single immediate `needsHuman` handoff reply of the triggering run before enforcing staff pause on subsequent guest messages.

## Consequences

- Workspaces on `concierge` support full resort DM and email traffic without hitting Business tier's 500 AI action ceiling.
- All three starter templates pass `definitionSchema`, `lintDefinition`, and EN/Tagalog/Taglish template validation tests.
