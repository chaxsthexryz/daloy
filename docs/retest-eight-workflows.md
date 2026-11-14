# Retest handoff: eight-workflow acceptance harness

For Astra. P1 added the harness. P2 added field limits and checks at every entry point and the condition `invalid` branch; it needs no migration.

## Run

```bash
pnpm install
pnpm vitest run apps/api/src/scenarios.test.ts --reporter=verbose
```

It needs no Docker and no network. It starts an embedded Postgres, creates a throwaway database, and uses an in-memory mail transport and a local HTTP receiver. It does not touch the development database on localhost:5432.

## What to check

- 104 tests pass: 9 fixture checks, 1 setup step, 94 acceptance cases.
- 29 test names carry `[gap <phase>: <reason>]` (none for P2). Each one asserts the current wrong behaviour, for example two runs for one event ID or three POSTs with three different Idempotency-Keys after a 503.
- Change one gap's `today` outcome in `test/scenarios/qa-0*.ts` and confirm that test fails. Rename a step id in one edge of a fixture and confirm the fixture check fails rather than a gap passing.
- Compare the fixtures with the saved QA-01 to QA-08 drafts in the demo workspace. They are hand-written copies of the v2 shape; report anything that changes a branch or a threshold.

## Known findings recorded by the harness

- A mocked classify step returns the label with the shortest name, because Postgres `jsonb` reorders keys (QA-06: `refund` before `notify_team`).
- Fixed in P2: `min` and `max` on a number field were dropped when saved, builder test runs skipped field validation, and a comparison on "45,000" silently took `false`.

## P2 checks

- Each refused payload names the field: `budget: must be at least 0`, `order_id: is required`, `amount: must be at least 0.01`, `budget: must be a number`.
- Exact boundaries are accepted: 0 and 50 for a 0 to 50 discount, 0.01 for a 0.01 minimum.
- A webhook with `fields` refuses an event without `event_id` (400) and keeps extra keys on a good one.
- Without an `invalid` edge, a gate on "45,000" fails the run with a message naming the value; with one, it goes to manual review.
- The 27 workflows in the development database have no `min`, `max` or `integer` keys, so they load unchanged. A saved workflow whose numeric condition gets bad data now fails the run instead of taking `false`.
- An HTTP POST that gets a 503 or a reset connection after the body was read is sent again, three times in total, with a new Idempotency-Key each time.
