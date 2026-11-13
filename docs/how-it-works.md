# How Daloy works

This file explains each core module in plain language: what it does, why it is built that way, which edge cases it handles, and which tests prove it. It grows with each phase.

## Layout

- `packages/engine`: the rules of a workflow run (definition schema, state machine, retries, expressions). Pure TypeScript with no database or network access, so every rule can be tested in milliseconds.
- `packages/llm-ts`: a small client for language models.
- `packages/db`: Drizzle schema and SQL migrations, shared by the worker and the API.
- `apps/worker`: takes run jobs from pg-boss and executes steps.
- `apps/api`: NestJS API for the console, plus the public webhook and form routes.
- `apps/web`: the console. Vite, React and React Flow. In compose the API serves its build.
- Postgres stores application data and the job queues (pg-boss). See [decision 0001](decisions/0001-no-redis.md).

## LLM client (packages/llm-ts)

What it does: `generate({ system, messages, schema?, model, temperature, maxTokens, timeoutMs })` sends one chat request and returns the text, token usage and, when a zod schema is given, the parsed and validated data. `LLM_PROVIDER` picks the API: `ollama` (the default, Ollama's `/api/chat`) or `openai` (any OpenAI-compatible `/chat/completions`, such as the Gemini API, LM Studio, llama.cpp or vLLM). `LLM_API_KEY`, when set, goes in an `Authorization: Bearer` header.

Why this way: provider, base URL and key are read on every call, so switching between a local model, a hosted free tier and a gateway is a config change only. One OpenAI-compatible mode covers most hosted and local servers, so there is no client per vendor (decision 0015). The schema is sent as JSON schema (Ollama's `format` field, or `response_format` of type `json_schema`) and checked again with zod on the way back, because a model can still return the wrong shape.

Edge cases: an unknown `LLM_PROVIDER` fails the step at once without a request. A reply without token counts records 0 tokens. Error messages carry only the HTTP status, never the provider's error body, which can echo the key. Every failure throws `LlmError` with a `retryable` flag. Timeouts, network errors, HTTP 429 and 5xx are retryable. Other HTTP errors, non-JSON output and output that fails the schema are not retryable. For the last two, `invalidOutput` is set and `usage` holds the tokens the reply cost, so the AI step can retry once and still record the tokens.

Thinking models: Qwen 3.5 and similar models first write hidden reasoning, which counts against `maxTokens`. On a small local model a classify call spent about 300 tokens thinking, so the 256-token console test returned empty content and failed as "not valid JSON". `aiConnection()` in `packages/db/src/ai-settings.ts` therefore adds `chat_template_kwargs: { enable_thinking: false }` (the `extraBody` of the connection) when the provider is `openai` and the base URL is this machine (`localhost`, `127.x`, `[::1]` or `host.docker.internal`). Hosted APIs never get the field, because they may reject unknown fields. With thinking off, Qwen3.5-4B on llama.cpp answers the console test in about 0.5 to 1 second.

The Gemini API is different: Google's thinking docs say Gemini 3 and newer cannot turn thinking off, and that thinking tokens count toward the output limit, which can leave the answer truncated or empty. For the Gemini API's host (from the Gemini preset or from `LLM_BASE_URL`), the connection asks for `reasoning_effort: "low"`, a value every current Gemini model accepts, and sets `reasoningTokens: 2048`. `generate()` adds that to `max_tokens`, so each caller's `maxTokens` stays the budget for the answer itself. If a reply still comes back empty with `finish_reason: "length"`, the error says the model used up its token limit while thinking, instead of "not valid JSON". See decision 0018. Tests: `ai-settings.test.ts` ("turns off thinking only for a local OpenAI-compatible server", "asks Gemini for low thinking") and `llm-ts/src/index.test.ts` ("adds a connection's extra body fields", "thinking headroom", "used up its token limit").

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

What it does: every step attempt gets the key `runId:stepId:attempt` (`idempotencyKey` in `retry.ts`). The HTTP step sends it as an `Idempotency-Key` header, and the email step turns it into the `Message-ID`.

Why this way: the worker runs steps at least once. If it crashes after calling an external service but before saving the result, the same attempt runs again after restart with the same key, so the receiving service can see that it already handled it. A deliberate retry is a new attempt and gets a new key.

## Expressions (packages/engine/src/expressions.ts)

What it does: `resolveTemplate` fills `{{trigger.<path>}}`, `{{steps.<id>.output.<path>}}` and `{{secrets.<name>}}` placeholders. Secrets are only available while the worker runs a step. A template that is exactly one placeholder returns the raw value (a number stays a number); otherwise values are written into the text, with objects as JSON and missing values as empty text. `evaluateCondition` runs a branch condition such as `{ left: "{{trigger.amount}}", op: "gt", right: 100 }`.

Why this way: placeholders are property lookups only, so a template cannot run code. See [decision 0002](decisions/0002-expression-resolver.md).

Edge cases: paths that try to reach `constructor`, `__proto__` or `prototype`, or anything other than trigger data or a step output, throw `ExpressionError`. Inherited properties such as `toString` resolve to nothing. Unclosed braces stay as text. Resolution is a single pass, so trigger data that contains `{{secrets.x}}` is inserted as that literal text and never resolved. Templates over 10,000 characters, more than 50 placeholders, paths deeper than 32 segments and output over 100,000 characters are rejected. Numeric strings from forms compare as numbers, so `"5"` equals `5`.

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

Fetching: the run queue uses Postgres NOTIFY, so a job that is sent wakes the worker at once instead of at its next 2-second poll. The worker fetches up to 10 jobs at a time and fetches again straight away while batches come back full. The runs in a batch are advanced in parallel: the queue holds one waiting job per run, so a batch never contains the same run twice, and each run is still guarded by its lease. Without this the worker managed about half a job a second, because pg-boss waits a poll interval after every fetch (decision 0014).

Shutdown: on SIGTERM the worker stops taking jobs, waits up to 30 seconds for jobs in progress, and closes the database pool.

Waiting: a step can return a wake-up time instead of finishing (delay and approval do). The worker then moves the step and the run to `waiting` in one transaction, stores the time in `next_attempt_at` and queues a job that starts at that time. Nothing sleeps in the worker. When the job runs, or the sweep finds the run after the time has passed, the step moves to `succeeded`, the run moves back to `running`, and the flow carries on. The wait is one attempt, so the step does not run again on wake-up. An approval step schedules no job, because an early answer has to be able to wake the run and the queue holds one job per run; its timeout is picked up by the sweep (see Approval step below). A job that reaches a run before its wake-up time (a duplicate from the sweep, say) does nothing and schedules nothing: a job scheduled for an approval's timeout would block the earlier wake-up that an answer needs. `worker.test.ts` has a test for that case.

Tests: `apps/worker/src/worker.test.ts` runs the real worker against Postgres. It covers a run that succeeds and passes outputs along, a condition branch, a retry that then succeeds, a step that runs out of attempts (dead letter), an error that is not retryable, a run that waits and then carries on, an approval answered by the approver and one that times out, token counts on AI attempts (failed ones too), a run left behind by a crashed worker (resumed with the same idempotency key, no duplicate row), and a run held by another worker's live lease (left alone).

## Steps (apps/worker/src/steps)

What it does: `createExecutor` in `index.ts` runs one step attempt. It decrypts the workflow owner's secrets, resolves every template in the step config, runs the step, and then replaces each secret value in the output and in any error text with `[secret]`. Only the redacted result is written to `step_runs`. The secret crypto lives in `packages/db/src/crypto.ts`, shared with the API.

- HTTP (`http.ts`): GET, POST, PUT, PATCH or DELETE with a templated URL, headers (up to 20) and body. It follows up to 3 redirects and runs the SSRF checks again on each one. A 303, or a 301 or 302 after a POST, switches to GET without a body. A redirect to another origin drops the caller's headers, so an `Authorization` header is not sent to a third party. The whole call has a 10 second timeout and the response is cut off at 1 MB. Output is `{ status, headers, body }`, with the body parsed when the content type is JSON. 5xx, 429, timeouts and network errors are retryable. Other 4xx responses, oversized responses and SSRF blocks are not.
- Email (`packages/db/src/mail.ts`): plain text over SMTP (nodemailer), sent as the workflow owner. `sendAs()` asks `resolveSender()` who that is: the owner's own Gmail account, or the installation's server (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) when they connected none. See Business profile and Gmail sender below. The `to` template is resolved first, then split on commas, and each address is checked. At most 10 recipients. The `Message-ID` comes from the idempotency key. SMTP 5xx replies are final, and anything else is retried. The step output records the sending address.
- Condition: evaluates the step's condition and returns the `true` or `false` branch.
- Delay: returns a wake-up time 1 second to 30 days ahead (see Waiting above).
- AI task (`ai.ts`): see AI step below.
- Approval: see Approval step below.

Edge cases: a secret that appears in a response body, a response header or an error message is redacted. Redaction is plain text replacement, so a very short secret (such as `1`) also hides unrelated text that matches it.

Tests: `steps/index.test.ts` (secrets reach the request but not the stored output or errors, trigger data cannot pull in a secret, templates, condition, delay, mocked ai and approval, the approval email and its stored hash), `packages/db/src/mail.test.ts` (recipient cap and validation, message id, SMTP error mapping, sending as the owner) and `steps/senders.test.ts` (two owners, approval mail, disconnecting one owner).

## AI model settings (packages/db/src/ai-settings.ts, apps/api/src/settings.ts, apps/web/src/Settings.tsx)

What it does: each user picks the model their AI steps run with on the console's AI model page: a local model, the Gemini API, OpenAI or OpenRouter, plus a model name and, for the hosted ones, an API key. `aiConnection()` turns that choice into the provider, URL, key and model that `generate()` uses. The worker calls it for the workflow owner on every AI step, so a change applies to the next step without a restart. The page shows the choice in use at the top and a "key saved" tag on each provider that has one. "Save and test" saves and then makes one real call with a sample inquiry through the Inquiry triage classify prompt, reporting the label, the time and the tokens, or a plain reason for the failure. "Save without testing" skips that call.

Keys per provider: each hosted provider keeps its own encrypted key in `ai_keys` (one row per user and provider, migration `0005_ai_keys_per_provider`, which moved keys saved before it). Switching from Gemini to the local model and back needs no new key. Saving a provider with a new key replaces only that provider's key.

Local models: for the local choice the page lists the models the server in `.env` actually has, from `GET /settings/ai/local-models` (`listModels()` in llm-ts: Ollama's `/api/tags` or `/models` on an OpenAI-compatible server such as llama.cpp). Only the operator's `LLM_BASE_URL` is ever called. If the server does not answer, the page says so, offers "Check again" and still accepts a typed model name. The local default model is `LLM_MODEL`.

Why this way: switching models used to mean editing `.env` and restarting the worker. Hosted providers have fixed URLs in code and the local choice uses the operator's `LLM_BASE_URL`, so a user can never make the server call an address of their choosing (decision 0016).

Edge cases: no saved choice means the env vars decide, as before. A hosted choice without a key, new or saved, is refused. The provider is part of each key's associated data, so a key saved for one provider never decrypts as another's. Keys are encrypted like secrets and the API never returns them, only `hasKey` and the list of providers with a key (`keys`). The test is limited to 10 a minute per IP because it costs tokens. Failure messages come from the HTTP status only, never the provider's response body.

Tests: `packages/db/src/ai-settings.test.ts` (env fallback, encrypted key, each provider's key kept across switches, a key moved to another provider does not decrypt, key required), `apps/api/src/settings.test.ts` (session needed, key never returned, validation, local default from `LLM_MODEL`, local model list and a server that is down, live test against a fake Ollama, unreachable model), `packages/llm-ts/src/index.test.ts` ("listModels"), `apps/worker/src/steps/index.test.ts` (an AI step uses its owner's model), `e2e/settings.spec.ts` (save Gemini with a key, key shown as saved but never displayed, switch to local and back with the key kept).

## Building workflows by describing them (packages/engine/src/ai-draft.ts, apps/api/src/ai-draft.ts, apps/web/src/AiDraft.tsx)

What it does: on the workflow list, "Build with AI" takes a description in plain words and opens the editor on a new, unpublished workflow the model drafted. In the editor, "Ask the AI" is a short chat: each message asks for a change, and the model rewrites the current draft, which the canvas shows straight away as unsaved. Both use `POST /ai/draft` with the model picked on the AI model page.

Why this way: the model writes the whole definition as JSON, and `parseDraftReply()` checks it with the same `definitionSchema` as a hand-built workflow, so a draft can never hold a step type, edge or branch the engine would refuse. The prompt lists each step type's JSON schema (from `stepJsonSchemas()`), the branch labels, the expression syntax and the Inquiry triage template as an example; it stays under about 3,000 tokens so a local model's default context fits it. No JSON schema is sent to the provider: the definition union is too complex for some providers' schema support, so the reply text is parsed instead (decision 0017).

Edge cases: a reply with text or a code fence around the JSON still parses. An invalid draft gets one more try with its problems listed; if that also fails, the API answers 422 with the reasons and nothing is saved. A model that cannot be reached, or rejects the key, gives the same plain reasons as the AI model test. The description and the current draft go in the user message, never the system prompt. Drafts are never saved or published by the AI: the user reviews, test runs and publishes them, and live HTTP calls still pass the SSRF guard. A taken slug gets `-2`, `-3` and so on. Small local models often write invalid drafts; Gemini or a larger model does much better.

Tests: `packages/engine/src/ai-draft.test.ts` (prompt content and size, fenced replies, readable errors, graph errors), `apps/api/src/ai-draft.test.ts` (session needed, draft from a request, one repair with the errors, 422 after two failures, change request carries the current draft, input limits), `e2e/ai-draft.spec.ts` (describe, review the draft, change it in the chat; `e2e/llm-fake.ts` stands in for the model).

## AI step (packages/engine/src/ai.ts, apps/worker/src/steps/ai.ts)

What it does: runs one task on text. `classify` picks one of the configured labels, `extract` pulls named fields out of the text, `summarize` writes a short summary and `draft` writes a reply. Later steps read the result, for example `{{steps.classify.output.label}}` in a condition. The model is `LLM_MODEL` (default `llama3.2`) at `LLM_BASE_URL`, through `packages/llm-ts`.

Why this way: the text usually comes from a form or webhook, so it is untrusted. Only the `input` field is a template. It resolves to the text, which goes in the user message between `<data>` and `</data>`. The instructions and the label and field descriptions go in the system prompt, so the schema rejects `{{` in them and they are never resolved. Each task has a fixed output schema (`aiOutputSchema`): classify can only return one of its labels, extract returns every field as text or null. The reply is checked against it, so a later step never sees a shape it did not expect. See [decision 0010](decisions/0010-ai-step.md).

Edge cases: a closing `</data` tag inside the text is escaped, so the text cannot end its own block. Text over 20,000 characters is cut. A reply that is not JSON or fails the schema is retried once, then the step fails. Timeouts and server errors follow the normal retry policy. Input and output token counts are stored on `step_runs` for every attempt, including failed ones. In a test run without live calls the model is not called and the step returns a fixed reply that matches the schema.

Tests: `packages/engine/src/ai.test.ts` (config rules, output schemas, prompt placement and the escaped closing tag, mock replies match the schema) and `apps/worker/src/steps/ai.test.ts` (a fake Ollama server: the data is only in the user message, the schema is sent as `format`, tokens are returned, a bad reply is retried once, a 503 stays retryable).

## Approval step (packages/db/src/approvals.ts, apps/api/src/approvals.ts)

What it does: emails a person a link, waits, and continues on the `approved`, `rejected` or `timeout` branch. The config has `to`, `subject`, `message` (all templates) and `timeoutSeconds` (one minute to 30 days).

How it works: the worker creates a 32-byte random token and stores only its SHA-256 in `approvals` with the expiry. The email holds the link `PUBLIC_URL/approvals/<token>`. The token is not part of the stored step input, so it never shows in run history. The step and the run go to `waiting`. Opening the link (GET) shows the message and two buttons and changes nothing. Pressing one (POST) records the decision with one guarded UPDATE that only matches a link that is unused and not expired, sets the run's wake-up time to now and queues it. When the step wakes, the worker calls `claimTimeout` in the same transaction that finishes the step: if nobody answered, it marks the link used with the decision `timeout`. Either way the step takes the branch that is stored. See [decision 0009](decisions/0009-approval-links.md).

Edge cases: a second click, an expired link and an unknown token all get the same 404 page. If the click and the timeout happen at the same moment, the row lock lets only one of them win. If a worker crashes after creating the link, the attempt runs again, deletes the old link and sends a new one. The public routes allow 30 page views and 10 decisions a minute per IP, and answer with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. In a test run without live calls no email is sent and the step takes the `approved` branch at once.

Named approvals: with `approver` set instead of `to`, only that workspace member can answer, signed in, and the email goes to their sign-in address. The guarded UPDATE also requires the signed-in user to be the approver and, at that moment, a member of the run's workspace with the owner or approver role, and it stores who decided. A signed-out visitor sees only a sign-in link and anyone else sees "assigned to someone else", with no request details. See the office teams section below and [decision 0022](decisions/0022-workspace-members-named-approvals.md).

Tests: `packages/db/src/approvals.test.ts` (stored hash, single use, expiry, replacing a link, the click and timeout race), `apps/api/src/approvals.test.ts` (escaped page, GET changes nothing, POST once then 404, same page for unknown and expired links, bad decisions rejected, rate limit), `apps/worker/src/worker.test.ts` (approve and timeout branches) and `e2e/approval.spec.ts` (a live run waits, the email arrives at a test SMTP server, the link approves once, the run finishes on the approved branch).

## SSRF protection (apps/worker/src/steps/ssrf.ts)

What it does: stops an HTTP step from reaching the server's own network. Only `http:` and `https:` on ports 80 and 443 are allowed. A `node:net` `BlockList` holds the private, loopback, link-local (including the 169.254.169.254 metadata address), shared, reserved and multicast ranges for IPv4 and IPv6. IPv4-mapped IPv6 addresses such as `::ffff:127.0.0.1` are checked against the IPv4 ranges.

Why this way: the hostname is checked inside the `lookup` function passed to `http.request`. The socket connects to the exact address that lookup returned, so a DNS server cannot answer once with a public address for the check and then with a private one for the connection. See [decision 0006](decisions/0006-ssrf.md).

Edge cases: Node does not call `lookup` for IP literals, so `checkUrl` checks those first. `new URL()` has already normalised spellings such as `http://2130706433` and `http://0x7f.1` to `127.0.0.1`. A hostname is refused if any of its addresses is blocked. Requests use `agent: false`, so a pooled connection never skips the check.

Tests: `steps/ssrf.test.ts` (every range, IPv6 and mapped addresses, scheme and port rules, odd IP spellings, lookup with mixed answers) and `steps/http.test.ts` (redirect to a private address, DNS rebinding with a resolver that changes its answer, the redirect limit, the 1 MB limit, the timeout, header stripping across origins).

## API (apps/api)

What it does: the console API covers sign up, login, workflows and their versions, secrets, API tokens and run history. `app.ts` builds the Nest app and `main.ts` starts it. Each file in `src` holds one area: `auth.ts`, `workflows.ts`, `secrets.ts`, `tokens.ts`, `runs.ts`, and `public.ts` for the unauthenticated trigger routes.

Validation: every body, path parameter and query value goes through `ZodPipe` with a zod schema before a handler sees it. Workflow definitions are checked with the engine's `definitionSchema`, so the API and the worker apply the same rules.

Sessions: logging in creates 32 random bytes, sent as an httpOnly, SameSite=Lax cookie (Secure in production). Only the SHA-256 of the cookie is stored, so a database leak does not hand out live sessions. Passwords are hashed with argon2id. A login with an unknown email still runs a hash check, so response time does not reveal which emails exist.

Ownership: every console query filters on the signed-in user, and another user's workflow returns 404, the same as one that does not exist.

Versions: saving a definition adds the next immutable version. Publishing also makes it live (the newest published version is the live one) and syncs the workflow's single trigger row and pg-boss schedule.

Secrets: values are encrypted with AES-256-GCM using `SECRETS_KEY`, with a fresh IV per write. The owner id and secret name are bound in as associated data, so a ciphertext copied to another row will not decrypt. The API never returns a value, only names.

API tokens: shown once at creation, stored as SHA-256, and revocable. MCP clients send them as bearer tokens (see MCP below). The console page `#/tokens` creates, lists and revokes them.

Rate limits: every route allows 120 requests per minute per IP, login, form submissions and approval decisions 10, approval pages 30, webhooks 60. Request bodies are capped at 256 kb for JSON and 64 kb for forms.

Tests: `api.test.ts` drives the real app with supertest against Postgres. `secrets.test.ts` covers encryption and signature checks. `e2e.test.ts` runs the API and the worker together, from a webhook call to a finished run.

Limits: rate limit counters live in process memory, so each API instance counts on its own.

## Triggers

- Manual: `POST /workflows/:id/runs` from the console runs the live version with a JSON payload, whatever its trigger type.
- Webhook: `POST /hooks/:path`, where the path is 32 random bytes made at the first publish and kept across later publishes. If the trigger names a secret (`hmacSecret`), the request must carry `X-Daloy-Signature: sha256=<hex HMAC of the raw body>`, compared in constant time. A named secret that no longer exists rejects every call.
- Form: `GET /forms/:triggerId` renders an HTML form from the field list in the definition, with labels escaped. `POST` validates the fields and starts a run. A hidden honeypot field catches bots: if it is filled, the API answers as if it worked and starts nothing. A form of an office request automation also records a request (see "Track an office request").
- Schedule: publishing registers a pg-boss cron schedule keyed by workflow id. pg-boss sends a job to `schedule-trigger` at each tick, and the worker starts a run of the live version. Publishing a version with another trigger type removes the schedule.

## Builder (apps/web)

What it does: the console where a user signs in, creates a workflow (blank or from a starter template), builds it, test-runs it with sample data, publishes it and runs it.

How the editor works: the workflow definition is the editor's only state. Every edit (add a step, delete a step, change a field) is a pure function in `src/lib/graph.ts` that turns one draft into the next. React Flow only draws the result: `toFlow()` turns the draft into nodes and edges, and `layout()` places each step one row below its deepest parent, with each row centred. Nodes cannot be dragged and edges cannot be drawn by hand, so the picture always matches the definition. The API validates the definition on save, so the editor shows the same error messages as any other client.

- Adding a step after a step that already leads somewhere inserts the new step in between. After a condition, it fills the first free branch (`true`, then `false`), or the branch the user picks.
- Deleting a step with one parent and one child connects the two, keeping the parent's branch label.
- A new step gets an id such as `http_1`, the lowest free number for its type.

Step forms: the engine exports `stepJsonSchemas()`, which turns each step's zod config schema into JSON Schema with `z.toJSONSchema()`. `GET /step-schemas` serves them with the branch labels. `src/SchemaForm.tsx` renders a form from that schema: enums become selects, integers become number inputs, long text fields become text areas, and string maps (HTTP headers, AI labels and fields) become lists of name and value rows. Adding a field to a step's zod schema adds it to the form with no UI change. See [decision 0007](decisions/0007-builder-ui.md).

Test runs: `POST /workflows/:id/test-runs { definition, payload, live }` saves the draft as an unpublished version (or reuses the newest version if the draft is identical, compared with sorted keys because Postgres jsonb reorders them) and starts a run with `runs.test = true`. Unless `live` is set, the worker mocks the steps that reach outside: the HTTP step returns `{ mocked: true, status: 200, body: null, request }` without a request, the email step returns the resolved recipient and subject without sending, and a delay waits at most one second. Templates and secret redaction still run, so the output shows what a real run would send. The console polls `GET /runs/:id` once a second and shows each step's state, branch and output.

Accessibility: every action has a button, and the side panel lists the trigger and every step as buttons, so the whole editor works from the keyboard. Canvas nodes are also focusable (Enter selects, Delete removes) and have names that say where each branch leads. Colours are CSS variables for light and dark mode. The main text pairs (body, muted, links, buttons, node text, the success badge) were measured in the browser at 5:1 contrast or better in both modes. The side panel has a fixed width, so the canvas does not move when the panel content changes.

Tests: `src/lib/graph.test.ts` covers adding, inserting, branching, deleting and the layout. `packages/engine/src/step-schemas.test.ts` checks the JSON Schema shapes the form relies on, and `templates.test.ts` checks that the three starter templates are valid. `api.test.ts` ("builder") covers the schema and template routes, test runs, version reuse and ownership. `apps/worker/src/steps/index.test.ts` ("mock mode") proves mocked steps make no request. `e2e/main-flow.spec.ts` (Playwright) signs up, builds a condition and an HTTP step, test-runs, publishes and runs a live version, and checks the step outline from the keyboard.

Limits: starter templates are offered when creating a workflow, and the seed script (below) publishes them for the demo user.

## Run history and versions

What it does: `#/w/<id>/runs` lists a workflow's latest 50 runs with their state, kind (live run or test run), version and duration, filtered to all, live or test runs. `#/runs/<id>` shows one run: its trigger data, and for every step attempt its state, branch, attempt number, duration, input and output. `#/w/<id>/versions` lists the versions, shows what each one changed against the version before it, and rolls back.

Step input: the worker resolves a step's templates once, runs the step with the result, and stores that result as `step_runs.input` after replacing secret values with `[secret]`. The page shows the address an email went to, not `{{trigger.email}}`. A failed attempt keeps its input too. See [decision 0008](decisions/0008-step-input.md).

Masking: secrets are hidden twice. The worker replaces every value of the owner's secrets before it writes input, output or error text. The API then runs `maskSecrets()` (`apps/api/src/mask.ts`) over trigger data, input and output in `GET /runs` and `GET /runs/:id`: the value under any key that looks like a secret (`password`, `token`, `authorization`, `api_key`, `cookie` and similar) becomes `[secret]`. The second pass covers trigger data, which comes from outside and is never redacted by value.

Versions: every save or test run adds an immutable version, and publishing marks it published. The newest published version is the live one. The versions page hides draft-only versions until "Show drafts" is ticked. The diff (`jsonDiff()` in `apps/web/src/lib/diff.ts`) lists changed paths such as `steps[send].config.to`. It matches steps by id, so adding a step in the middle shows one added step and not a change to every step after it. Other arrays, such as edges, are compared by position. `GET /workflows/:id/versions/:version` returns one version's definition.

Rollback: "Roll back to v1" posts v1's definition to `POST /workflows/:id/versions` with `publish: true`. The result is a new published version, such as v3, so history is never rewritten and the run history still points at the versions that actually ran.

Edge cases: `test` accepts only `true` or `false`. A version number that is not a positive integer gets 400, and another user's workflow gets 404. A null value under a secret key stays null, so an empty field still reads as empty.

Tests: `apps/api/src/mask.test.ts` and `apps/web/src/lib/diff.test.ts` (unit). `apps/worker/src/steps/index.test.ts` checks that the stored input is resolved and redacted, on success and on failure, and `worker.test.ts` checks that the worker saves it. `api.test.ts` covers the `test` filter, masked fields, the version route with its 400 and 404 cases, and a rollback that creates a published v3. `e2e/history.spec.ts` (Playwright) runs a workflow, opens the run with a masked trigger field and its step input, changes the flow, reads the diff and rolls back.

## MCP (apps/api/src/mcp.ts)

What it does: `/mcp` is a Streamable HTTP MCP endpoint. An MCP client (Claude Desktop, an agent, a script) connects with `Authorization: Bearer <token>`, using a token from the console's API tokens page. Each of the token owner's published workflows with a form trigger is a tool named after the workflow slug. Its input schema is the form's fields. Calling it starts a run and returns `{ runId, status: "pending" }` right away. `get_run_status { runId }` returns `{ runId, status, error, finishedAt }`, where status is the run state, or `waiting_approval` while the run waits on an approval step.

Why it's built this way: it uses the official MCP SDK v2 (`@modelcontextprotocol/server`), which is the stable line and supports both the 2026-07-28 protocol and older clients. The endpoint is stateless: every request builds a fresh MCP server with that user's tools, so nothing is stored between requests, a newly published workflow appears on the next request, and a revoked token stops working at once. See [decision 0011](decisions/0011-mcp-sdk-v2.md).

Auth: `McpTokenGuard` hashes the bearer token with SHA-256 and runs one UPDATE that matches the hash, skips revoked tokens and sets `last_used_at`. No match gives 401 with `WWW-Authenticate: Bearer`. The owner's id is passed to the tool handlers, and every query filters on it, so a token only sees its owner's workflows and runs.

Tools: `toolsFromRows()` turns each workflow row into a tool. The input schema is `fieldsSchema()`, the zod schema the hosted form uses, so a tool call and a form submission accept the same input: required fields, email format, length limits and number coercion. Only the latest published version runs, as with the form. `runStatus()` reports `waiting_approval` when the run is waiting and its last step run is a waiting step whose definition type is `approval`. A waiting delay step reports plain `waiting`.

Edge cases: a token that is missing, unknown, malformed or revoked gets 401. A run id that is not a uuid is rejected by the tool's schema. Another user's run and a run that does not exist both return the tool error "run not found". Draft-only workflows, workflows with other triggers and other users' workflows are not listed. Tool names cannot clash with `get_run_status`, because slugs only use a-z, 0-9 and `-`. The route allows 60 requests a minute per IP.

Tests: `apps/api/src/mcp.test.ts` has unit tests for `toolsFromRows` and `runStatus`, and integration tests that drive the endpoint with the official MCP client: missing, unknown and revoked tokens, a raw 2025-era `initialize`, the tool list and `last_used_at`, input validation and run creation, hidden runs of other users, a waiting approval, and the rate limit. `e2e/mcp.spec.ts` (Playwright) creates a token in the console, lists and calls a tool, polls `get_run_status` until the run succeeds, revokes the token and checks the client is refused.

## Track an office request (packages/engine/src/office-request.ts, apps/api/src/public.ts, apps/web/src/OfficeRequests.tsx)

What it does: the home screen offers "Track an office request". "Try an example" opens a Preview only page with the sample reference, the row that would be recorded, the office notification and the employee receipt. "Set up for my office" creates a workflow named Office requests and walks through four steps: name, fields staff fill in, where alerts go, and review. Each Next or "Save and finish later" saves the step and the answers, so the owner resumes on the same step from "Draft: continue setup" on the home screen. "Turn on" publishes the definition built from the answers: a form trigger and two email steps (notify the office, send the receipt). The page then shows Accepting requests, the form link with Copy form link and Open form, and the request list. Each row has the reference, subject, time received, where it was recorded and whether the emails went out. "Details" opens the run in the existing run history.

Why this way: the preview is worked out in the browser with the same template resolver the worker uses, so it cannot record or send anything. Setup progress is one jsonb column on the workflow, and turning on goes through the normal versions route, so versions, run history and the advanced editor keep working. The template has no AI step, so it works with AI turned off. See [decision 0019](decisions/0019-office-request-records.md).

Edge cases:

- Double-click or retry: the form page carries a fresh submission key. The API looks the key up, then saves the run and the request in one transaction. `unique (workflow_id, submission_key)` stops a second row even when two posts arrive together, and a repeated post gets the first reference back. Reloading the form makes a new key, so a second request with the same wording gets its own reference.
- A missing or malformed key gets a 400 asking the sender to reload the form.
- A failed notification leaves the request in the list, marked "Not sent, open details" with a link to the run.
- On localhost the page says the form link only works on this computer.
- An MCP tool call to an office request workflow also records a request, and returns its reference with the run id. Each call counts as a new submission.

Tests: `packages/engine/src/office-request.test.ts` (valid definition without AI, preview contents, answer validation), `apps/api/src/office-request.test.ts` (setup saving and owner checks, one request per key, concurrent duplicates, separate references, request list scoped to the owner), `e2e/office-request.spec.ts` (preview, leave and resume the draft, turn on, double-click Send, one row, one receipt, no sample mail).

## Business profile and Gmail sender (packages/db/src/mail-senders.ts, apps/api/src/email-settings.ts, apps/web/src/BusinessSetup.tsx)

What it does: Business and email in the console header holds the owner's business details (name, website, inbox for new inquiries, reply address) and their email sender. With no sender connected, mail goes through the installation's server, which is Mailpit on a local install. Connect Gmail asks for the Gmail address and a Google app password, links to Google's instructions and says that 2-Step Verification is required. Send a test email to me sends one message to the owner and shows the sender and reply address, and says that "accepted" is not "delivered". The first test to a new Gmail address carries a one-time link. The owner opens it while signed in, and only then do their automations send from that address. Replace password, Disconnect and "Use the local mail server instead" cover the rest.

Every send for an owner goes through `resolveSender()`: email steps, approval mail and the test email. It returns the installation server (no sender row), the owner's Gmail login (a confirmed, working sender) or a block with the reason. A blocked send fails the step without a retry and without contacting any server. The From name is the business name and Reply-To is the reply address, for either sender.

Why this way: one function decides the sender, so no path can send as another owner or fall back to a different address. App passwords need no Google Cloud project or OAuth review, which suits a client connecting their own mailbox. See [decision 0020](decisions/0020-owner-mail-senders.md).

Edge cases:

- The app password is encrypted with the owner's id bound in, never returned by the API, and deleted on Disconnect. Google's spaces are stripped, and a 16-letter check catches someone typing their Gmail password.
- Gmail rejecting the login (535) marks the sender failed. Runs fail with "Gmail rejected the app password. Reconnect Gmail" until a new password is saved or a test goes through.
- Disconnecting blocks that owner's mail, including runs already waiting to send. Other owners are not affected.
- The confirmation link is single use, expires after 30 minutes, is stored as a hash, and only works for the signed-in owner it was sent to. A newer test replaces it. Test emails are limited to 5 a minute per owner.
- A changed Gmail address needs a new confirmation. A new password for the same confirmed address does not.
- Business names with braces or line breaks are refused, so a name cannot become a template placeholder or a mail header.

Tests: `packages/db/src/mail-senders.test.ts` (sender states, encryption bound to the owner, two owners, disconnect, the link's single use, owner check and expiry), `packages/db/src/mail.test.ts` (Gmail login as the owner, no server contacted for a blocked sender, a 535 marks the sender failed), `apps/worker/src/steps/senders.test.ts` (two owners each send as themselves, approval mail, disconnecting one), `apps/api/src/email-settings.test.ts` (routes, validation, the link across owners, rate limit). These use a fake SMTP server (`test/fake-smtp.ts`) and never contact Google. The live check is a manual list in [live Gmail check](live-gmail-check.md), not run yet.

## Reply to a website inquiry (packages/engine/src/website-inquiry.ts, apps/web/src/BusinessSetup.tsx, apps/api/src/public.ts)

What it does: once a business name and inquiry inbox are saved, the same page shows who replies are sent from, where answers go and where inquiries go, then offers Turn on inquiry replies. That publishes a "Website inquiries" workflow: a form (name, email, message), a thank-you reply to the customer and a notification to the inquiry inbox. No AI step. After that the page shows Copy inquiry form link, Open form and View activity, and explains how to point a website's Contact button at the link. The hosted form page shows the business name as its heading.

Why this way: the definition is built from the profile and published through the normal versions route, as the office request is, so the advanced editor and run history work unchanged. Turning it on again after editing the profile publishes a new version.

Edge cases: saving a website address connects nothing, and the page says so. An existing form on the client's website keeps working on its own; forwarding its entries needs a developer. While a connected Gmail sender is not confirmed or working, the page warns that customer replies will not be sent. On localhost the page says the link only works on this computer.

Tests: `packages/engine/src/website-inquiry.test.ts` (definition without AI, profile and Gmail input validation), `apps/api/src/email-settings.test.ts` (the form page names the business, escaped), `e2e/business-setup.spec.ts` (save details, connect and disconnect Gmail without sending, test email to the local server, turn on, submit as a customer, the reply and the notification arrive).

## Google Sheets and Slack (packages/db/src/providers.ts, connections.ts, deliveries.ts, apps/api/src/connections.ts, apps/web/src/Connections.tsx)

What it does: Business and email has a Connections section. Google Sheets takes a service account key file, a sheet link and a tab name; the page shows which email to share the sheet with. Daloy reads the sheet to check access and the tab before saving, and Add a test row writes one visible row. Slack takes a bot token from the owner's own Slack app, then Pick a channel lists the public channels and warns when the app is not in the chosen one. Send a test message posts once. Each connection has Disconnect. In the office request setup, "Where requests and alerts go" offers "A row in your Google Sheet" and "A short note in your Slack channel". The row is the reference, the time, the name, email, subject and any extra fields. The note is the reference and subject only, since everyone in the channel can read it. The editor also offers both as steps ("Add to Google Sheets", "Post to Slack") for any workflow.

The steps do not call the providers. Each one stores a delivery (one per run and step) and succeeds, and the worker delivers it within a couple of seconds. The Requests list shows each delivery on its own: "Sheet row: added ('Requests'!A7:F7)", "Slack note: posted", or the reason it failed, with Retry. A Slack note that may already be in the channel shows Mark as posted and Post again.

Why this way: runs are sequential, so as ordinary steps a sheet failure would stop the Slack note and there would be no way to retry one of them. A delivery row has its own attempts, backoff and state, so Sheets and Slack fail, wait and retry independently, and retrying one never re-runs the workflow or sends a second receipt. A service account and a bot token work on any self-hosted installation without registering OAuth clients. See [decision 0021](decisions/0021-sheets-slack-deliveries.md).

Edge cases:

- Expired access: a Google 401 drops the cached token and gets one new one before failing. A Google key that was deleted or disabled, or a revoked or expired Slack token, marks the connection "Needs reconnecting"; later deliveries fail at once without calling the provider, and Retry works after reconnecting.
- Permission denied: an unshared or missing sheet fails the delivery with "Share the sheet with <service account> as an Editor". A Slack app outside the channel fails with "Type /invite ...". The connection stays active, and nothing retries until someone fixes it and selects Retry.
- Quotas and outages: 429, 5xx on reads, and unreachable hosts are retried with backoff, up to 5 attempts, waiting at least as long as Slack's `Retry-After`.
- A write that timed out or broke off may have reached the provider. For Sheets the next attempt reads column A and counts the reference as delivered if it is there ("found in the sheet, not written twice"). Slack cannot be checked without reading the channel, so the delivery waits for the operator; Post again asks for confirmation first.
- A worker that dies mid-call leaves the delivery "sending". Two minutes later another worker takes it and treats it as uncertain, as above.
- Double-clicking Retry queues once; another owner's delivery answers 404.
- Form text is written with `valueInputOption=RAW`, so `=IMPORTXML(...)` in a request stays text and never runs as a formula. Secrets in templates are sent as `[secret]`.
- Turning on an automation that uses Sheets or Slack is refused until the connection works and has a sheet or channel. Test runs and the preview show the row and note without queueing anything.
- Disconnect deletes the credential. Queued deliveries then fail with "not connected" and keep their content for Retry.

Tests: `packages/db/src/deliveries.test.ts` (one row per step, retry Slack alone after the sheet succeeded, reconcile after a timed-out write that did or did not arrive, Slack held for review, Mark as posted and Post again, token refresh, revoked key without touching another owner, unshared sheet, `Retry-After` and the last attempt, revoked Slack token, disconnect and Retry, double-click Retry, one claim per worker, a dead worker's claim), `apps/worker/src/steps/deliveries.test.ts` (a run finishes while Slack fails, the row starts with the reference, secrets redacted, retry posts once, test runs queue nothing), `apps/api/src/connections.test.ts` (connect, key never returned or stored in the clear, wrong key file, unshared sheet, missing tab, channel picker, test row and message, disconnect, turn-on refused without Slack, deliveries in the request list, owner-only Retry), `packages/engine/src/office-request.test.ts` (steps only when chosen, no name or email in the note, preview), `e2e/connections.spec.ts` (connect both, test each, turn on, Slack fails and the sheet row still goes in, Retry posts the note once). These use `test/fake-providers.ts` and never contact Google or Slack. The live check is a manual list in [live Sheets and Slack check](live-sheets-slack-check.md), not run yet.

## Office teams and named approvals (packages/db/src/members.ts, apps/api/src/members.ts, apps/api/src/auth.ts, apps/web/src/Team.tsx)

What it does: an office has one owner and any number of operators, approvers and requesters. The owner invites people from the Team page, changes their roles and removes them. Approvals can name a member, and only that member can answer.

How it works: a workspace is identified by its owner's user id, so every older `user_id` column already names the workspace. `workspace_members` holds one row per account (primary key `user_id`), and a check constraint keeps the owner row as the one where workspace and user are the same. `sessionUser()` loads the session with the user's workspace and role, and an account with no membership counts as signed out. Each route says which roles it allows with `Allow(MANAGE | OPERATE | ANY_MEMBER)`: the owner manages everything, operators see automations, runs and requests and retry deliveries, approvers answer approvals named to them, and approvers and requesters see My requests, the requests they sent through a form while signed in. Invites are one-time links (only the SHA-256 stored, seven days) that create the account or add an account that is in no workspace, in one transaction with the invite. Removing a member deletes their sessions. A named approval is checked three times: publishing refuses an approver who can't approve, the worker checks again before it sends the link, and `recordDecision` checks inside the UPDATE that uses the link, which is the check that counts. The step output then holds `decidedBy` and `decidedAt`, and the run page shows "Decided by ... at ...".

Upgrade: migration 0009 makes every existing account the owner of its own workspace. Approval links sent before it have no approver and keep working once for whoever holds them.

Edge cases: a forwarded link, an answer from another workspace, a removed or demoted approver, a repeated answer, an expired link and two answers at the same moment all record nothing. The owner can't be demoted or removed, and nobody can be invited as owner. Accepting an invite with an email that already belongs to a workspace is refused and leaves the invite usable.

Tests: `packages/db/src/members.test.ts` (constraints, invites, role changes, removal), `packages/db/src/approvals.test.ts` (named approver, removed, demoted, moved, other workspace, expired, concurrent answers, old links), `apps/api/src/members.test.ts` (every route against every role, invites, removal, workspace isolation, publishing checks, My requests), `apps/api/src/approvals-named.test.ts` (the pages a signed-out visitor, a colleague, another workspace and the approver see), `apps/api/src/upgrade.test.ts` (an owner and an approval link from before migration 0009) and `e2e/team.spec.ts` (invite, join, a named approval the owner and a signed-out visitor can't answer, the approver signs in from the link and approves, the run shows who decided).

## Seed and demo login (apps/api/src/seed.ts)

What it does: `pnpm seed` (or `SEED_URL=... pnpm seed`) signs up `demo@daloy.local` with the password `daloy-demo-2026`, creates the three starter templates as published workflows, and starts five mocked test runs with realistic trigger data (two inquiries, one unpaid invoice, one no-show and one attended booking). The worker runs them like any other test run. It also turns on an Office requests automation with no requests, saves a business profile for "Daloy Demo Office" and turns on Website inquiries. The demo owner connects no Gmail account, so their mail goes through the installation server (Mailpit locally). The seed sends no form submissions, because those send live email.

Why this way: the seed talks to the running API over HTTP instead of writing rows. Sign-up, validation, publishing and trigger setup go through the same code as the console, and the seed works with the DML-only database role.

Edge cases: running it twice is safe. A second run signs in instead of signing up and skips workflows whose slug exists. Mocked test runs cap a delay at one second, so the invoice run's one-week wait passes at once and all five runs succeed.

Tests: `apps/api/src/seed.test.ts` seeds twice against the real API and checks one demo user, five published workflows, five mocked test runs, no office requests, the business profile and that the demo owner's sender is the installation server. `e2e/demo.spec.ts` seeds the e2e stack, signs in with the demo login in Chromium and waits for the inquiry runs to succeed.

## Database roles (docker/app-role.sql, apps/worker/src/migrate.ts)

What it does: in compose, the API and the worker connect as `daloy_app`, which can read and write rows but cannot create, alter, drop or truncate anything. A one-shot `migrate` service runs first as the owner role: Drizzle migrations, the pg-boss install and its queues. The api and worker wait for it and start with `MIGRATE_ON_BOOT=false`.

Why this way: a SQL injection bug or a leaked connection string in the apps then cannot change the schema. Default privileges give `daloy_app` access to tables the owner creates later, so a new migration needs no extra grant (decision 0013).

Edge cases: the Postgres init script only runs when the volume is created, so an older volume needs `docker compose down -v` or the SQL run by hand. Outside compose (tests, `pnpm e2e`, local dev) the apps still migrate on boot.

Tests: `apps/worker/src/app-role.test.ts` applies the SQL to an embedded Postgres and checks, as `daloy_app`, that inserts, updates and deletes work, that CREATE, DROP, ALTER and TRUNCATE are refused (in `public` and `pgboss`), and that a worker with pg-boss runs a workflow to the end.

## Reliability tests (apps/worker/reliability)

What it does: two scripts start an embedded Postgres, a test receiver and real worker processes. The load test (`pnpm reliability:load`) also starts the API and has k6 send 1,000 webhook calls. The chaos test (`pnpm reliability:chaos`) creates 200 runs and kills the worker with SIGKILL ten times while it works, starting a new one after each kill. Both use a five-step workflow: HTTP call, condition, HTTP call, one-second delay, HTTP call. Results are in [reliability.md](reliability.md).

Why this way: the checks look at the database and the receiver, not at log output. Every run must succeed. Every run and step pair must have exactly one succeeded attempt. The set of idempotency keys the receiver executed must equal the set of keys of succeeded HTTP attempts, so a lost step, a doubled step or a side effect from an attempt the engine does not count all fail the test. The receiver honours Idempotency-Key like a real payment API: a repeated key gets the stored reply, and the report counts those redeliveries separately (decision 0012).

Edge cases: the worker scripts use a copy of the production worker whose SSRF guard allows the receiver's loopback port; nothing else differs. k6 sends from 40 loopback addresses so the real webhook rate limit (60 a minute per IP) stays on. The scripts only kill processes they started, by PID.
