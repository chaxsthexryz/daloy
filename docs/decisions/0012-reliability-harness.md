# 0012: Reliability tests run locally against a real worker process

## Context

PROJECT.md asks for a k6 load test (1,000 runs of a five-step workflow) and a chaos test (SIGKILL the worker during a 200-run batch). Both need an HTTP endpoint that counts calls per Idempotency-Key. The HTTP step's SSRF guard blocks loopback addresses and every port except 80 and 443, so it refuses a receiver on 127.0.0.1. Webhooks are rate limited to 60 calls a minute per client IP. Docker is not available on the dev machine.

## Options

1. An env var that turns off the SSRF guard or the rate limits. Simple, but it puts an off switch for two security controls into the production code.
2. A test entry point for the worker that builds the same worker with a guard that allows one loopback port, and a k6 setup that spreads calls over several loopback source addresses so each stays under the real rate limit.

## Decision

Option 2. `apps/worker/reliability/worker.ts` calls the same `startWorker()` and `createExecutor()` as `src/main.ts`. The only difference is the guard: 127.0.0.0/8 is dropped from the blocked ranges and port 4400 (the receiver) is allowed. Lease, sweep and polling keep their production values. k6 uses `localIPs` (127.0.0.2 to 127.0.0.41), one address per virtual user, 25 calls each. The API runs unchanged.

The receiver behaves like an external API that honours Idempotency-Key: the first call with a key does the work, a repeat gets the stored reply. It counts both, so the report shows redeliveries as well as executions.

The scripts spawn the worker as a plain `node --import tsx` process, so the PID they kill is the worker itself and not a pnpm or shell wrapper.

## Consequences

Production code has no test switches. The tests use embedded Postgres, the real API and a real worker process, so they cover pg-boss, leases and the sweep. They do not cover Docker networking, and the numbers come from one Windows laptop, so they show behaviour and rough speed, not capacity.
