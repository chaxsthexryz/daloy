# 0021: Sheets and Slack as queued deliveries, each retried on its own

## Context

Roadmap phase 3 adds a Google Sheets row and a Slack note to office requests. The acceptance check asks for expired access, permission denial, quotas and retries to be handled independently: when the sheet write succeeds and Slack fails, only Slack is retried, and a call that may have reached the provider before it timed out is reconciled or held for review instead of repeated.

Runs in Daloy are strictly sequential, and a step that fails for good fails the run. If Sheets and Slack were ordinary steps, a failed sheet write would stop the Slack note from being tried, and there was no way to retry one step of a finished run.

## Options

Where the provider call happens:

1. Inside the step, like email. The run's retry policy covers it, and a failure fails the run.
2. The step queues a delivery record and succeeds. The worker delivers each record apart from the run, with its own attempts, backoff and state.

How deliveries are queued:

1. A pg-boss job per delivery.
2. Rows in a `deliveries` table, claimed by a poll with `FOR UPDATE SKIP LOCKED`.

How the owner connects:

1. Google OAuth and the Slack OAuth install flow. Needs a registered Google Cloud OAuth client and Slack app with redirect URLs for each installation, and Google's verification for the Sheets scope.
2. A Google service account key file, with the sheet shared to the service account's email. A bot token from a Slack app the owner installs in their own workspace.

## Decision

