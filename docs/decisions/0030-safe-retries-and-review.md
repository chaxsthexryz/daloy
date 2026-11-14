# 0030: Safe retries and review

## Context

In the eight-workflow report (fec03cc), QA-08 showed that a POST answered with a 503, or whose connection dropped after the receiver read the body, was sent three times, each time with a new `Idempotency-Key`. A receiver that does not deduplicate then creates three orders. A worker that died mid-send also re-ran the same attempt on its own (decision 0004). Operators had no way to retry a failed run.

## Options

1. Keep retrying and rely on the receiver to deduplicate by key. Most receivers do not, and Daloy cannot tell which do.
2. Never retry outside calls. A refused connection or a 429, where nothing happened, would then need a person every time.
3. Classify every failure by what it may have done, retry only what is safe, and park the rest for a person.

## Decision

Option 3.

- The key is `runId:stepId`, the same on every attempt (`idempotencyKey` in `retry.ts`). It is sent as a hint only. The email Message-ID stays per attempt (`runId:stepId:attempt`).
- HTTP failures carry an outcome. `not_sent`: the socket never opened for request bytes (DNS failure, refused or unreachable, an SSRF refusal, a timeout before connecting, or for https a failure before the TLS handshake finished). `rejected`: a 4xx other than 408 and 429, or a refusal Daloy makes after the receiver answered (too many redirects, a body it will not resend, an oversized response). `throttled`: a 429, with `Retry-After` in seconds or as a date. `unknown`: a 5xx, a 408, or any error or timeout after the socket opened.
- Once the receiver answered the first request with a redirect, it has that request. For a step that is not idempotent, any later failure (a throttled or failing receipt lookup, a refused hop, too many redirects) is `unknown` and parks the run; the original request is never sent again on its own. An error status is classified before its body is read, so a large 503 page stays `unknown`. (Fixes from Astra's review of b31c4ce.)
- The boundary is the socket's `connect` event (`secureConnect` for https), not the request's `finish` event. `finish` only means Node handed the bytes on, so it proves nothing either way. A connection the receiver accepted and closed straight away counts as `unknown`, since bytes may have reached it.
- A step flag `idempotent` defaults to true for GET, PUT and DELETE and false for POST and PATCH. `not_sent` and `throttled` retry, `rejected` never does, `unknown` retries only when `idempotent`. An SSRF refusal is `not_sent` but never retried, since it cannot pass.
- A retry never comes earlier than `Retry-After`. One longer than an hour dead-letters the step instead, so it is never retried early; an operator can Retry it later.
- Email (nodemailer 10.5): the message stream is piped to the socket only after the server answered DATA with 354, and errors do not say how far the session got. A `stream` plugin wraps the message stream so its first read marks "body started". A failure without a server reply after that mark is `unknown`. A failure before it is `not_sent`. A 4xx reply, before or after the body, is `throttled`; a 5xx is `rejected`.
- A non-retryable `unknown` moves the run to the new state `needs_review` and the step row keeps the outcome and error. Nothing is sent until an operator chooses It went through (the step succeeds with `{reconciled: "delivered"}` and the run carries on), Send again (one more attempt with the same key) or Stop (cancel). Operators can also Retry a failed run: one more attempt of its failed step.
- Each of those is one guarded UPDATE on the run (`WHERE state = 'needs_review'`, or `'failed'` for Retry) in `resolveRun`, so of two operators clicking at once one acts and the other gets a 409. The answered attempt keeps who acted and when.
- Crash windows: each attempt gets a random `claim_id`, and the worker finishes the row only while the claim is its own, as with Sheets deliveries (decision 0021). Right before an email or an HTTP request that is not idempotent, the step calls `claimSend`: one guarded UPDATE writes `dispatched_at` only under this worker's claim, then a transaction locks the attempt row (`FOR UPDATE`), checks the claim and state again, and holds the lock until the request has been handed to the socket (HTTP) or the message body starts (email). A worker that takes over re-claims an attempt only while `dispatched_at` is empty. So either the takeover took the claim first and the stale worker's send is refused before anything goes out, or the takeover finds the mark, waits for the lock if the send is starting, and parks the run. An operator's Stop can only come after that park, so no send starts after it. The claim is asked for before every request, redirects included, so a 307 answered after Stop starts nothing new. An email claims only once its sender is resolved, so a held lock never waits on another query. The first version wrote the mark when the attempt started and did not check the claim before sending; Astra paused a worker between the two and it sent after Stop. The second checked only the first request (a late 307 still sent) and claimed email before the sender lookup (ten sends held all ten pool connections and waited for an eleventh).
- An approval email with an unknown outcome is retried instead: each attempt sends its own working link and decisions carry across attempts (decision 0009).
- Mock and AI-only test runs set no dispatch mark and send nothing. The test choice `{fail: "unknown"}` fails only the first attempt, so a tester can see review, Send again and It went through.

## Consequences

- A receiver that answers slowly or with a 5xx gets one POST, and the run waits for a person. Parked runs show in the runs list under "Needs review", with a badge, together with runs whose Sheets or Slack delivery waits for review.
- A worker that dies between the dispatch mark and the send also parks the run. That costs a person's check, never a duplicate.
- While a send is starting, the worker holds one database connection with the attempt row locked, for the time it takes to connect (HTTP, at most the 10 s timeout) or to reach the message body (SMTP, bounded by nodemailer's timeouts). Nothing runs a query while holding it. The worker's pool is 20 connections, twice its run batch of 10, so heartbeats and completions always have connections left. A takeover waits for the lock.
- It went through gives later steps an output without `status` or `body`, so templates that read `{{steps.post.output.body...}}` resolve to nothing after it.
- The reliability harness counts one key per run and step. Its receiver deduplicates by key, so its steps are marked `idempotent: true`; otherwise every kill mid-POST would wait for review.
- Attempts that were already running when this version is deployed have no dispatch mark, so a takeover re-runs them as before.
- Migration 0017 is additive: the enum value, `step_runs.outcome` (checked against the four values), `claim_id`, `dispatched_at`, `resolved_by` and `resolved_at`.
