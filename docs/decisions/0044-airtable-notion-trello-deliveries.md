# 0044: Airtable, Notion and Trello as deliveries

## Context

N15 adds a record, a page and a card from a workflow. They follow Telegram (decision 0042): queued, retried, pinned, held for review when the outcome is unknown. Free tiers only.

## Options

- Add only, or add and update.
- Fixed fields, or the owner names the fields.
- Retry after an unknown outcome, or hold it for a person.

## Decision

- Three more providers next to Telegram. Migration 0027 only widens the two `provider` checks (0025 and 0026 are taken by N13 and N12, renumber if they merge first). No new table.
- Add only. Update needs a record id the workflow does not have yet, so it waits.
- Connections, each checked with a read before saving. Tokens are encrypted and never returned.
  - Airtable: personal access token, base id, table id or name. A one-record read checks all three. The test button repeats that read, because a record needs field names Daloy does not know.
  - Notion: internal integration secret and a database link or id. `GET /v1/databases/{id}` gives the name and the title property, which a page needs. The test button adds a page with only a title. Pinned to API version 2022-06-28, where a database lists its properties; newer versions move properties to data sources.
  - Trello: API key, token and list id, stored as one encrypted JSON secret. `members/me` and `lists/{id}` check them. The test button adds a card.
- Steps: `airtable { fields }`, `notion { title, fields }`, `trello { name, desc }`. Field and property names are literals the owner types, values are templates. Notion fields are text properties. Airtable adds with `typecast`, so text fills number, date and select fields.
- Pinned like Telegram: the base and table, database, or list are fixed when the delivery is queued, and a changed target holds it for review.
- None of the three documents an idempotency key. A 5xx or timeout on an add is ambiguous, so it goes to needs_review (Retry off, Post again or Mark as posted). Notion may name the saved page in a 503 and the message says so.
- 401 fails and marks the connection for reconnect, 403 and 404 mean permission, 400 and 422 mean invalid. 429 queues again after the wait: `Retry-After` for Notion (and 529), 30 seconds for Airtable (its documented lockout), 10 seconds for Trello (its 10 second window).
- The base URLs are `AIRTABLE_API_URL`, `NOTION_API_URL` and `TRELLO_API_URL`, env only, so the fake server can stand in during tests.
- The AI draft prompt leaves these three steps out, to stay inside a small local model's context.

## Consequences

- Trello's key and token are in the request URL, as its REST API expects. Daloy never logs or returns a request URL and errors are fixed text.
- An Airtable or Notion field name that does not exist is refused (invalid) and never retried.
- Trello's per-token and Airtable's per-base limits are shared with whatever else the owner runs on the same token or base.
