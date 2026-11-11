# How Daloy works

This file explains each core module in plain language: what it does, why it is built that way, which edge cases it handles, and which tests prove it. It grows with each phase.

## Layout

- `packages/engine`: the rules of a workflow run (definition schema, state machine, retries, expressions). Pure TypeScript with no database or network access, so every rule can be tested in milliseconds.
- `packages/llm-ts`: a small client for language models.
- `packages/db`: Drizzle schema and SQL migrations, shared by the worker and the API.
- `apps/worker`: takes run jobs from pg-boss and executes steps.
- `apps/api`: NestJS API for the console, plus the public webhook and form routes.
- `apps/web`: built in phase 5.
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

## Database (packages/db)

What it does: `schema.ts` defines the ten tables from PROJECT.md with Drizzle. `pnpm --filter @daloy/db generate` turns schema changes into SQL files in `packages/db/migrations`, and `migrate()` applies them. The `run_state` and `step_state` enums are built from the engine's transition table, so the database cannot hold a state the state machine does not know.

Why this way: one schema package means the worker and the API (phase 3) can never disagree about a column. Generated SQL migrations are plain files a reviewer can read.

Edge cases: `step_runs` has a unique key on `(run_id, step_id, attempt)`, which is the idempotency key, so the same attempt can never be recorded twice. Session ids and API tokens are stored as hashes. Secrets are stored encrypted with the key outside the database.

## Worker (apps/worker)

What it does: the worker takes `advance-run` jobs from pg-boss. One job does one piece of work for one run: run the next step attempt, or mark the run finished. Then it queues the run again. `advance.ts` holds this logic and `worker.ts` wires it to pg-boss.

Leases: before it touches a run, the worker writes its name and an expiry time (30 seconds ahead) on the run row. The UPDATE only succeeds when no other worker holds a live lease, so two workers can never advance the same run at once. A heartbeat pushes the expiry forward every 10 seconds while a step runs. The lease is cleared when the job ends.

Crash recovery: every 15 seconds a sweep looks for unfinished runs with no live lease and queues them. The queue keeps at most one waiting job per run, so a run that already has a job queued is not queued twice. If a worker dies in the middle of a step, its lease expires, the sweep queues the run, and the next worker finds the step attempt still marked running. It runs that same attempt again with the same idempotency key, so an external service can tell it is a repeat.

Retries: when a step throws, the engine's `decideRetry` picks one of three outcomes. A retryable error with attempts left marks the attempt failed, stores the time of the next attempt on the run (`next_attempt_at`) and queues a delayed job. A retryable error on the last attempt marks the attempt failed with `dead_letter = true` and fails the run. The dead-letter list is a query on that column. Any other error fails the run at once.

State changes: every change goes through `assertTransition` and then a guarded UPDATE (`WHERE state = <expected>`), so an illegal or concurrent change throws instead of overwriting. A failed step and its failed run are written in one transaction.

Shutdown: on SIGTERM the worker stops taking jobs, waits up to 30 seconds for jobs in progress, and closes the database pool.

Tests: `apps/worker/src/worker.test.ts` runs the real worker against Postgres. It covers a run that succeeds and passes outputs along, a condition branch, a retry that then succeeds, a step that runs out of attempts (dead letter), an error that is not retryable, a run left behind by a crashed worker (resumed with the same idempotency key, no duplicate row), and a run held by another worker's live lease (left alone).

Limits: step types arrive in phase 4. Until then the worker started by `main.ts` fails every step. The `waiting` state is unused until the delay and approval steps exist.

## API (apps/api)

What it does: the console API covers sign up, login, workflows and their versions, secrets, API tokens and run history. `app.ts` builds the Nest app and `main.ts` starts it. Each file in `src` holds one area: `auth.ts`, `workflows.ts`, `secrets.ts`, `tokens.ts`, `runs.ts`, and `public.ts` for the unauthenticated trigger routes.

Validation: every body, path parameter and query value goes through `ZodPipe` with a zod schema before a handler sees it. Workflow definitions are checked with the engine's `definitionSchema`, so the API and the worker apply the same rules.

Sessions: logging in creates 32 random bytes, sent as an httpOnly, SameSite=Lax cookie (Secure in production). Only the SHA-256 of the cookie is stored, so a database leak does not hand out live sessions. Passwords are hashed with argon2id. A login with an unknown email still runs a hash check, so response time does not reveal which emails exist.

Ownership: every console query filters on the signed-in user, and another user's workflow returns 404, the same as one that does not exist.

Versions: saving a definition adds the next immutable version. Publishing also makes it live (the newest published version is the live one) and syncs the workflow's single trigger row and pg-boss schedule.

Secrets: values are encrypted with AES-256-GCM using `SECRETS_KEY`, with a fresh IV per write. The owner id and secret name are bound in as associated data, so a ciphertext copied to another row will not decrypt. The API never returns a value, only names.

API tokens: shown once at creation, stored as SHA-256, and revocable. MCP clients use them in phase 8.

Rate limits: every route allows 120 requests per minute per IP, login and form submissions 10, webhooks 60. Request bodies are capped at 256 kb for JSON and 64 kb for forms.

Tests: `api.test.ts` drives the real app with supertest against Postgres. `secrets.test.ts` covers encryption and signature checks. `e2e.test.ts` runs the API and the worker together, from a webhook call to a finished run.

Limits: rate limit counters live in process memory, so each API instance counts on its own. Approval routes arrive in phase 7, and the full run history view in phase 6.

## Triggers

- Manual: `POST /workflows/:id/runs` from the console runs the live version with a JSON payload, whatever its trigger type.
- Webhook: `POST /hooks/:path`, where the path is 32 random bytes made at the first publish and kept across later publishes. If the trigger names a secret (`hmacSecret`), the request must carry `X-Daloy-Signature: sha256=<hex HMAC of the raw body>`, compared in constant time. A named secret that no longer exists rejects every call.
- Form: `GET /forms/:triggerId` renders an HTML form from the field list in the definition, with labels escaped. `POST` validates the fields and starts a run. A hidden honeypot field catches bots: if it is filled, the API answers as if it worked and starts nothing.
- Schedule: publishing registers a pg-boss cron schedule keyed by workflow id. pg-boss sends a job to `schedule-trigger` at each tick, and the worker starts a run of the live version. Publishing a version with another trigger type removes the schedule.
