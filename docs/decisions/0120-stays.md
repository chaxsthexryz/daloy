# 0120: Multi-night stays, conversation links and Confirm stay

## Context

C5 of the resort concierge plan (`docs/plans/resort-concierge.md`). Daloy's existing `booking` step (decision 0032) models single-slot appointments of at most 1,440 minutes taken from a trigger `datetime` field, and `bookings` stores no link to a guest conversation. A resort needs multi-night stays of 1 to 30 nights whose `[start, end)` range uses the resort's published check-in and check-out times, room units grouped under room types, guest contact details linked from conversations, reschedules that keep the stay's night count, and a staff Confirm stay path so a stay is never created from unverified guest text alone.

## Options

1. Add a separate `stays` table and `stay` step type alongside `bookings`. Rejected: it duplicates the exclusion constraint, booking version fencing, calendar sync, delivery supersede checks, Bookings page, and MCP tools.
2. Extend `bookings` and the `booking` step with stay mode (`mode: "stay"`), nullable `nights`, `conversation_id`, and `idempotency_key` columns, plus a nullable `label` column on `resources`. Chosen.

## Decision

- Schema (`0051_stays.sql`, `packages/db/src/schema.ts`):
  - `bookings.conversation_id` (nullable `uuid`, `on delete set null`, partial index): links a stay to its guest conversation for contact lookup (`name`, `email`, `phone`, `channel`).
  - `bookings.nights` (nullable `integer`, `1..30` when set): separates multi-night stays from slot bookings (`null`) and preserves the exact night count on reschedule across DST boundaries.
  - `bookings.idempotency_key` (nullable `text`, partial unique index per `(user_id, idempotency_key)`): deduplicates staff Confirm stay retries and double-clicks.
  - `resources.label` (nullable `text`, 1 to 80 chars): groups individual room units under a room type without changing resource uniqueness or existing booking forms.
  - Overlap enforcement stays solely on Postgres `bookings_no_overlap` (`tstzrange` `[start, end)`), so overlapping nights fail with `23P01` and same-day turnaround (e.g., 12:00 check-out before 14:00 check-in) succeeds naturally.
- Resort check-in and check-out times (`packages/engine/src/knowledge.ts`, `packages/engine/src/stays.ts`):
  - `knowledgeFields` gains optional `checkInTime` and `checkOutTime` (24-hour `HH:MM`), allowed only on `arrival`, `policy` and `room` entries.
  - `stayTimesFromKnowledge` reads published `knowledge_versions` entries in priority order `arrival`, `policy`, `room`, falling back to `14:00` check-in and `12:00` check-out when unset.
  - `stayRange` builds `[checkIn @ checkInTime, (checkIn + nights) @ checkOutTime)` in the stay's IANA timezone (default `Asia/Manila`), checking calendar validity, future check-in, and DST gaps or overlaps via `parseZoned`.
- Booking step stay mode (`packages/engine/src/definition.ts`, `apps/worker/src/steps/index.ts`):
  - `booking` create with `mode: "stay"` takes `resource`, `checkIn` (`YYYY-MM-DD`), `nights` (1 to 30, integer or template), optional `timezone`, optional `checkInTime` / `checkOutTime` overrides, and optional `conversation` (defaulting to `run.conversationId`).
  - Trust guard in `definitionSchema`: a stay-mode `create` is allowed only on `manual`, `payment`, or HMAC-signed `webhook` triggers, and `untrustedSource` refuses any template chain reading an `ai` step or an untrusted trigger (`meta_dm`, `email`, `form`, `telegram_message`, unsigned `webhook`).
  - `booking` reschedule with `mode: "stay"` takes `booking` and `checkIn` and keeps the booking's `nights` and local wall clock times via `rescheduleStayRange`.
  - Step output exposes zoned `start`, `end`, `nights`, `checkIn`, `checkOut`, `timezone`, and optional `conversationId` / `guest`, so downstream `delay until` (such as `until: "{{steps.book.output.start}}"`, `offsetSeconds: -172800`) schedules pre-arrival messages at check-in minus 2 days in `Asia/Manila`.
  - Local `Build with AI` prompts drop the stay-mode fields from `booking`'s schema to stay inside a 4,096-token local context window, while hosted prompts keep them.
- Staff Confirm stay and reschedule (`packages/db/src/bookings.ts`, `apps/api/src/bookings.ts`, `apps/api/src/mcp.ts`):
  - `POST /bookings/stays` and `GET /bookings/:id` are owner and operator only (`Allow(OPERATE)`), rejecting approvers and requesters with 403 and foreign resources or conversations with 404.
  - `POST /bookings/:id/reschedule` accepts `checkIn` (`YYYY-MM-DD`) or `start` for stay bookings. Staff-confirmed stays (no backing workflow) update their range and version directly; workflow-created stays start one new run after the stay booking step with the updated `checkIn` and supersede the old reminder run.
  - `booking_changes.result` omits `guest` contact fields; live booking reads join `conversations` so guest details never linger in change logs after conversation deletion or retention purge.
- Privacy (R6, `packages/db/src/privacy.ts`):
  - `collect()` adds bookings linked via `bookings.conversation_id` so staff-confirmed stays with no run are included in customer export and delete.
  - Deleting or purging a conversation sets `bookings.conversation_id` to `NULL` (`ON DELETE SET NULL`) while keeping the held stay range under R6 `keptOf` rules.

## Consequences

- Multi-night stays reuse the existing exclusion constraint, version fencing, delivery supersede checks, Google Calendar sync, Bookings page, and MCP tools without parallel booking infrastructure.
- C7's Conversations page can wire Confirm stay directly to `POST /bookings/stays` using `stayDraftFromFields` to prefill `checkIn` and `nights` from gathered conversation fields.
- Live guest contact shown on a stay disappears automatically when the linked conversation is deleted under R6 or purged after the retention period.
