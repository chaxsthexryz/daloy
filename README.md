# Daloy

Daloy is a workflow automation engine with AI steps. You build an automation from one trigger and a series of steps, Daloy runs it, keeps a history of every run, and can expose published workflows as MCP tools.

Status: all ten phases in [PROJECT.md](PROJECT.md) are done. CI (lint, typecheck, tests, end-to-end tests, Semgrep, gitleaks, dependency audit and the compose build) passes on GitHub Actions. `docker compose up` and the seed were checked by hand with Docker Desktop on Windows on 2026-11-13.

## Problem

Small teams do the same multi-step admin work by hand every day: sorting inquiries, chasing unpaid invoices, messaging no-shows. Daloy lets them describe that work once as a workflow and have it run on a webhook, a schedule, a form or a button.

## Screenshots

The workflow list of the seeded demo, the builder with the inquiry triage template, a workflow's run history and one run. They are taken by `e2e/demo.spec.ts` (`SCREENSHOTS=1 pnpm e2e`).

![Workflow list](docs/screenshots/workflows.png)

![Builder](docs/screenshots/editor.png)

![Run history](docs/screenshots/run-history.png)

![One run](docs/screenshots/run.png)

## Architecture

```mermaid
flowchart LR
  web[Web console<br/>Vite, React Flow] --> api[API<br/>NestJS]
  mcp[MCP clients] --> api
  hooks[Webhooks and forms] --> api
  api -->|daloy_app role| pg[(Postgres<br/>app tables and pg-boss queues)]
  worker[Worker] -->|daloy_app role| pg
  migrate[migrate<br/>one-shot, owner role] --> pg
  worker --> engine[engine package<br/>pure TypeScript]
  worker --> llm[llm-ts<br/>Ollama]
  worker --> smtp[SMTP<br/>Mailpit locally]
  worker --> ext[External HTTP APIs<br/>through the SSRF guard]
```

The API validates input, stores workflows and starts runs. The worker takes one job per step from pg-boss, runs the step and queues the run again. [docs/how-it-works.md](docs/how-it-works.md) explains each part.

## Quickstart

Needs Docker. For development and tests: Node 24 and pnpm 10.

```bash
cp .env.example .env   # then set SECRETS_KEY: openssl rand -base64 32
docker compose up -d
docker compose exec api node_modules/.bin/tsx src/seed.ts
```

The console is at http://localhost:3000 (the API serves it). Mailpit's inbox is at http://localhost:8025. Live AI steps need a model: Ollama on the host by default, or any OpenAI-compatible API such as the Gemini API free tier (`LLM_PROVIDER=openai`, see `.env.example`). Mocked test runs need neither. After changing `.env`, run `docker compose up -d worker`.

Without Docker, the e2e stack runs on an embedded Postgres: start it with `node --input-type=module -e "import s from './e2e/global-setup.ts'; await s()"`, seed it with `SEED_URL=http://localhost:3100 pnpm seed`, and open http://localhost:3100.

To work on the console with hot reload, run the API and worker (`pnpm --filter @daloy/api start`, `pnpm --filter @daloy/worker start`) and then `pnpm --filter @daloy/web dev`. Vite serves it on http://localhost:5173 and forwards API routes to port 3000.

## Demo login

After the seed: `demo@daloy.local`, password `daloy-demo-2026`. The account has the three starter templates (inquiry triage, invoice follow-up, booking no-show follow-up) as published workflows, and five mocked test runs in their run history. These are demo credentials for a local install; change or delete the account anywhere else.

## Running tests

```bash
pnpm test        # vitest, all packages. Uses DATABASE_URL if set, otherwise starts an embedded Postgres
pnpm typecheck
pnpm lint
pnpm e2e         # Playwright: builds the console, starts Postgres, the API and the worker, then runs the browser tests in Chromium
pnpm reliability:chaos   # 200 runs, the worker killed with SIGKILL ten times
K6=/path/to/k6 pnpm reliability:load   # 1,000 runs started by k6 through the webhook API
```

