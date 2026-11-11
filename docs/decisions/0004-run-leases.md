# 0004: Run leases in our own table

## Context

PROJECT.md asks for a lease per running run, renewed by a heartbeat, so a restarted worker can resume runs from a crashed one. pg-boss has its own job heartbeat (`heartbeatSeconds`).

## Options

1. pg-boss job heartbeats. The minimum interval is 10 seconds, recovery happens per job rather than per run, and a run would have no owner between jobs.
2. Lease columns on `runs` (`lease_owner`, `lease_expires_at`), claimed with a conditional UPDATE, plus a sweep that queues runs whose lease has expired.

## Decision

Option 2. The lease lives next to the state it protects, so claiming a run and reading its state happen against the same row. pg-boss only delivers jobs. Duplicate jobs are harmless because a job without the lease does nothing.

## Consequences

The worker owns about 30 lines of lease code. The sweep re-sends every idle unfinished run on each pass and relies on pg-boss `singletonKey` to drop duplicates, which is fine up to tens of thousands of open runs.
