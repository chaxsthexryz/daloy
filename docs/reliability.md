# Reliability tests

Real output of the two tests in PROJECT.md, run on 2026-11-13. Nothing here is estimated or edited, apart from dropping the pnpm banner, the "worker started" and "api listening" lines, and blank lines.

Machine: AMD Ryzen 5 5600 (6 cores, 12 threads), 16 GB RAM, Windows 11, Node 24.13.0. Postgres 17 (embedded-postgres), the API and one worker process all on the same machine, no Docker.

Workflow for both tests (five steps): HTTP POST to a test receiver, condition on its reply, HTTP POST, one-second delay, HTTP POST. That is five step runs and three idempotency keys per run.

The test receiver stands in for an external API that honours the Idempotency-Key header: the first call with a key does the work, a repeated call gets the stored reply. It counts every call. The checks are:

- every run ends in `succeeded`
- every run and step pair has exactly one succeeded step run, so none is lost or duplicated, and no step run is left in `running`
- the keys the receiver executed are exactly the keys of the succeeded HTTP attempts, each executed once

How the scripts work is in [how-it-works.md](how-it-works.md#reliability-tests-appsworkerreliability) and [decision 0012](decisions/0012-reliability-harness.md).

## Load test

`K6=path/to/k6 pnpm reliability:load`. k6 v2.4.0 sends 1,000 webhook calls to the real API (40 virtual users, 25 calls each, each user from its own loopback address so the 60 calls a minute per IP webhook limit stays on). One worker runs the 1,000 runs. Run time is `finished_at - created_at` of each run.

```text
  █ THRESHOLDS
    checks
    ✓ 'rate==1' rate=100.00%
  █ TOTAL RESULTS
    checks_total.......: 1000    910.185614/s
    checks_succeeded...: 100.00% 1000 out of 1000
    checks_failed......: 0.00%   0 out of 1000
    ✓ accepted (202)
    HTTP
    http_req_duration..............: avg=43.04ms min=4.26ms med=38.44ms max=249.06ms p(90)=54.51ms p(95)=64.62ms
      { expected_response:true }...: avg=43.04ms min=4.26ms med=38.44ms max=249.06ms p(90)=54.51ms p(95)=64.62ms
    http_req_failed................: 0.00%  0 out of 1000
    http_reqs......................: 1000   910.185614/s
    EXECUTION
    iteration_duration.............: avg=43.18ms min=4.26ms med=38.47ms max=250.39ms p(90)=54.58ms p(95)=65.36ms
    iterations.....................: 1000   910.185614/s
    vus............................: 40     min=40        max=40
    vus_max........................: 40     min=40        max=40
    NETWORK
    data_received..................: 929 kB 846 kB/s
    data_sent......................: 184 kB 168 kB/s
load test: 1000 runs of the five-step workflow, one worker
runs: 1000 (expected 1000), by state {"succeeded":1000}
step_runs: 5000, by state {"succeeded":5000}
run/step pairs without a succeeded attempt: 0; with more than one: 0
idempotency keys: 3000 expected, 3000 executed by the receiver, 0 unexpected, 0 never received
deliveries: 3000 calls, 0 keys delivered more than once (executed once)
run time (created to finished): p50 12320 ms, p95 12411 ms, max 12473 ms
first run created to last run finished: 13.5 s
result: PASS
```

What the numbers say: k6 sent all 1,000 calls in about 1.1 seconds, so all runs were queued at almost the same moment. The worker takes jobs in order, so it moves all runs forward one step at a time and they finish close together. That is why p50 and p95 are both near the 13.5 seconds the whole batch took. About 6,000 jobs in 13.5 seconds is roughly 440 jobs a second for one worker process. Before decision 0014 the same worker did about 0.5 jobs a second (a 50-run probe took 201 seconds; it now takes 5).

## Chaos test

`pnpm reliability:chaos`. 200 runs are created up front. The script starts a worker, waits until the receiver has seen 20 to 60 new executions, kills the worker with SIGKILL (on Windows that is TerminateProcess: no shutdown handler runs), starts a new one, and repeats ten times. Then it waits until every run has finished. Only the worker processes the script started are killed, by PID.

```text
kill 1: worker 26504 killed after 58 executed keys
kill 2: worker 24536 killed after 115 executed keys
kill 3: worker 21364 killed after 138 executed keys
kill 4: worker 22864 killed after 175 executed keys
kill 5: worker 26108 killed after 227 executed keys
kill 6: worker 26496 killed after 293 executed keys
kill 7: worker 26316 killed after 352 executed keys
kill 8: worker 25976 killed after 392 executed keys
kill 9: worker 7424 killed after 422 executed keys
kill 10: worker 20368 killed after 466 executed keys
chaos test: 200 runs, 10 SIGKILLs, 60.7 s from first worker start to last check
runs: 200 (expected 200), by state {"succeeded":200}
step_runs: 1000, by state {"succeeded":1000}
run/step pairs without a succeeded attempt: 0; with more than one: 0
idempotency keys: 600 expected, 600 executed by the receiver, 0 unexpected, 0 never received
deliveries: 606 calls, 6 keys delivered more than once (executed once)
run time (created to finished): p50 20107 ms, p95 60667 ms, max 60701 ms
first run created to last run finished: 60.7 s
result: PASS
```

What the numbers say: six keys reached the receiver twice. Each time the worker was killed after the receiver had answered but before the step run was marked succeeded. The next worker found the attempt still marked `running`, its lease expired, and ran the same attempt again with the same idempotency key, so the receiver replied from its store and the work was done once. Runs held by a killed worker wait for the 30-second lease to expire and the 15-second sweep to pick them up, which is where the p95 of about 60 seconds comes from.

## Limits of these tests

- One machine, one worker process, everything on loopback. The numbers show correctness under load and crashes, and rough speed. They are not a capacity figure.
- The receiver answers at once. A slow external API holds up the other jobs in the worker's batch (decision 0014).
- Neither test kills Postgres or the API.
- Backup, restore and stopping all sends are covered by `docs/operations.md`, not by these tests.
