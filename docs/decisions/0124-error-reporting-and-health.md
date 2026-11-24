# 0124: Optional Sentry / GlitchTip error reporting and health check

## Context

A2 of "Platform admin and ops" adds optional error reporting across `api`, `worker`, and `web`, plus an unauthenticated health endpoint for external uptime monitors alongside `docs/deployment.md`.

## Options

1. Add full `@sentry/node` and `@sentry/react` SDK packages across workspaces. Rejected: pulls heavy transitive telemetry trees, auto-instrumentation plugins, and bundle weight for an optional hook, and increases lockfile/Docker image surface.
2. Add a small zero-dependency reporter in `@daloy/engine` speaking Sentry v7's HTTP store protocol (`/api/<project>/store/` with `X-Sentry-Auth`), paired with global 5xx/unhandled exception hooks in `api`, `worker`, and `web`, plus `GET /health`. Chosen.

## Decision

- `packages/engine/src/error-report.ts` exports `parseSentryDsn`, `scrubValue`, and `createErrorReporter` using `fetch` and Web Crypto (`crypto.randomUUID()`), sharing identical code across Node (`api`, `worker`) and browser (`web`).
- When `SENTRY_DSN` (or `VITE_SENTRY_DSN`) is unset or invalid, `capture` is a fast no-op. When set, values are scrubbed (URL query strings/credentials stripped, sensitive object keys redacted), capped at 20 events/minute with a 3s timeout, and transport errors are swallowed silently.
- `apps/api/src/health.ts` adds `GET /health` (`SELECT 1`, returning `200 {"ok":true}` or `503` on failure) and `ErrorReportFilter` (reporting unexpected errors and 5xx HTTP exceptions while passing 4xx answers and `WorkflowPausedError` through untouched).
- `apps/api/src/google.ts` (`consoleHeaders`) adds the `VITE_SENTRY_DSN` origin to `connect-src` when configured.

## Consequences

- Operators can plug in Sentry.io or self-hosted GlitchTip via environment variables without changing app code or risking telemetry crashes.
- Automated run errors stored for customers in `step_runs` remain separate from host-level process/5xx reporting.
