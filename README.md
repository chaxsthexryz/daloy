# Daloy

Daloy is a workflow automation engine with AI steps. You build an automation from one trigger and a series of steps, Daloy runs it, keeps a history of every run, and can expose published workflows as MCP tools.

Status: phase 0 (scaffold). See the checklist in [PROJECT.md](PROJECT.md).

## Problem

Small teams do the same multi-step admin work by hand every day: sorting inquiries, chasing unpaid invoices, messaging no-shows. Daloy lets them describe that work once as a workflow and have it run on a webhook, a schedule, a form or a button.

## Screenshots

Added in phase 9.

## Architecture

Planned shape. Parts that do not exist yet are marked with their phase.

```mermaid
flowchart LR
  web[Web console<br/>Vite, React Flow<br/>phase 5] --> api[API<br/>NestJS<br/>phase 3]
  mcp[MCP clients] --> api
  hooks[Webhooks and forms] --> api
  api --> pg[(Postgres<br/>app tables and pg-boss queues)]
  worker[Worker<br/>phase 2] --> pg
  worker --> engine[engine package<br/>pure TypeScript]
  worker --> llm[llm-ts<br/>Ollama]
  worker --> smtp[SMTP<br/>Mailpit locally]
```

## Quickstart

Needs Node 24, pnpm 10 and Docker.

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm test
```

Mailpit's inbox is at http://localhost:8025.

## Demo login

Added with the seed script in phase 9.

## Running tests

```bash
pnpm test        # vitest, all packages
pnpm typecheck
pnpm lint
```

CI also runs Semgrep, gitleaks and `pnpm audit` on every push.

## Known limitations

- Version 1 supports linear flows with branches only: no loops, no parallel branches, no sub-workflows.
- One workspace per user.
- The API, worker and web console do not exist yet.

## Dependencies

| Package | Why | License |
| --- | --- | --- |
| zod | Input and definition validation | MIT |
| typescript | Type checking | Apache-2.0 |
| vitest | Test runner | MIT |
| eslint, @eslint/js, typescript-eslint | Linting | MIT |
| @types/node | Node type definitions | MIT |

TypeScript is pinned to 6.0.x because typescript-eslint 8 does not support TypeScript 7 yet.

## How AI was used

Claude Code wrote the code and docs in this repository. The owner reviews each phase, runs the tests and the app, and checks the results before shipping.
