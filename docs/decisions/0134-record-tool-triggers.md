# 0134: Record-tool triggers (Airtable record, Notion page, Trello card)

## Context

G5 adds three polling triggers that reuse the Airtable, Notion, and Trello connections and destinations the owner already picked in Apps:

- `airtable_record`: a new record or a status field change in the chosen Airtable table.
- `notion_page`: a new page or a status property change in the chosen Notion database.
- `trello_card`: a new card added to or moved into the chosen Trello list.

All three reuse `trigger_polls` (migration `0056_trigger_polls`, zero new migrations), `createKeyedRun` (`run_keys`), and the worker timer pattern established in G2 (`docs/decisions/0129-google-workspace-triggers.md`).

## Options

1. Provider webhooks for Airtable, Notion, or Trello. Airtable webhooks expire every 7 days and require a public HTTPS endpoint (`notificationUrl`), Notion public integrations do not provide per-database webhooks on localhost installs, and Trello webhooks require a public `callbackURL` reachable from Trello.
2. Polling via `trigger_polls` for all three providers. Works on localhost, Docker Compose, and hosted deployments through one code path.

## Decision

Option 2, polling via `trigger_polls`.

- **Scope discipline (reusing decision 0062)**:
  - `AIRTABLE_SCOPES` (`data.records:write`, `schema.bases:read`) is left unchanged so existing OAuth consent manifests stay intact. Airtable record polling works with a personal access token (`authMethod: "token"`, which the Apps card already instructs to create with `data.records:read` and `data.records:write`) or an OAuth grant that includes `data.records:read`. An OAuth grant without `data.records:read` pauses cleanly with a plain message pointing to Apps.
  - Notion OAuth and internal integration secrets both permit database queries (`POST /v1/databases/:id/query`, `write: false`) on databases shared with the integration.
  - Trello OAuth (`TRELLO_SCOPES` already includes `read:board:trello`) and pasted API key/token both permit reading list cards and actions (`GET /1/lists/:id/cards`, `GET /1/lists/:id/actions`).
- **Coexistence on `trigger_polls`**: Both `pollGoogleTriggers` and `pollRecordTriggers` join `triggers` and filter by their own trigger types so neither worker loop claims or deletes the other's rows.
- **First-poll no-replay rule**: The first poll (when `cursor` is null or `source` changed) queries the provider to verify credentials and target, records the initial baseline (`since` timestamp for `created` / `moved_to_list`, or status map snapshot for `status_changed`), and starts zero runs. Changing the destination, mode (`on`), or watched `statusField`/`statusProperty` changes `source` and starts a fresh first poll.
- **Idempotency and crash safety**:
  - `airtable_record` (`created`): run key `airtable:<baseId>:<tableId>:<recordId>:created` using `createdTime` with a 2-minute overlap window, sorted oldest-first and capped at 50 items per poll.
  - `notion_page` (`created`): run key `notion:<databaseId>:<pageId>:created` using `created_time` with the same 2-minute overlap and 50-item cap.
  - `airtable_record` / `notion_page` (`status_changed`): stores `{ statuses, seq }` in `cursor` and detects non-empty transitions (`prev !== next`). Run key `<prefix>:<id>:status:<seq>:<hash(status)>` increments `seq` per transition so `A -> B -> A` triggers again while a crash between `createKeyedRun` and cursor save hits the same `seq` and deduplicates via `run_keys`.
  - `trello_card` (`created`): reads `createCard` actions on the list (enriched with card `desc`/`url` from `lists/:id/cards`), run key `trello:<listId>:<cardId>:created`.
  - `trello_card` (`moved_to_list`): reads `updateCard:idList` actions where `listAfter.id === listId`, run key `trello:<listId>:<actionId>:moved` so moving a card out and back in starts a new run.
- **Backoff and pausing**: Rate limits (`429`) and transient `5xx`/network errors back off exponentially from 5 minutes (or the plan minimum) up to 1 hour, honouring `Retry-After`. Missing connections, failed auth (`401`), missing/refused targets (`403`/`404`), table names instead of `tbl...` ids, insufficient scopes, and self-loops pause with a clear `problem` checked every 5 minutes.
- **Self-loop guard**: `airtable_record` pauses if an enabled `airtable` step is in the workflow; `notion_page` pauses if an enabled `notion` step is in the workflow; `trello_card` (`on: "created"`) pauses if an enabled `trello` step is in the workflow (`on: "moved_to_list"` is allowed since `trello` steps only create cards).

## Consequences

- Zero database migrations (`trigger_polls` and `run_keys` are reused directly).
- Up to one poll interval (5 minutes, or plan minimum) of latency.
- Airtable OAuth connections created under decision 0062 (`data.records:write` + `schema.bases:read` only) cannot watch records until the user connects with a personal access token that has `data.records:read`.
- Verified against fake providers in unit, DB poll, and API tests; live Airtable/Notion/Trello API polling remains unverified until an owner runs a live check.
