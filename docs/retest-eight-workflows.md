# Retest handoff: eight-workflow acceptance harness

For Astra. P1 added the harness. P2 added field limits at every entry point and the condition `invalid` branch. P3 added test-run modes and chosen outcomes (migration 0014). P4 added business event keys (migration 0015). P5 added safe retries and review (migration 0017). P6a added zoned times, delays until a time and workspace resources (migration 0018). External beta stays on hold.

## Run

```bash
pnpm install
pnpm vitest run apps/api/src/scenarios.test.ts --reporter=verbose
```

It needs no Docker and no network. It starts an embedded Postgres, creates a throwaway database, and uses an in-memory mail transport and a local HTTP receiver. It does not touch the development database on localhost:5432.

## What to check

- 125 tests pass: 9 fixture checks, 1 setup step, 115 acceptance cases.
- 10 cases carry `[gap <phase>: <reason>]`: P6a 6, P6b 3, P7 1. Each one asserts the current wrong behaviour.
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

## Fixes from the 6170f4f review

- A POST answered with a 307 only after the takeover parked the run and Stop succeeded: the redirect target gets 0 POSTs (`fencing.test.ts`, "answered with a 307 only after Stop"; `http.test.ts` checks the claim is asked before every hop).
- As many simultaneous email sends as the pool has connections, held at the moment all locks are taken: all of them send and succeed with no forced release (`fencing.test.ts`, pool of 3). The worker's own pool is now 20 for a batch of 10.

## Fixes from the b31c4ce review

- A POST answered with 303 to a receipt that answers 429: the receiver gets 1 order POST and the run waits for review (`http.test.ts` and the QA-08 case "receipt lookup is throttled"). The same with a receipt answering 503 or 404.
- A worker paused before it claims the send: another worker takes over, the run is parked, the operator chooses Stop, and the paused worker then sends nothing. The receiver count stays at the one request the takeover made (`fencing.test.ts`).
- A worker paused while it holds the send claim: the takeover waits, Stop answers 409 because the run is still running, the paused worker's one POST goes out, then the run is parked; Stop after that sends nothing more.
- A 503 with a body over 1 MB on a POST: `needs_review / unknown` with "HTTP 503" in the error.

## Fixes from the ad0173f review

Run `pnpm vitest run apps/api/src/resources.test.ts` and `pnpm e2e e2e/booking-form.spec.ts`.

- Seven-minute Manila grid on the hosted form: Chromium accepts `00:07` and the run stores `...T00:07:00+08:00`. Grids that divide the day (45, 60, 90 minutes) keep a browser step of that size.
- A keyed webhook (header `Idempotency-Key`, or an `eventKey` such as `{{trigger.event_id}}`) answered 202; archive its resource, or let its time pass, then replay the same request: 202 with the first `runId` and `duplicate: true`. The Run button does the same with a webhook trigger's `eventKey`. A new key gets the 400.
- Resources page with the first list answer held back: add a resource, release the held answer, and the resource stays on screen.
- Not changed: an MCP retry with the same `idempotencyKey` after archiving or after the time passed still gets an error, because the MCP SDK checks arguments first. An `eventKey` template on a datetime, resource or padded text field is matched only after the checks.

## P6a checks (zoned times and resources)

Run `pnpm vitest run apps/api/src/scenarios.test.ts -t "QA-02" --reporter=verbose`, `pnpm vitest run packages/engine/src/zoned.test.ts apps/api/src/resources.test.ts` and `pnpm e2e e2e/booking-form.spec.ts`.

- QA-02 refuses `...T32:00`, a time in 2020, `14:30` on a 60-minute grid, and a therapist sent as "Ana" instead of a resource id, each with a 400 that names the field. A future booking on the hour still reaches both emails.
- DST, on a webhook with a datetime field: `America/New_York` `2030-03-10T02:30` is refused as skipped; `2030-11-03T01:30` is refused as happening twice, and `2030-11-03T01:30-04:00` and `-05:00` are both accepted. Try `Australia/Lord_Howe` too (it moves 30 minutes).
- Offsets: on an `Asia/Manila` 60-minute field, `...T06:00:00Z` is stored as `...T14:00:00+08:00`; `...T14:00+05:45` is refused as off the grid (it is 16:15 in Manila).
- Resources: as owner, add, rename, archive and restore on the Resources page. An operator, approver or requester can list (`GET /resources`) but gets 403 on changes. Another workspace's id, and an archived id, are refused at the hosted form, a webhook, a test run, the Run button and MCP. Rename a resource after a run: the run keeps the old name.
- Hosted form: the resource select lists only active resources, names are escaped, the time input says "Times are in <zone>", and a time typed past the browser's checks is still refused by the server.
- Reminder: a delay with `until: "{{trigger.appointment_at}}"` and `offsetSeconds: -86400` on an appointment a few hours ahead ends at the delay, the reminder is not sent, and the run page shows "Skipped: The wake-up time had passed...". With a `late` edge, that edge runs instead. A mocked one-hour delay shows `resumeAt` an hour ahead.
- Migration 0018 is additive (one table). The development database is not reset; it had 2 users, 30 workflows and 64 versions when P6a was built, all of which still parse.

## P5 checks (safe retries and review)

Run `pnpm vitest run apps/api/src/scenarios.test.ts -t "QA-08" --reporter=verbose`, `pnpm vitest run apps/worker/src/fencing.test.ts packages/db/src/mail-uncertain.test.ts apps/worker/src/steps/http.test.ts` and `pnpm e2e e2e/review.spec.ts`.

- A POST to a receiver that reads the body and then resets, or never answers, gets exactly 1 request, and the run is `needs_review` (hanging takes the 10 s timeout).
- A 503 on a POST parks after 1 request. With `"idempotent": true` on the step it is retried 3 times, every request with the key `<runId>:post`.
- A refused connection is retried (nothing was sent). A 429 with `Retry-After: 1` is retried no sooner than 1 s later, with the same key.
- Send again sends exactly 1 more request with the same key. It went through continues to the sheet row and notify without a second approval (the harness shows this on a mocked run). Stop cancels. A second action on the same run is a 409; two concurrent ones give one 204 and one 409.
- Retry on a failed run (a 400, or a dead-lettered 503) runs one more attempt with the same key.
- Worker takeover: a POST or email whose worker stopped after `dispatched_at` was written is parked, never resent. A stale worker's late answer is refused after a takeover and after an operator's answer (`fencing.test.ts`, gated by hand, no timing).
- Email: a drop before DATA retries; a drop right after 354, after the message, or a timeout waiting for the reply is `unknown` and parks; 4xx retries, 5xx fails.
- In the console: the runs list filter "Needs review" and the badge for a run whose Sheets or Slack delivery is in review; the run page panel shows the error, the redacted request and who answered and when. MCP `resolve_run` does the same actions.
- Mocked and AI-only runs send nothing; `{fail: "unknown"}` in Test outcomes reaches review on the first attempt only.
- To try against real services: point a live test run at a receiver you control that returns 503 and check that one request arrives. Real SMTP servers were not tested; the windows above use a scripted local server.
- Migration 0017 is additive. Check that the development database keeps 2 users, 27 workflows and 47 versions after `docker compose up`.

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
- Before P5, an HTTP POST that got a 503 or a reset connection after the body was read was sent three times with three keys. P5 changed this (see P5 checks).
