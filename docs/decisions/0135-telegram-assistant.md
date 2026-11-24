# 0135: Ask my assistant on Telegram (phase J1)

Date: 2026-11-24

## Context

Business owners already connect a Telegram bot in Apps (`telegram_message` trigger, decision 0117) and check kymavo on their phone for today's schedule, bookings, unpaid balances, and automation runs. Without conversation memory on Telegram or a read-only workspace summary step, an owner messaging their bot could neither ask follow-up questions ("How much was that unpaid balance?") nor read today's Google Calendar events, kymavo bookings, open payment dues, and run counts in one automation.

## Decision

1. **Telegram as a C1 conversation channel (`0057_telegram_conversations.sql`)**:
   - Expand `conversations_channel` CHECK constraint to `('messenger', 'instagram', 'email', 'telegram')`, keyed per workspace on `(user_id, 'telegram', chat_id)`.
   - `TelegramHooksController.receive` (`apps/api/src/public.ts`) records each accepted inbound Telegram message inside a transaction via `recordInbound` (`mid: "telegram:<chatId>:<messageId>"`), skips replayed updates before starting runs, attaches `conversationPayload` as `trigger.conversation`, and links `{ conversationId, conversationVersion }` on `createKeyedRun` so rapid follow-up messages supersede stale waiting runs.
   - When a `telegram` step replies to the run's own Telegram chat (`chatId === convo.externalId`), the worker records the outbound text in `conversation_messages` via `recordOutboundReply` inside the delivery transaction without prepending the RA 10173 resort-booking privacy notice used by Meta and email guest replies.
   - R6 customer export, customer delete, per-conversation export/delete, and the conversation retention sweep cover `telegram` threads automatically, and `Conversations.tsx` hides the Meta-only 24-hour reply window badge on Telegram threads.

2. **Strictly read-only `assistant_read` step (`packages/engine/src/definition.ts`, `packages/db/src/assistant.ts`)**:
   - Config accepts `what` (`"all"`, `"calendar"`, `"bookings"`, `"payments"`, `"runs"`, or a `{{...}}` template resolved from an earlier step such as AI intent classification) and an optional IANA `timezone` (defaulting to `Asia/Manila`).
   - Reads only data owned by the run's `userId` (`test = false` for bookings, dues, and runs):
     - **Google Calendar**: uses the workspace's existing OAuth `google_calendar` connection (`calendar.app.created`) and `calendarEventsBetween` for `[startOfDay, nextStartOfDay)`. Missing, failed, service-account, narrow-scope, or unconfigured calendar connections return structured status and plain-language guidance instead of failing the run.
     - **kymavo bookings**: today's overlapping bookings joined with resource names and optional guest display names.
     - **Open unpaid payments**: `payment_dues` with `status = 'pending'`, returning reference, kind, peso amounts, and linked booking reference while omitting payment link `token` values.
     - **Today's runs**: counts by state plus up to 10 `failed` or `needs_review` workflow names and timestamps, omitting raw trigger payloads and error stack/detail strings.
   - Produces both structured fields (`calendar`, `bookings`, `payments`, `runs`) and a bounded `summaryText` (capped at 12,000 characters), plus `mockAssistantSnapshot` for builder test runs (`OUTSIDE` in `test-run.ts`).

3. **`telegram-assistant` starter template (`packages/engine/src/templates.ts`)**:
   - Added in English, Tagalog, and Taglish (`telegram_message` restricted to `from: "my_chat"` -> `ai` `classify` `pick_intent` -> `assistant_read` `read_data` -> `ai` `draft` `write_answer` -> `telegram` `reply`).
   - Strictly read-only: acting on the owner's behalf (creating or cancelling bookings, charging or refunding) is deferred to a later phase with explicit approvals.

## Consequences

- Owners can message their own Telegram bot for a daily briefing or specific questions with multi-turn follow-up context.
- Because `telegram-assistant` defaults to `from: "my_chat"` and `assistant_read` queries strictly by `userId` while redacting workspace secrets and omitting tokens/raw payloads, neither cross-workspace data nor credentials can leak into the chat.
