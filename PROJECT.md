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

## Business automation roadmap phases

From [docs/business-automation-roadmap.md](docs/business-automation-roadmap.md). One session per phase. Resume at the first unticked phase.

- [x] 1. Guided local request demo: "Track an office request" with Preview only, saved setup steps, Turn on, form link and a request list. Migration `0006_office_requests` (`workflows.setup`, `requests` with a unique submission key). Passed: lint, typecheck, unit and API tests, all Playwright tests including `e2e/office-request.spec.ts` (preview sends nothing, double-click gives one request and one receipt). See [decision 0019](docs/decisions/0019-office-request-records.md). Not built yet: claim, mark done and reopen, pause, guided editing of a live automation, Activity search.
- [x] 2. Client profile, Gmail and website handoff: Business and email page (profile, Connect Gmail with an app password, test email with a one-time confirmation link, Replace password, Disconnect, use the local server), every email and approval step sends as its owner through `resolveSender()` with no fallback, and Reply to a website inquiry with a hosted form that names the business. Migration `0007_client_profile` (`business_profiles`, `mail_senders`). Passed: lint, typecheck, 397 unit and API tests, 10 Playwright tests including `e2e/business-setup.spec.ts`, Semgrep, gitleaks, `pnpm audit --audit-level high`, and a clean `docker compose up` in a throwaway project (migrations 0000 to 0007 applied, seed run twice, one inquiry gave the reply and the notification in Mailpit). Two owners send as themselves and disconnecting one leaves the other working (`apps/worker/src/steps/senders.test.ts`, fake SMTP). The seeded demo sends through Mailpit. See [decision 0020](docs/decisions/0020-owner-mail-senders.md). Outstanding: the manual [live Gmail check](docs/live-gmail-check.md). Not built yet: Google OAuth, retrying only a failed email after reconnecting.
- [x] 3. Sheets and Slack: Business and email, Connections (Google Sheets with a service account key, sheet and tab, Add a test row; Slack with a bot token, channel picker, Send a test message; Disconnect), `sheets` and `slack` steps, optional in the office request template, that queue one delivery per run and step. The worker delivers each one apart from the run, so Slack is retried alone after the sheet row went in. Expired tokens refresh once, revoked credentials mark the connection failed, permission errors fail without retrying, quotas back off (honouring `Retry-After`), and a write that may have arrived is reconciled by reference in the sheet or held for review in Slack. The Requests list shows each delivery with Retry, Mark as posted and Post again. Turning on is refused until the connection works. Migration `0008_connections_deliveries` (`connections`, `deliveries`). See [decision 0021](docs/decisions/0021-sheets-slack-deliveries.md). Passed: lint, typecheck, 423 unit and API tests, 11 Playwright tests including `e2e/connections.spec.ts` (Slack fails, the sheet row still goes in, Retry posts the note once), Semgrep, gitleaks, `pnpm audit --audit-level high`, and a clean `docker compose up` in a throwaway project (migrations 0000 to 0008 applied, seed run twice, one office request gave the receipt and the notification in Mailpit). All provider tests use `test/fake-providers.ts`. Outstanding: the manual [live Sheets and Slack check](docs/live-sheets-slack-check.md). Not built yet: Google and Slack OAuth, private channels, more than one sheet or channel per account.
- [x] 4. Office teams and named approvals: owner, operator, approver and requester roles on every console route (`Allow(...)`), a Team page with one-time invite links, role changes and removal (which signs the member out), My requests for approvers and requesters, and approval steps that name an approver. Only that member, signed in and still in the workspace with a role that may approve, can answer: the check sits in the UPDATE that uses the link. Who decided and when is stored and shown on the run. Migration `0009_workspace_members` (`workspace_members`, `invites`, `approvals.approver_id`, `decided_by`, `requests.requested_by`) makes every existing account the owner of its workspace and keeps links sent before it working once. See [decision 0022](docs/decisions/0022-workspace-members-named-approvals.md). Passed: lint, typecheck, 465 unit and API tests, 12 Playwright tests including `e2e/team.spec.ts`. Not built yet: emailed invites, one account in several workspaces, per-token roles for API and MCP.
- [x] 5. Microsoft offices and pilot templates: Outlook (Microsoft consent with PKCE against the installation's Entra app, Graph `sendMail`, the administrator requirement and link shown before leaving Daloy, outcomes for administrator-required, declined, expired and failed consent, Send a test email to the mailbox itself, Reconnect, Disconnect) and Teams (a Teams Workflows link limited to Microsoft hosts, Send a test message, Replace link, Disconnect), both as `outlook` and `teams` deliveries with the phase 3 retry, quota and review rules. Purchase request with a named approver: guided setup (approver, purchasing, optional Outlook and Teams), the form records a request with a reference, the approver decides signed in, approved requests go to purchasing and the Teams channel, and the Requests list shows each delivery. Migration `0010_microsoft_connections` (widens the provider checks). See [decision 0023](docs/decisions/0023-outlook-teams.md). Passed: lint, typecheck, 489 unit and API tests, 13 Playwright tests including `e2e/purchase-request.spec.ts`. All Microsoft tests use `test/fake-providers.ts`. Outstanding: the manual [live Microsoft check](docs/live-microsoft-check.md), since no Microsoft account was available. Not built yet: sending the approval request itself from Outlook, more than one mailbox or channel per account, Teams delivery confirmation beyond "accepted".

- [x] QA fixes from the independent review of be07b99: approval decisions survive worker recovery and wake the run when answered before parking, JSON request bodies resolved value by value, no body on a cross-origin 307 or 308, Sheets reconciles by the exact row, honeypot renamed to `_website`, MCP tracks purchase requests, request list and live-test labels no longer claim delivery. The shared installation mail relay finding was then closed: only operator-approved accounts may use the shared server, with a daily recipient limit (decision 0024, migration 0011).
- [x] Security regression fixes from the fec03cc review: one approval decision per step across retries with the first deadline kept (decision 0009), stored previews and read-time redaction with retired secrets, secrets only in HTTP steps with fixed destinations, JSON body templates checked at save and run (decision 0025), duplicate-refusing Sheets writes with Google developer metadata markers, pinned delivery destinations and review for legacy rows (decision 0021, migration 0012), production default for the shared mail policy (decision 0024), and honest request labels (ecb5ade). Follow-ups from Astra's retests: secret rotation and deletion serialised per name, and marker deletes scoped to our own marker (6e603de); history redaction reads current and retired secrets in one snapshot (6e13e32); Sheets markers of deliveries with an uncertain attempt are never deleted, others after 24 hours, so a delivery lands at most once while its marker exists, not unconditional exactly-once (55dbb88, migration 0013, decision 0021). 55dbb88 passed lint, typecheck, 543 unit and API tests and 13 Playwright tests but awaits Astra's independent retest. External beta stays on hold. Retest handoff: [docs/retest-security-fec03cc.md](docs/retest-security-fec03cc.md).

## Eight-workflow business acceptance phases

From the eight-workflow report (`C:\Users\jbbal\Downloads\Daloy_Eight_Workflows_fec03cc.md`, outside the repo; the QA-01 to QA-08 workflows are saved unpublished in the demo@daloy.local workspace and must be preserved). QA-01 to QA-08 are the acceptance tests. One commit per phase, and each phase is approved separately. Resume at the first unticked phase.

- [x] P1. Scenario acceptance harness: fixtures in `test/scenarios/`, runner `apps/api/src/scenarios.test.ts`, 87 cases on a disposable database with the real executor. A known gap asserts today's exact wrong outcome and names its phase (decision 0026). At P1: 43 cases hold, 44 confirmed gaps (P2 15, P3 12, P4 3, P5 4, P6a 6, P6b 3, P7 1). Retest handoff: [docs/retest-eight-workflows.md](docs/retest-eight-workflows.md).
- [x] P2. Input validation and boundaries: `parsePayload` checks the hosted form, webhooks with `fields`, test runs, the console Run button and MCP; number `min`, `max`, `integer`, plain decimal text only; a numeric comparison on a missing or non-number value takes the optional `invalid` branch, else fails the step with the values in the error (decision 0027). Every refusal names the field. All 15 P2 gaps flipped; the harness has 94 cases, 65 holding and 29 gaps. No migration. Compatibility: all 47 development versions parse unchanged; their 19 numeric conditions now fail or go `invalid` on bad data instead of `false`.
- [x] P3. Test controls: test-run `mode` (mock, ai, live; `live: true` still works) and per-step `choices` (classify label, approval decision including timeout, retryable or permanent failure on outside steps), refused with a named 400 when they do not fit or the run is live. Mock and AI-only runs send nothing and store no approval, delivery or request; faked retries wait at most 1 s. Migration 0014 (`runs.ai_live`, `runs.test_choices`, additive), decision 0028. Builder "Test calls" picker and "Test outcomes" list. Build with AI is told never to add dry-run branches. Harness: 99 cases, 82 hold, 17 gaps. Choices for booking steps and "unknown" outcomes come with P6b and P5.
- [x] P4. Business event keys: webhook `eventKey` (template) or the caller's `Idempotency-Key`, MCP `idempotencyKey` (office and purchase request tools reuse the submission key). `run_keys` primary key (workflow, test, key) inserted in the run's transaction; a duplicate gets the first run with `duplicate: true`, 20 concurrent copies give one run, an empty key is a 400. Applies to webhooks, the console Run button, test runs (own scope) and MCP. Migration 0015 (new table only), decision 0029. The webhook settings no longer drop other config when the signing secret is edited. Harness: 103 cases, 89 hold, 14 gaps (P5 4, P6a 6, P6b 3, P7 1).
- [x] Fix from Astra's review of c05fa81 (before P5): a stale Sheets worker could record its late answer against a newer attempt, because the completion guard used the attempt number and Retry or Post again reset it. Each claim now gets a new random `claim_id` (migration 0016); outcomes and first-send pinning are written only under the current claim (decision 0021). Regression tests hold answers with the fake provider: late success after Post again to another sheet, late refusal after Retry, take-over, unique claim ids, concurrent workers.
- [x] Second fix from that review: a repeated keyed builder test answered with the new draft's version and no mode, so the editor showed an earlier Live run as if it were the Mock test just asked for. The duplicate answer now carries the earlier run's version and mode, and the builder says the event already ran.
- [x] Fixes from Astra's review of 8e2c5d8: a worker that lost its claim while pinning a first destination still sent to the former sheet; it now stops before sending. A late authentication refusal for a replaced credential marked the working replacement failed; connection status changes are now scoped to the credential revision (its IV). No migration. Regression tests pause the worker with database locks and hold the token refusal.
- [x] Fix from Astra's review of 283fa1a: a late Outlook token refresh overwrote the credential saved by Reconnect, and a passing Outlook self-test left "last tested" empty because the token rotated during the test. Rotated credentials are now saved only over the revision they came from, and the send or test follows its own rotation (`rotateInto`). No migration.
- [x] P5. Safe retries and recovery: a stable `Idempotency-Key` per step (a hint only); HTTP outcome classes not_sent, rejected, throttled and unknown; a step flag `idempotent` (default false for POST and PATCH). An unknown outcome on a non-idempotent step parks the run in `needs_review` for "It went through", "Send again" or "Stop", one guarded update each. Operators can retry a dead-lettered run. The reliability tests count keys per attempt (decision 0012) and change with the key. Done: `not_sent` only before the socket opened for request bytes (connect, or the TLS handshake); email `unknown` after the first read of the message, which nodemailer does only after 354. Every attempt has a `claim_id`, and an email or unsafe HTTP attempt gets `dispatched_at` first, so a takeover parks it instead of resending and a stale worker cannot overwrite a takeover or an operator's answer. Retry-After is never shortened; over an hour dead-letters. Console panel, runs filter and badge, `POST /runs/:id/resolve` and `/retry`, MCP `resolve_run`, test choice `{fail: "unknown"}`. Migration 0017 (additive), decision 0030. Harness: 123 tests, 113 cases, 103 hold, 10 gaps (P6a 6, P6b 3, P7 1). Chaos run: 200 runs, 10 kills, 600 keys executed, 0 unexpected (steps marked `idempotent: true`, since its receiver deduplicates). Remaining: a crash before an unsafe send also parks (a person checks, nothing is doubled); attempts already running at deploy have no dispatch mark; It went through leaves later templates without the response body; not tested against real SMTP servers or receivers.
- [x] Fixes from Astra's review of b31c4ce (before P6): a 303 answer followed by a throttled receipt GET restarted the order POST (two orders); a POST answered by a redirect is now never resent on its own and parks for review. A worker paused after the dispatch mark sent after an operator's Stop; the mark is now written under the claim right before the send, with the attempt row locked until the request is on its way, and a takeover re-claims only an unmarked attempt. A large 503 body turned the outcome into `rejected`; error statuses are now classified before the body is read. No migration. Harness: 125 tests, 105 hold, 10 gaps.
- [x] Fixes from Astra's review of 6170f4f (before P6): a 307 answered after Stop started a new POST to the redirect target; the send claim is now checked before every request, redirects included. Ten simultaneous email sends held all ten pool connections under their locks and waited for the sender lookup; email now claims only after the sender is resolved, and the worker's pool is 20 for its batch of 10. No migration.
- [x] P6a. Zoned times and resources: a `datetime` field (IANA `timezone`, optional `slotMinutes` from local midnight) checked on the server at every entry point: real date and time, not in a DST gap, not ambiguous on a fall-back night without an offset, in the future, on the grid. Offset input is converted to the field's zone first; the value is stored as local time with its offset. Delay `until` with `offsetSeconds`; a passed time takes the `late` edge or ends the run with "Skipped" in run history. Mocked delays report the real wake-up time. Workspace `resources` (owner adds, renames, archives; members list) and a `resource` field that stores `{ id, name }` from the database. Resources page in the console; the public form renders a select and names the timezone. Migration 0018 (new table only), decision 0031, no dependency. Harness: 128 tests, 118 cases, 114 hold, 4 gaps (P6b 3, P7 1). Remaining: the visual builder has no `late` handle (API, MCP or Build with AI only); resource kinds, opening hours, lead times and conflicts wait for P6b or later; zone data is the runtime's ICU.
- [x] Fixes from Astra's review of ad0173f (before P6b): the hosted form's time input blocked valid slots on grids that do not divide the day (the browser counts steps from 1970); it now steps by whole minutes there. A replayed webhook or Run button event got 400 once its resource was archived or its time had passed; the event key is now looked up before the payload is checked, so a replay gets its first run with `duplicate: true`. A slow first list on the Resources page could hide a resource just added; only the newest answer is used. No migration. Remaining: MCP retries and keys built from declared datetime or resource fields are still checked again.
- [x] Astra's retest of 09ad29f passed all three reproductions; P6b cleared for internal development. Replay coverage stays partial for MCP and for event keys built from padded text, datetime or resource fields: booking workflows should use a stable event id.
- [x] P6b. Booking lifecycle, built to the spec below. Migration 0019 (`bookings` with the `bookings_no_overlap` exclusion constraint on `btree_gist`, `booking_results`, `booking_changes`, `runs.booking_id` and `booking_version`), decision 0032. Booking step with done, taken and not_found; start must be a datetime field and is checked again when booking. Staff Bookings page and `/bookings` API (owner and operator), MCP tools, changes logged per version so repeats answer duplicate and races give one winner. Version checks before every attempt and inside the send claim; superseded runs are marked and stop at their next step. Test bookings (`TEST-`) isolated. Harness: 128 tests, 118 cases, 117 hold, 1 gap (P7). Remaining: idempotent HTTP and Sheets, Slack, Outlook and Teams deliveries have no send lock (a change in the moment before such a send does not stop it); superseded waiting runs keep their job until they wake; reschedule changes the time only.
- [x] Fixes from Astra's retest of 7c73879: a staff reschedule after a desk workflow moved the booking sent the guest's mail to the desk; it now copies the creating run's payload. A takeover during a booking attempt could fail on the stored-result key and never confirm; attempts of one step now take turns on an advisory lock and the second returns the first one's result. A replayed staff change returned the current booking, or 400 once the time had passed; it is now answered from its `booking_changes` row (which stores the booking it left) before any check. No migration. Remaining: change rows from before this fix answer a replay without the booking.
- [x] Fix from Astra's retest of cf85966: staff and MCP reschedule times without an offset were read in the published field's timezone, so after a workflow edit from Manila to New York, 16:00 entered for a Manila booking saved as 05:00 the next day. They are now read in the booking's own timezone, as the Bookings page labels it. No migration.
  - Spec: durable `bookings` (status, version, reference) with an exclusion constraint on active ranges per workspace, test scope and resource. The `booking` step creates, reschedules or cancels with branches done, taken and not_found, one transaction each with a stored result per run step. Runs linked to (booking, version) stop at their next step after a change. Reschedule and cancel only from staff, MCP and HMAC-signed webhooks. A staff reschedule starts one new run that resumes after the booking step, only on the published version with the same booking step, with the new time validated like the field; the old reminder run ends at its next step. Test bookings are isolated from live ones (`test` in every key, `TEST-` references, hidden from staff lists and MCP). A run that fails after create keeps the booking active and flags it for staff.
- [x] P7. Build with AI lint and close-out: `lintDefinition` warnings (approval without rejected or timeout, unrouted classify label, dry-run branches, unguarded numbers, unreachable steps) in the repair round and the editor; every gap case flipped to its wanted outcome; README, how-it-works, threat model and Astra handoff updated. Done: `lintDefinition` in `packages/engine/src/lint.ts` with five rules, used by `POST /ai/draft` (one repair round on warnings, a broken repair keeps the first valid draft, `warnings` in the answer) and listed in the editor under "Check before publishing"; advice only, Save and Publish never wait. The draft prompt asks for all three approval edges and a route for every classify label. The last gap flipped: harness 129 tests, 119 cases, 0 gaps; the saved QA-06 and QA-07 approvals lint with two warnings each. No migration, no dependency, decision 0033. Remaining: heuristics can flag a field truly named `test`; the save API and MCP return no warnings; the repair round is tested against a fake model only. Retest handoff: [docs/retest-eight-workflows.md](docs/retest-eight-workflows.md).
- [x] Fixes from Astra's retest of 1ff9b6d (PARTIAL, internal development may proceed): the test-switch warning now says Mock runs send nothing but a Live run or a real event can still send; the label walk reads the label on either side of a comparison; a comparison with a value from the run (`{{trigger.x}}`) ends the walk without a claim; a threshold counts as a number the way the engine reads it (`"1e3"`). Four regression tests. No migration. A clean `docker compose up --build` under a disposable project name (`daloy-p7check`, remapped host ports, throwaway `SECRETS_KEY`, its own volume, removed afterwards) passed at 80b2dd9: `migrate` exited 0, postgres, mailpit, api and worker healthy, 20 migrations applied (0000 to 0019) with `bookings` and `run_keys` present, `/` answered 200 and a registration returned 201. The development stack and its volume were not touched. Remaining: real-model repair quality is unverified.

Still unverified after these phases: live AI quality and prompt-injection behaviour (P3 makes them repeatable to test).

Also open:

- An MCP caller idempotency key scoped to workspace and workflow.
- Live checks against real Google Sheets (developer metadata behaviour), Slack, Microsoft and Discord; the docs/live-*-check.md files still list them as outstanding.
- A Discord webhook URL is typed directly into one "Client lead triage" version in the development database. Move it into a secret and rotate the webhook if it was ever shared.
- A shared-mail approval revoked while a send is in flight lets that one send finish.
- Secret values deleted before `retired_secrets` existed are unknown to read-time redaction.
- A Teams Workflows link replaced under the same channel name is not seen as a destination change.

## Next phases (revised, 16 November 2026)

Revised after an independent assessment on 16 November 2026 (report kept outside the repo). Direction: Daloy serves Filipino small businesses with a console a no-code owner can run, SMS reminders, Tagalog and an AI helper. The operator supplies the model and SMS keys and customers pay a subscription, so per-account quotas land before any AI or SMS feature. The AI Workflow Doctor moves after quotas and starts with failure explanations. Browser automation is removed: an email-in trigger and an embeddable form cover "my website has a form and no way to connect it". Publishing is split into a locked demo first and real accounts last.

Order: N3, N4, V1, then V2 and W together, N5 with the pilot search P in parallel, then N6 to N11 only as the pilot asks for them.

- [x] N1. Baseline: [docs/baseline-n1.md](docs/baseline-n1.md).
- [x] N2a. Gmail live check and booking reminder check: [docs/live-gmail-check.md](docs/live-gmail-check.md).
- [x] N2b. Queued deliveries stop once the booking changed (Sheets, Slack, Outlook, Teams), including Retry and Post again.
- [ ] N2c. Google Sheets live check, only when a pilot office asks for a sheet. Timebox: half a day.
- [ ] N2d, N2e. Slack, Outlook and Teams live checks: deferred. They stay marked unverified in the README.
- [ ] N3. Release readiness, narrowed to deployment. Set `trust proxy` to the real hop count (rate limits key on `req.ip` and collapse to one bucket behind any proxy). Set `NODE_ENV=production` or a `SECURE_COOKIES` variable in compose (the session cookie is never Secure today). Change the default database passwords. Rate-limit register. Add an outbound HTTP allowlist variable for the demo and stop accounts without AI settings falling back to the operator's `LLM_API_KEY`. Pin images. Write a one-page deployment doc behind Caddy or Cloudflare Tunnel, with a nightly dump to off-machine storage and one restore rehearsed on the target. Exit: a fresh `docker compose up` on the target sets a Secure cookie and rate-limits per real client, checked from two networks. Progress: the settings, register limit, allowlist, shared AI key switch, required passwords, pinned images and `docs/deployment.md` (Cloudflare Tunnel on an owner-run machine) are done (decision 0035, `apps/api/src/deploy.test.ts`). Left: deploy to the target, rehearse the restore there and run the two-network exit check from `docs/deployment.md`.
- [ ] N4. Console for no-code owners (replaces the earlier N4). Reference the Zapier linear editor and the Activepieces builder (MIT), not n8n.
  - [x] N4a. Quick fixes: wizard buttons disabled while saving (fixes the red e2e job), load failures shown with a retry instead of a blank, "taking longer than usual" after 60 seconds, a banner on the review step and the live page when no real sender is connected, confirmations on Run live version, Publish, Disconnect and Send again.
  - [x] N4b. Navigation: Home becomes Automations, each with a plain state (Done, Waiting, Needs you, Problem), its last result, Copy form link and Activity. API tokens, AI model, Versions, Resources, the graph editor, the template picker and Build with AI move behind Advanced. Raw states, step ids, tokens and JSON move behind "Details for a technician". Mobile pass: toolbar wraps, 44 px targets, the requests table becomes cards under 600 px.
  - [x] N4c. Run animation: on the editor and the run page, nodes and edges take the run's state as it advances, green flowing from the trigger to the latest finished step, red on a failed step, amber on a wait. React Flow animated edges driven by the existing one-second run polling. Honour `prefers-reduced-motion`. Done: `lib/run-flow.ts`, `FlowCanvas.tsx`, "Path it took" on the run page.
  - Exit: someone not coached sets up office requests and finds one request's receipt on a phone in under five minutes; Playwright covers the new Home.
- [ ] V. Visual redesign of the console, after N4c. N4 changed the structure; this phase changes the look only.
  - [x] V1. Design direction: `DESIGN.md` with colour, type, spacing and motion tokens, and mockups of Automations, the editor, the run page and the public landing page, at phone and desktop width. No default AI-looking fonts, no scramble or springy hover effects. Exit: one direction is approved before any console code changes.
  - [ ] V2. Apply the tokens to the console, following "Notes for V2" in `DESIGN.md`: styles, the two fonts, and one small scroll-reveal script (`reveal.ts`, agreed in the V1 review). No markup, route, copy or API changes. Exit: the Playwright suite passes unchanged, text contrast meets WCAG AA and `prefers-reduced-motion` turns off every animation. The N4 exit check runs once after this, on the final look.
- [ ] W. Public website: one static page in the repo built from `docs/design/landing.html`, following "Notes for W" in `DESIGN.md`. Daloy is sold as a managed subscription (decided 17 November 2026), so the page has what Daloy does, its limits, a Pricing section, a "What is planned" list and the demo link (once N5 is up), with GitHub only in the footer and no self-hosting section. No sales copy, no tracking. Before publishing, every Pricing line must be true of the deployed service (N3 and N6 are not finished) and the placeholder contact address replaced. Hosted free on GitHub Pages or Cloudflare Pages, and it opens locally as a file. It carries the "what the demo does not do" page N5 asks for. Can run alongside V2.
- [ ] N5. Locked public demo (was the first half of N6): per-visitor sandbox or a locked demo account that cannot create tokens, invite members, save secrets or run live, a scheduled reset, and a public page that says what the demo does not do. Exit: a script proves each denial.
- [ ] P. Pilot search, in parallel from N5: five conversations with real offices or clinics, the demo shown on their phone, one pilot running one automation for 14 days with 20 real submissions and a payment or a written yes to a price. Stop/go on day 30: go means N6 onward; no pilot means freeze features and keep Daloy as a portfolio project with the demo up.
- [ ] N6. Quotas and metering: per-workspace limits for AI calls, SMS, outbound HTTP and cron frequency, usage visible to the owner, manual GCash or Maya invoicing written down. Lands before N7 and N10.
- [ ] N7. SMS confirmations and reminders through a Philippine gateway (Semaphore or similar), as a delivery with needs_review on an unknown outcome. Record sender-ID registration and per-message cost; the cost is passed through in the subscription. Exit: confirmations and reminders arrive on a real phone, none for a cancelled booking.
- [ ] N8. Tagalog: string tables for the console and emails, Taglish copy, the owner picks the language.
- [ ] N9. Email-in trigger (IMAP) and an embeddable form snippet. Covers Wix, WordPress, Shopify and home-made forms without an integration.
- [ ] N10. AI helper (Workflow Doctor), after N6.
  - [ ] N10a. Explain failures from run records, provider error kinds and lint rules in plain language: fixed rules first, then DeepSeek through OpenRouter for the wording. Only structured error data goes to the model, never form text or booking details.
  - [ ] N10b. Setup chat that answers "what happened to request X" and guides setup. Measured on twenty real failure explanations in English and Tagalog before it is on by default. A suggestion never approves a run.
  - Voice through the browser's Web Speech API and an avatar only if a user asks.
- [ ] N11. Real accounts: final security review at the release commit covering N6 to N10, a daily recipient cap on Gmail and Outlook receipts, a timestamp in the webhook signature, MCP token scopes and expiry, password change and reset, per-workflow pause and cancel of a pending run, read-side secret redaction on every surface, a purge policy for retired secrets.

Hygiene, any time (done 16 November 2026): add a LICENSE (MIT), the README "How AI was used" section CLAUDE.md asks for, and fix by hand the four statements in docs/how-it-works.md that the code contradicts (steps never reach `skipped`, the table has 85 cases not 72, `failed` can go back to `running`, not every change goes through `assertTransition`).

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
