# 0003: Embedded Postgres for local tests

## Context

The worker tests need a real Postgres: pg-boss, leases and guarded updates all depend on Postgres behaviour. The development machine has no Docker, and installing Docker or Postgres needs admin rights.

## Options

1. Require Docker for every test run.
2. PGlite (Postgres compiled to WebAssembly). It runs in process, but pg-boss expects a normal network connection and PGlite serves one client at a time.
3. embedded-postgres (MIT). It downloads real Postgres binaries as an npm package and starts them on a local port, with no admin rights.

## Decision

Option 3, pinned to Postgres 17 to match `docker-compose.yml`. The tests use `DATABASE_URL` when it is set (CI sets it to a Postgres service container) and start an embedded server otherwise.

## Consequences

`pnpm test` works on a fresh clone without Docker. The first install adds the Postgres binaries for the platform (about 100 MB unpacked on Windows, 60 MB on Linux). `docker compose up` stays the way to run the full app.
