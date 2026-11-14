# 0028: Test-run modes and chosen outcomes

## Context

The eight-workflow report (fec03cc) could not test most branches. A mocked classify step always returned one label, a mocked approval always approved, and a mocked step never failed, so rejection, timeout, refund routing and failure paths were never seen. Live AI quality and prompt-injection behaviour could only be tested with every other call live too, which sends real email.

## Options

1. Ask testers to edit the workflow, for example a dry-run flag in the trigger data. Build with AI did this in QA-01, and the flag then decides real behaviour too.
2. A per-run mode and per-step chosen outcomes, stored on the run and applied by the worker.
3. Test fixtures stored on the workflow. More to keep in sync, and nothing the scenarios need.

## Decision

Option 2.

- `mode`: `mock` fakes every outside call, `ai` calls the model only, `live` calls everything. `live: true` from older clients still works.
- `choices` per step id: `{label}` for classify, `{decision}` for approval (`approved`, `rejected`, `timeout`), `{fail: retryable|permanent}` for steps that reach outside. A chosen label wins over the model in `ai` mode.
- The API refuses a choice that does not fit its step, and any choice on a live run, naming it in a 400.
- Migration 0014 adds `runs.ai_live` and `runs.test_choices`; existing runs get `false` and null.
- Faked retries wait at most one second, like faked delays.
- Build with AI is told never to add dry-run flags or test branches.

## Consequences

- Every branch in the eight scenarios can be reached from the builder without editing the workflow or sending anything.
- An AI-only run sends trigger data to the configured model like a live run would; with a hosted provider that data leaves the machine.
- Mocked classify without a choice still returns the label with the shortest name, because Postgres jsonb reorders keys. A choice removes the guesswork.
- Choices for booking steps and for an "unknown" outcome come with P6b and P5.
