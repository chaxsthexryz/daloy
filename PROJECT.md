# Daloy

Workflow automation engine with AI steps. A user builds an automation in a visual editor from one trigger and a series of steps. The engine runs it reliably, keeps a history of every run, and can expose published workflows as MCP tools.

Repo name: daloy. Follow CLAUDE.md for working style, tests, CI, security and writing rules. You write all the code, including the engine, the state machine and the security checks. Write tests first for anything non-trivial.

Intended users: small teams that do repetitive multi-step admin work by hand, such as sorting inquiries, chasing unpaid invoices and messaging no-shows.

## Version 1 scope

- Linear flows with branches. No loops, no parallel branches, no sub-workflows.
- Six step types: HTTP request, send email, condition, delay, AI task, human approval.
- One workspace per user. Multi-tenancy is out of scope.
- Google Sheets append is a stretch step. Build it only after every phase below is done.

## Stack

pnpm monorepo.

- packages/engine: pure TypeScript. No framework, no database, no network. All I/O goes through interfaces the worker implements.
- apps/api: NestJS.
- apps/worker: Node.
- apps/web: Vite, React and React Flow.
- Postgres, with Drizzle for application tables and pg-boss for queues. pg-boss keeps its own schema (pgboss). No Redis; record the reason in a decision record.
- packages/llm-ts: the LLM client from the portfolio template. If the repo was not created from the template, write a minimal version with the same interface: generate({ system, messages, schema?, model, temperature, maxTokens, timeoutMs }). Ollama is the default provider. The base URL comes from an env var, so Harang (my LLM gateway) can be put in front later with no code change.
- Mailpit for local email.

## Data model

- users, sessions
- workflows
- workflow_versions: immutable JSON definition, version number, published flag
- triggers
- runs
- step_runs: one row per step attempt
- approvals
- secrets: AES-256-GCM, key from an env var
- api_tokens: stored as SHA-256 hashes

## Engine rules

1. Definition schema, in zod: trigger, steps (id, type, config), edges and branch conditions. Reject cycles and unknown step ids.
2. Run state machine.
   - Run states: pending, running, waiting, succeeded, failed, cancelled.
   - Step states: pending, running, waiting, succeeded, failed, skipped.
   - Only legal transitions are allowed. An illegal transition throws a typed error.
   - Write the transition table as a data file first, then generate the tests from it.
   - Each transition is one database transaction in the worker.
3. Retries: exponential backoff with jitter, a maximum number of attempts per step (default 3), and a dead-letter list for steps that run out of attempts. Only errors marked retryable are retried.
4. At-least-once execution with idempotency. Each step attempt has the key runId:stepId:attempt. The HTTP step sends it as an Idempotency-Key header.
5. Expressions: {{trigger.<path>}} and {{steps.<id>.output.<path>}}. Use a safe evaluator (JSONata or a small resolver of your own) with limits on time and output size. Never use eval or Function. Record the choice in a decision record.
6. Waiting steps (delay, approval) are scheduled jobs. Nothing sleeps inside a worker.

## Worker

- Takes jobs from pg-boss. Shuts down gracefully on SIGTERM.
- Each running run has a lease that a heartbeat renews. After a crash, a restarted worker resumes runs whose lease expired.
- Records token usage for AI steps.

## API

- Console auth: email and password, argon2 hashes, secure session cookies. Record the library choice in a decision record.
- Workflow CRUD, publish (creates a new version), run history, approvals, secrets (write only, masked on read), API tokens.
- Zod validation on every route, rate limits, body size limits.

## Triggers

- Webhook: a random 32-byte URL path, optional HMAC-SHA256 signature check, body size limit.
- Schedule: cron, through pg-boss schedules.
- Hosted form: a public page generated from a field schema, rate limited, with a honeypot field.
- Manual: a button in the console.

## Steps

1. HTTP request. SSRF protection is required:
   - Allow only http and https, on ports 80 and 443 by default.
   - Resolve DNS, then block private, loopback, link-local and cloud metadata ranges (including 169.254.169.254) for IPv4 and IPv6.
   - Connect to the resolved IP, so DNS rebinding cannot swap it.
   - Re-check after every redirect, with a maximum of 3.
   - 1 MB response limit and a 10 second timeout.
   - Secrets are inserted from references, and their values never reach logs.
