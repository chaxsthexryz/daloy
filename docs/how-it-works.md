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
