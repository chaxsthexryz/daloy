# Retest handoff: eight-workflow acceptance harness

For Astra. P1 added the harness. P2 added field limits at every entry point and the condition `invalid` branch. P3 added test-run modes and chosen outcomes (migration 0014). P4 added business event keys (migration 0015). External beta stays on hold.

## Run

```bash
pnpm install
pnpm vitest run apps/api/src/scenarios.test.ts --reporter=verbose
```

It needs no Docker and no network. It starts an embedded Postgres, creates a throwaway database, and uses an in-memory mail transport and a local HTTP receiver. It does not touch the development database on localhost:5432.

## What to check

- 113 tests pass: 9 fixture checks, 1 setup step, 103 acceptance cases.
- 14 test names carry `[gap <phase>: <reason>]`: P5 4, P6a 6, P6b 3, P7 1. Each one asserts the current wrong behaviour, for example two runs for one event ID or three POSTs with three different Idempotency-Keys after a 503.
- Change one gap's `today` outcome in `test/scenarios/qa-0*.ts` and confirm that test fails. Rename a step id in one edge of a fixture and confirm the fixture check fails rather than a gap passing.
- Compare the fixtures with the saved QA-01 to QA-08 drafts in the demo workspace. They are hand-written copies of the v2 shape; report anything that changes a branch or a threshold.

## Known findings recorded by the harness

- A mocked classify step returns the label with the shortest name, because Postgres `jsonb` reorders keys (QA-06: `refund` before `notify_team`).
- Fixed in P2: `min` and `max` on a number field were dropped when saved, builder test runs skipped field validation, and a comparison on "45,000" silently took `false`.

## Fixes from the c05fa81 review

Sheets stale worker (b4b8eda, migration 0016):

- Repeat the held-worker case: A writes to sheet A and its answer is held, A's claim expires, the connection moves to sheet B, Post again, B's answer is held, release A, then B answers 403. Expected: releasing A changes nothing (still sending), B ends failed with the refusal, sheet A has one row and sheet B none.
- `packages/db/src/deliveries.test.ts`, "late answers from stale workers", covers this, a late refusal after a manual Retry, a take-over that delivered, a new `claim_id` on every claim, and concurrent workers. The fake provider's `{ heldUntil }` behaviour holds an answer until the test releases it.
- Unchanged and worth a quick look: Sheets markers, uncertain markers kept, destination pinning, Mark as posted, Post again with a fresh marker. Explicit Post again can still duplicate an earlier write; Sheets stays at most once per marker.

Builder replay (second commit):

- Run a keyed test (Live), change the draft, send the same event as Mock. Expected: `{ id: <first run>, versionId: <first run's version>, mode: "live", duplicate: true }`, and the builder says the event already ran and shows the earlier live test run.

## Fixes from the 283fa1a review

- Outlook reconnect race: hold mailbox A's token refresh during a self-test, Reconnect (mailbox B), then release. Expected: the stored credential is still B's. Test: "a late token refresh for the old mailbox never overwrites the credential saved by Reconnect" in `apps/api/src/microsoft.test.ts`.
- Outlook self-test: a passing test that rotates the token records "last tested". Same file, the self-test case.
- Deliveries follow the same rule: an Outlook send that rotates its token records its result against the new revision.

## Fixes from the 8e2c5d8 review

- Pin race: queue a Sheets delivery before any sheet is connected, connect sheet A, pause worker A at its first-pin update after it read sheet A, let another worker take over, pin sheet B and deliver. Expected: A sends nothing; sheet A has no row and the delivery stays delivered to sheet B. Test: "a worker that loses its claim while pinning the first destination sends nothing" (pauses A with a table lock, then a row lock).
- Late auth refusal: hold the old key's Google sign-in refusal, replace the connection with a new key and sheet, deliver one, then release the refusal. Expected: the connection stays active with no error, the old delivery fails, and the next delivery goes in. Test: "a late authentication refusal for a replaced credential leaves the new connection working".
- No migration. Connection tests in the console (Add a test row, Send a test message) now also update the status only for the credential they tested.

## P3 checks (test outcomes, AI-only mode)

- In the builder, "Test calls" offers Mocked, Real AI only and Live. "Test outcomes" lists classify labels, approval decisions (approved, rejected, timeout) and fail options for steps that reach outside.
- QA-03, QA-04, QA-05 and QA-08 reach their rejection and timeout steps by choice; QA-06 reaches the refund POST; QA-08 stops at the sheet write when it is set to fail.
- A Real AI only run calls the configured model for each AI step and sends no email, HTTP call, approval link or delivery. With a hosted model the trigger data leaves the machine, as in a live run. A chosen label wins over the model.
- A choice that does not fit (unknown label, decision on a non-approval step) or any choice on a Live run is a 400 that names it.
- Mocked runs are labelled "test run, mocked calls"; Real AI only runs "test run, real AI, other calls mocked".

## P4 checks (business event keys)

- A webhook with `eventKey: "{{trigger.event_id}}"` answers a repeated event with `{ runId: <first>, duplicate: true }` and starts nothing. 20 concurrent copies give one run.
- A webhook without `eventKey` uses the `Idempotency-Key` header; with neither, every call is a new run.
- The same event id in two workflows starts two runs. Test runs have their own scope.
- An event with an empty key is a 400: `eventKey: {{trigger.event_id}} is empty for this event`.
- MCP: a repeated `idempotencyKey` returns the same run (or the same request reference for office and purchase request tools) with `duplicate: true`.
- Migrations 0014 (two columns on `runs`) and 0015 (`run_keys`) are additive. Check that the development database keeps its users, workflows, versions and runs after `docker compose up`.

## P2 checks

- Each refused payload names the field: `budget: must be at least 0`, `order_id: is required`, `amount: must be at least 0.01`, `budget: must be a number`.
- Exact boundaries are accepted: 0 and 50 for a 0 to 50 discount, 0.01 for a 0.01 minimum.
- A webhook with `fields` refuses an event without `event_id` (400) and keeps extra keys on a good one.
- Without an `invalid` edge, a gate on "45,000" fails the run with a message naming the value; with one, it goes to manual review.
- The 27 workflows in the development database have no `min`, `max` or `integer` keys, so they load unchanged. A saved workflow whose numeric condition gets bad data now fails the run instead of taking `false`.
- An HTTP POST that gets a 503 or a reset connection after the body was read is sent again, three times in total, with a new Idempotency-Key each time.
