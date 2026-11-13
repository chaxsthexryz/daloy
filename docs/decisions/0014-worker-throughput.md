# 0014: NOTIFY and batched fetches for the run queue

## Context

The first chaos test run in phase 9 showed the worker doing about 0.5 step jobs a second. pg-boss 12 waits a full poll interval (2 s) after every fetch, even when jobs are waiting, and each step of a run is its own job. A five-step run took more than 10 seconds of mostly idle time, and 1,000 runs would have taken hours.

## Options

1. A shorter poll interval. Still one job per poll, and more idle queries.
2. Several worker processes. Same per-process limit, more moving parts.
3. pg-boss NOTIFY on the run queue, so a sent job wakes the worker at once, plus batches of 10 with `burstWhenBatchFull`, so a full batch is followed by the next fetch without a pause. The runs in a batch are advanced in parallel.

## Decision

Option 3. `RUN_QUEUE_OPTIONS` has `notify: true`, and the worker starts pg-boss with `useListenNotify: true`. A job sent with a later `startAfter` (a retry backoff or a delay) sends its NOTIFY when it is created, not when it becomes due, so `notifyPollingIntervalSeconds` is kept at the normal 2 s instead of the 30 s default.

Running a batch in parallel is safe because the queue policy `short` keeps at most one queued job per run, so a batch never holds the same run twice, and each run is still guarded by its lease (decision 0004).

## Consequences

A 50-run probe of the five-step workflow went from 201 s to 5 s on the dev machine. One slow step (an HTTP call near its 10 s timeout, an AI step) now holds up the other nine jobs of its batch until it finishes. NOTIFY needs a session connection, so it does not work through PgBouncer in transaction mode; pg-boss then falls back to polling. The queue option only applies to new queues: a database created before this change needs `boss.updateQueue()` once.
