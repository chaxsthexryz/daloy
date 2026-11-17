# Instructions for coding agents

Claude Code and ChatGPT Codex both work on this repository, sometimes at the same time. This file is the shared space. Claude Code reads `../CLAUDE.md` automatically; Codex reads this file. Both follow both.

## Before you start

1. Read `../CLAUDE.md` (the working rules: plan first and wait for the owner's "go", tests first for non-trivial logic, writing style, security, cost). If you cannot reach it, the short version is below.
2. Read `PROJECT.md`. Pick the phase the owner named. Its model table says which model and effort to use.
3. Check that no other agent has claimed the phase (see Coordination).

Short version of the working rules, if `../CLAUDE.md` is missing:

- One phase at a time. Write a short plan (files, data model changes, risks, open questions) and wait for the owner's "go".
- Tests first for state machines, validators, auth checks, rate limits, quotas and similar logic. Never fake results.
- After the phase: report in five lines or fewer, update `docs/how-it-works.md` and `docs/threat-model.md` where they change, record non-obvious decisions in `docs/decisions/NNNN-title.md`, tick the phase in `PROJECT.md`, one commit.
- Free and open-source only. No paid APIs, no service that needs a credit card. A new dependency needs a one-line reason and its licence.
- Writing: plain, specific sentences. No em dashes or en dashes. No sales copy, no emoji, no inflated words.
- Never add a co-author trailer for any AI tool to commits or PR descriptions.

## Coordination

- Claim a phase before you start: add `(claimed: <claude or codex>, branch <name>)` to the end of its line in `PROJECT.md` and commit that one line on `main`. If the line already has a claim, stop and ask the owner.
- Work in your own git worktree and branch, never in the main checkout: `git worktree add ../daloy-<phase> -b <phase-branch> main`, then `pnpm install --frozen-lockfile` inside it.
- Commit only on your branch. Do not push, do not merge into `main`, do not delete other branches or worktrees. The owner merges.
- Stage files by explicit path. Never `git add -A`.
- Leave `.impeccable/` and other untracked folders you did not create alone.
- `pnpm e2e` uses fixed ports (3100 for the app, 2526 to 2528 for the fakes). Only one e2e run can work at a time across all agents. If the ports are busy, wait and retry; do not change the ports.
- If your phase needs a file another open branch also changes, say so in your report.

## Safety

- The owner's Docker stack on localhost:3000 holds real QA data. Never reset its database, never `docker compose down -v`, never reseed it.
- Never print, log or commit secrets, passwords, API keys or webhook URLs. The owner types credentials themselves.
- No real external requests (email, Slack, Google, Microsoft, AI providers) except live checks the owner runs.
- Use disposable databases, synthetic secrets and the fake providers in `e2e/` for tests.

## Models

`PROJECT.md` lists one model per phase. Claude and Codex equivalents, by role:

| Role | Claude | Codex |
|---|---|---|
| Coordinator, design, security review | Opus 5.5, high | GPT-6 Astra, Extra High |
| Phase lead for hard phases (quotas, security, concurrency) | Opus 5.5, high | GPT-6.1 Sol, High |
| Implementing an approved plan | Sonnet 5.5, medium or high | GPT-6.1 Sol, Medium |
| Docs, copy, mechanical edits, read-only checks | Sonnet 5.5, low or medium | GPT-6.1 Terra |
| High-volume small tasks | Haiku 5.5 | GPT-6 Luna, Light or Medium |

The equivalents are by role and price tier, not measured against each other.
