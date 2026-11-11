# 0001: Postgres for queues, no Redis

## Context

The worker needs a job queue for step execution, delays, approval timeouts and cron schedules. Run state already lives in Postgres, and each state transition must be one database transaction.

## Options

1. Redis with BullMQ.
2. Postgres with pg-boss.

## Decision

Use pg-boss on the same Postgres instance, in its own `pgboss` schema.

## Consequences

- One stateful service to run, back up and explain. `docker compose up` starts Postgres and Mailpit only.
- A job can be created in the same transaction that changes run state, so a crash cannot leave a run updated without its next job (or the reverse). With Redis this would need an outbox table.
- Throughput is lower than Redis. That is acceptable for small-team admin workflows; the load test in phase 9 records the real numbers.
