# Retest handoff: eight-workflow acceptance harness (P1)

For Astra. P1 adds tests only: no application code, schema or migration changed.

## Run

```bash
pnpm install
pnpm vitest run apps/api/src/scenarios.test.ts --reporter=verbose
```

It needs no Docker and no network. It starts an embedded Postgres, creates a throwaway database, and uses an in-memory mail transport and a local HTTP receiver. It does not touch the development database on localhost:5432.

## What to check

- 96 tests pass: 8 fixture checks, 1 setup step, 87 acceptance cases.
- 44 test names carry `[gap <phase>: <reason>]`. Each one asserts the current wrong behaviour, for example two runs for one event ID or three POSTs with three different Idempotency-Keys after a 503.
- Change one gap's `today` outcome in `test/scenarios/qa-0*.ts` and confirm that test fails. Rename a step id in one edge of a fixture and confirm the fixture check fails rather than a gap passing.
- Compare the fixtures with the saved QA-01 to QA-08 drafts in the demo workspace. They are hand-written copies of the v2 shape; report anything that changes a branch or a threshold.

## Known findings recorded by the harness

- A mocked classify step returns the label with the shortest name, because Postgres `jsonb` reorders keys (QA-06: `refund` before `notify_team`).
- `min` and `max` on a number field are dropped when the workflow is saved, so the public form accepts -5000 and 80%.
- Builder test runs skip field validation entirely.
- An HTTP POST that gets a 503 or a reset connection after the body was read is sent again, three times in total, with a new Idempotency-Key each time.