- Option 2 for the call. The `sheets` and `slack` steps resolve their templates, redact secrets, and insert one `deliveries` row per run and step (unique on `run_id, step_id`), then succeed. The payload is fixed at that point, so a step that runs again after a crash gets the first row back. The office request template puts both steps after the receipt.
- Option 2 for the queue. The row holds the state, attempt count, next attempt time, provider result and last error, which the Requests list shows, so a job table would duplicate it. `claimDueDeliveries()` hands each due row to one worker. A row left `sending` for two minutes belongs to a worker that died, and is claimed again with `check_first` set.
- States: `queued`, `sending`, `delivered`, `needs_review`, `failed`. Provider errors are sorted into auth (connection marked failed, delivery failed), permission and bad request (delivery failed, connection untouched), quota and unavailable (queued again after the backoff, or Slack's `Retry-After` if longer, up to 5 attempts), and ambiguous (a write that timed out, broke off, or got a 5xx).
- Ambiguous Sheets writes are reconciled: the row is `[reference, time, ...columns]`, so the next attempt reads the tab and marks the delivery delivered if that exact row is there (the reference alone matched another step's row in the same run, QA finding November 2026), or writes it if not. Slack has no such check without the `channels:history` scope, so an ambiguous Slack post goes to `needs_review`, and the operator chooses Mark as posted or Post again (with a confirmation). A plain Retry never repeats it.
- Retry, Post again and Mark as posted are single guarded UPDATEs that also check the owner, so a double-click acts once and another owner's delivery is a 404.
- Option 2 for connecting, the same reasoning as the Gmail app password in [decision 0020](0020-owner-mail-senders.md): it works on any self-hosted installation without registering OAuth clients. Daloy signs the service account JWT with `node:crypto` (RS256), so no Google client library is added. Only `client_email` and `private_key` are kept from the key file. Slack tokens must be bot tokens (`xoxb-`), with the scopes `chat:write` and `channels:read`.
- One connection per owner per provider, encrypted like secrets with the owner and provider in the associated data, holding one destination: a spreadsheet and tab, or a channel. Disconnect deletes the row; queued deliveries then fail with "not connected" and keep their payload for Retry after reconnecting.
- Turning on a workflow with these steps is refused until the connection is active and has a destination. Drafts and test runs are not checked; test runs show the row and message without queueing anything.
- Provider URLs come from `GOOGLE_TOKEN_URL`, `GOOGLE_SHEETS_URL` and `SLACK_API_URL`, defaulting to the real services, so tests and Playwright point at `test/fake-providers.ts`.

Claim identity (after Astra's review of c05fa81): each claim stores a new random `claim_id`, and outcomes and first-send pinning are written only while the row is `sending` with that id. The attempt number cannot serve, because Retry and Post again reset it, which let a stale worker's late answer be recorded against a newer attempt. Deliveries that were mid-send when migration 0016 ran have no claim id; they are taken back after the stale timeout like any dead worker's claim, with check-first set.

After Astra's review of 8e2c5d8: the first-send pin is written under the claim, and a worker whose pin matched no row stops before sending, since another worker now holds the delivery. Connection status changes from a delivery or a connection test are scoped to the credential revision (the IV of the stored ciphertext, new on every save), so a late refusal for a replaced credential cannot mark its replacement failed.

## Consequences

- A run that queues a delivery succeeds before the row or note exists. The Requests list and `GET /deliveries?runId=` show the delivery's own state. Later steps cannot read the provider's result.
- Secrets never reach rows and notes: only HTTP steps receive them (decision 0025).
- Retry acts on that delivery only. It does not re-run the workflow or send a second receipt.
- One sheet and one channel per owner, public channels only, and the first 200 channels in the picker.
- A Google access token is cached per process for its hour; a 401 drops it and fetches one new token before giving up.
- The poll adds one indexed query every two seconds per worker.
- Live Google and Slack behaviour is checked by hand ([live Sheets and Slack check](../live-sheets-slack-check.md)); the automated tests use a fake server that checks JWT signatures and answers like the real APIs, including timeouts after a write.

## Update, November 2026: duplicate-refusing Sheets writes and pinned destinations

The fec03cc regression report showed that matching a row by its contents breaks if someone edits the row before the retry, and that a queued delivery followed whatever the connection pointed at when it was finally sent.

- Each Sheets delivery gets a marker when it is queued: an id from the `sheet_meta_seq` sequence (a positive 32-bit integer, unique per installation) and a short random value. The row and the marker are written in one `spreadsheets.batchUpdate` (`createDeveloperMetadata` with that `metadataId`, project-private, then `appendCells` with string values). Google applies a batch entirely or not at all and refuses a second metadata entry with an id that exists, so a retry, a parallel attempt after a stale claim, or a late copy of the first request cannot add a second row. On a 400 the worker reads that metadata id: our value means delivered (reconciled); anything else means review, never a guess.
- Markers stay 24 hours after delivery, then the worker's sweep deletes them (`sheet_meta_cleared_at`). The delete names the id, the `daloy` key and our value, and Google removes only metadata matching all three, so metadata another tool keeps under a colliding id survives even after the operator chose Mark as posted (retest of ecb5ade). Google allows about 30,000 characters of metadata per sheet and a marker uses about 15, so roughly 2,000 rows a day per sheet; past that Google refuses the batch and the delivery fails visibly. The connection test row still uses `values.append`.
- Every delivery records the connection's account and destination when it is queued (`pinned_account`, `pinned_destination`). A different account or destination at send time sends it to review with both named. Rows queued before this change have no pin and go to review too. Post again re-pins to the current connection and gives a Sheets row a fresh marker.
- Remaining limits: checked against the local fake only until the live Sheets check is run; a Teams link replaced under the same channel name is not seen as a change.

## Update after the 6e603de retest: markers of uncertain deliveries are kept

Astra showed that a request already sent by an earlier attempt, and processed by Google after the marker was deleted, adds a second row. A marker refuses duplicates only while it exists, and Daloy cannot bound how long Google may hold a request it has stopped waiting for. A late duplicate cannot be detected afterwards, so it cannot be sent to review; it has to be prevented.

- `deliveries.sheet_marker_uncertain` (migration 0013) is set, and never cleared, when a request of the delivery may still be in flight:
  - An attempt ends with an ambiguous answer: a timeout or broken connection on the write, or a 5xx on the write. This is set in the same guarded UPDATE that records the outcome.
  - A claim is taken back from a worker that died mid-call. This is set in the same UPDATE that takes the claim, so a worker that crashes before recording anything still leaves the delivery uncertain as soon as anyone picks it up again. Until then it stays `sending`, which the sweep never touches.
- The sweep deletes markers only of delivered rows whose flag is false. Every attempt of those got a definite answer (a 200, or a refusal such as 4xx or 429, which Google did not apply), so no request of theirs can still be in flight. Markers of uncertain deliveries are kept indefinitely. Retry, Post again and Mark as posted do not clear the flag.
- Concurrent sweeps are safe: a delete names id, key and value, deleting a missing marker succeeds, and stamping twice changes nothing.
- Existing markers from before migration 0013 have an unknown history, so the migration marks them uncertain and keeps them.

What this does and does not promise:

- While a delivery's marker exists, Google refuses every further write of that delivery, so the delivery is added at most once. This holds for retries, overlapping attempts, delayed acknowledgments and crashed workers. It assumes that Google enforces metadata id uniqueness and all-or-nothing batches as documented, which is checked only against the local fake until docs/live-sheets-slack-check.md is run.
- It is not unconditional exactly-once delivery:
  - A row can still be missing: the owner deletes it, or the delivery fails after its last attempt and nobody retries it.
  - Post again gives a new marker on purpose. A late request carrying the old marker can then add a second row; the operator accepted that risk by choosing Post again after a review.
  - The old marker of a Post again delivery is not deleted.
- Capacity: kept markers use about 15 characters each of Google's roughly 30,000 per sheet. Only uncertain deliveries keep them, so this should take a long time to fill. If it fills, Google refuses the batch, and the delivery fails visibly. It never adds a row silently.