2. Send email: SMTP from env vars, templated with expressions, with a cap on recipients.
3. Condition: branch on an expression.
4. Delay: from seconds to days.
5. AI task: classify, extract, summarize or draft. Each task declares a JSON output schema and the result is validated. Trigger data is untrusted: put it in a delimited user message, never in the system prompt. Store token counts per step run.
6. Human approval: an email with a signed, expiring, single-use link. The approver sees an approve and reject page. A timeout leads to a configurable path.

## Web UI

- Visual builder on React Flow. Step forms are generated from each step's JSON schema.
- Test run with sample data. External steps are mocked by default, with a toggle for live calls.
- Run history page: input, output and timing for each step, with secrets masked.
- Version history with a JSON diff and rollback. A rollback creates a new published version.
- Three starter templates: inquiry triage, invoice follow-up, booking no-show follow-up.
- Light and dark mode, full keyboard use, WCAG AA contrast, no layout shift.

## MCP exposure

- Use the official MCP TypeScript SDK at its current stable release, with Streamable HTTP. If v2 is still in beta, use v1.x and record why.
- Every published workflow with a form trigger becomes a tool. The tool name comes from the workflow slug and the input schema comes from the form fields.
- Calling a tool starts a run and returns the run id and status. A second tool, get_run_status, returns the state of a run.
- Approval steps still apply. A run that reaches one returns the status waiting_approval.
- Auth is a bearer API token per user for version 1. OAuth is out of scope.

## Reliability tests

Run both and put the real numbers in docs/reliability.md.

- Load test with k6: 1,000 runs of a five-step workflow. Check that every run succeeds and that no step_run is lost or duplicated. Report p50 and p95 run time.
- Chaos test: SIGKILL the worker repeatedly during a 200-run batch, then restart it. All runs must finish. A test receiver counts calls per idempotency key, and each key must have been executed once.

## Threat model entries

SSRF, webhook spoofing, secrets leaking into logs, expression injection, approval link theft and replay, prompt injection through trigger data, MCP tool abuse, oversized payloads.

## Phases

- [x] 0. Scaffold: monorepo, CI, docker compose with Postgres and Mailpit, llm-ts, README skeleton, docs/how-it-works.md, docs/threat-model.md.
- [x] 1. Engine package with tests only: definition schema, state machine, retry policy, expression evaluator.
- [x] 2. Database schema, migrations and the worker.
- [x] 3. API, console auth and triggers.
- [x] 4. Steps: HTTP (with SSRF protection), email, condition, delay.
- [x] 5. Builder UI.
- [x] 6. Run history, versions and rollback.
- [x] 7. AI task step and human approval.
- [x] 8. MCP exposure.
- [x] 9. Load and chaos tests, starter templates, seeded demo, README with screenshots and an architecture diagram.

## Done when

- The k6 and chaos tests pass and docs/reliability.md holds their output.
- A fresh `docker compose up` followed by the seed script gives a working demo with the three templates.
- Every step type has unit tests, and the SSRF tests cover private ranges, redirects and DNS rebinding.
- CI is green.
- docs/how-it-works.md explains the state machine, retries and idempotency in plain language.

## Proposed follow-up: client email and website setup

- Let a business owner or the person setting up their workspace enter the business name, website and inbox for new inquiries. Use those details in the inquiry template and replace its example recipients before activation.
- Let the owner connect Gmail from inside Daloy using their email address and a Google app password. Include a link to create the app password and explain the 2-Step Verification requirement. Keep server settings out of the setup form.
- Encrypt each workspace's credential, keep it out of workflow definitions and run history, and let the owner replace it or disconnect. If the connection fails, pause the send and ask the owner to reconnect. Never switch to another sender.
- Offer a test email to the owner's own inbox. Show the sender, reply address and inquiry destination before the owner turns on customer emails. Keep Mailpit available for the local demo.
- Give the owner a shareable inquiry form link they can put behind their website's contact button. Explain that saving the website address alone does not connect an existing form.
- Acceptance check: from the setup screen, the owner can test Gmail, activate inquiry replies and submit a sample inquiry as a customer. The reply reaches that customer's address and the notification reaches the business inbox, without opening the workflow editor.
