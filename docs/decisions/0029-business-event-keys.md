# 0029: Business event keys

## Context

In the eight-workflow report (fec03cc), the same refund event delivered twice started two runs (QA-06). Shops, payment providers and agents resend events after a timeout, so a repeat is normal. The MCP endpoint had the same gap for agents that retry a tool call.

## Options

1. A unique index on a column of `runs`. Runs belong to versions, not workflows, so the index would need the workflow id copied onto every run.
2. A `run_keys` table, primary key (workflow, test flag, key), written in the same transaction as the run.
3. A lookup before the insert. Two concurrent copies both see nothing and both start a run.

## Decision

Option 2.

- The key is the webhook's `eventKey` template (such as `{{trigger.event_id}}`) resolved against the checked payload, else the caller's `Idempotency-Key` header. MCP tools take an `idempotencyKey` argument. The console Run button and test runs use the trigger's `eventKey`.
- `createKeyedRun` inserts the run, then the key with `ON CONFLICT DO NOTHING`. When the key is taken, the transaction rolls back and the caller gets the first run with `duplicate: true` (still 202). A concurrent copy waits on the primary key until the first commits.
- Test runs have their own scope (`test` in the key), so a test never swallows a real event or the other way round.
- For office and purchase request tools, the MCP key becomes the request's submission key (hashed into a uuid), reusing the existing unique (workflow, submission key).
- The key identifies an event, not a business object. There is no replace mode; booking changes come in P6b as their own steps.
- Only webhooks have `eventKey`. Forms already have submission keys, and manual or scheduled runs have no event id.

## Consequences

- A replay or a burst of copies starts one run. Two workflows fed the same event both run.
- An empty key is a 400, so a workflow with `eventKey` cannot silently lose deduplication when a sender drops the id.
- Keys live as long as their run, so a resend months later is still a duplicate. Deleting a workflow or run deletes its keys.
- Migration 0015 adds the table only; existing runs have no key.