The first `pnpm e2e` needs a browser: `pnpm exec playwright install chromium`. The load test needs the [k6](https://github.com/grafana/k6/releases) binary (AGPL-3.0, run as a separate program, not bundled). Results of both reliability tests are in [docs/reliability.md](docs/reliability.md).

CI also runs Semgrep, gitleaks and `pnpm audit` on every push.

## Known limitations

- Version 1 supports linear flows with branches only: no loops, no parallel branches, no sub-workflows.
- One workspace per user.
- AI prompts are tested against a fake model server only. Their accuracy with a real model has not been measured. Delimiting and schema checks limit prompt injection but do not stop a model from choosing a wrong label.
- Anyone who has an unused approval link can approve or reject. The email is the only check on who clicks.
- An approval timeout is picked up by the worker's 15-second sweep, so it can fire up to 15 seconds late.
- Every AI step uses the model in `LLM_MODEL`, from one provider for the whole worker.
- The OpenAI-compatible mode is tested against mocked replies only. It has not been run against the Gemini API or another hosted provider.
- Run history masks fields by key name. A field called `max_tokens` shows as `[secret]`, and a secret sent in trigger data under an ordinary key name stays visible to the workflow owner.
- Run history lists the latest 50 runs per workflow, with no paging.
- The builder lays out steps automatically and nodes cannot be dragged. Steps are added from the side panel, not by drawing edges.
- The console bundle is about 520 kB (160 kB gzipped), mostly React Flow, React and zod.
- Secret redaction is plain text replacement, so a very short secret value also hides unrelated text that matches it.
- The HTTP step ignores proxy environment variables and only calls ports 80 and 443.
- Rate limits are counted per API process, and per IP rather than per token.
- MCP tool calls return as soon as the run is queued. Clients poll `get_run_status` for the result; there are no progress notifications.
- An API token can start every published form workflow of its owner. There are no per-workflow scopes.
- CI only builds the compose images; it does not start the stack. Docker Compose was run by hand once (Docker Desktop on Windows): the `migrate` service exits cleanly, the api and worker connect as `daloy_app`, which cannot create tables, and the seeded demo login works.
- The database role init script only runs when the Postgres volume is created.
- The reliability numbers come from one Windows laptop with one worker process. They show behaviour under load, not capacity.
- The worker advances up to 10 runs at a time. One slow step holds up the rest of its batch until it finishes.

## Dependencies

| Package | Why | License |
| --- | --- | --- |
| zod | Input and definition validation | MIT |
| typescript | Type checking | Apache-2.0 |
| vitest | Test runner | MIT |
| eslint, @eslint/js, typescript-eslint | Linting | MIT |
| @types/node | Node type definitions | MIT |
| drizzle-orm | Typed queries for the application tables | Apache-2.0 |
| drizzle-kit | Generates SQL migrations from the schema | MIT |
| pg, @types/pg | Postgres driver | MIT |
| pg-boss | Job queue on Postgres | MIT |
| tsx | Runs the TypeScript worker without a build step | MIT |
| embedded-postgres | Real Postgres for local tests without Docker | MIT |
| @nestjs/core, @nestjs/common, @nestjs/platform-express | API framework | MIT |
| reflect-metadata, rxjs | Required by NestJS | Apache-2.0, Apache-2.0 |
| @node-rs/argon2 | Password hashing (argon2id) | MIT |
| helmet | Security headers | MIT |
| cookie-parser | Reads the session cookie | MIT |
| supertest | API route tests | MIT |
| nodemailer, @types/nodemailer | SMTP client for the email step | MIT-0, MIT |
| react, react-dom, @types/react, @types/react-dom | Console UI | MIT |
| @xyflow/react | Workflow canvas (React Flow) | MIT |
| vite, @vitejs/plugin-react | Console dev server and build | MIT |
| @playwright/test | End-to-end tests | Apache-2.0 |
| @modelcontextprotocol/server | Official MCP server SDK (v2) | Apache-2.0 |
| @modelcontextprotocol/node | Official adapter from the MCP handler to Node and Express; pulls in hono and @hono/node-server (MIT) | Apache-2.0 |
| @modelcontextprotocol/client | Official MCP client, used by the MCP integration and end-to-end tests | Apache-2.0 |

TypeScript is pinned to 6.0.x because typescript-eslint 8 does not support TypeScript 7 yet.
