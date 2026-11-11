# How Daloy works

This file explains each core module in plain language: what it does, why it is built that way, which edge cases it handles, and which tests prove it. It grows with each phase.

## Layout

- `packages/engine`: the rules of a workflow run (definition schema, state machine, retries, expressions). Pure TypeScript with no database or network access, so every rule can be tested in milliseconds.
- `packages/llm-ts`: a small client for language models.
- `apps/worker`, `apps/api`, `apps/web`: built in later phases.
- Postgres stores application data and the job queues (pg-boss). See [decision 0001](decisions/0001-no-redis.md).

## LLM client (packages/llm-ts)

What it does: `generate({ system, messages, schema?, model, temperature, maxTokens, timeoutMs })` sends one chat request to Ollama's `/api/chat` endpoint and returns the text, token usage and, when a zod schema is given, the parsed and validated data.

Why this way: the base URL comes from `LLM_BASE_URL` on every call, so a gateway can sit in front of Ollama with a config change only. The schema is sent to Ollama as JSON schema (its `format` field) and checked again with zod on the way back, because a model can still return the wrong shape.

Edge cases: every failure throws `LlmError` with a `retryable` flag. Timeouts, network errors, HTTP 429 and 5xx are retryable. Other HTTP errors, non-JSON output and output that fails the schema are not retryable.

Tests: `packages/llm-ts/src/index.test.ts` (fetch is mocked, no model needed).

## Workflow definition (packages/engine/src/definition.ts)

What it does: a zod schema that checks a workflow before it can be saved or run. A definition has one trigger (webhook, schedule, form or manual), up to 100 steps (http, email, condition, delay, ai, approval) and the edges between them.

Why this way: version 1 allows straight lines with branches only. The schema enforces that shape, so the worker never has to handle a loop or two steps running at once.

Edge cases: duplicate step ids, edges to unknown steps, cycles (including a step pointing at itself), more than one entry step, a plain step with two outgoing edges (that would be a parallel branch), and branch labels that do not fit the step. A condition step branches on `true` and `false`; an approval step on `approved`, `rejected` and `timeout`. A missing branch means the run ends there. Two branches may join into the same later step. Step ids are limited to `a-z`, `0-9` and `_` because they appear inside expression paths.

Tests: `packages/engine/src/definition.test.ts`.

## State machine (packages/engine/src/state-machine.ts)

What it does: decides which status changes are allowed for a run and for a step attempt. Anything else throws `IllegalTransitionError`, which names the kind, the old state and the new state.

The rules live in `transitions.json`:

- A run goes `pending` to `running`. While running it can finish (`succeeded`, `failed`), be `cancelled`, or go to `waiting` when it reaches a delay or approval. A waiting run goes back to `running` when its scheduled job fires, or is cancelled.
- A step attempt goes `pending` to `running` (or `skipped` when its branch is not taken). A running attempt ends `succeeded` or `failed`, or goes to `waiting` for a delay or approval and ends from there.
- Finished states have no way out. A retry is a new attempt row, so a failed attempt never goes back to pending.

Why this way: the table is data, so the tests are generated from it. Every pair of states is tested, 72 cases in total, and a new rule cannot be added without a matching test result. In the worker each transition will be one database transaction (phase 2).

Tests: `packages/engine/src/state-machine.test.ts`.

## Retries (packages/engine/src/retry.ts)

What it does: after a step attempt fails, `decideRetry` returns one of three answers. `retry` comes with the next attempt number and a delay. `dead_letter` means the error was retryable but the attempts ran out, so the step goes on the dead-letter list for a person to look at. `fail` means the error is not retryable, such as an HTTP 400 or a bug.

Why this way: only errors that say `retryable: true` are retried, because repeating a request that was rejected as invalid cannot succeed. The delay is exponential backoff with full jitter: a random wait between 0 and `base * 2^(attempt - 1)`, capped at 5 minutes, with a 1 second base and 3 attempts by default. The randomness spreads out retries when many runs hit the same failing service. The random function can be passed in, so tests are exact.

Tests: `packages/engine/src/retry.test.ts`.

## Idempotency

What it does: every step attempt gets the key `runId:stepId:attempt` (`idempotencyKey` in `retry.ts`). The HTTP step will send it as an `Idempotency-Key` header (phase 4).

Why this way: the worker runs steps at least once. If it crashes after calling an external service but before saving the result, the same attempt runs again after restart with the same key, so the receiving service can see that it already handled it. A deliberate retry is a new attempt and gets a new key.

## Expressions (packages/engine/src/expressions.ts)

What it does: `resolveTemplate` fills `{{trigger.<path>}}` and `{{steps.<id>.output.<path>}}` placeholders. A template that is exactly one placeholder returns the raw value (a number stays a number); otherwise values are written into the text, with objects as JSON and missing values as empty text. `evaluateCondition` runs a branch condition such as `{ left: "{{trigger.amount}}", op: "gt", right: 100 }`.

Why this way: placeholders are property lookups only, so a template cannot run code. See [decision 0002](decisions/0002-expression-resolver.md).

Edge cases: paths that try to reach `constructor`, `__proto__` or `prototype`, or anything other than trigger data or a step output, throw `ExpressionError`. Inherited properties such as `toString` resolve to nothing. Unclosed braces stay as text. Templates over 10,000 characters, more than 50 placeholders, paths deeper than 32 segments and output over 100,000 characters are rejected. Numeric strings from forms compare as numbers, so `"5"` equals `5`.

Tests: `packages/engine/src/expressions.test.ts`.
