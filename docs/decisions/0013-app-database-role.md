# 0013: A DML-only database role for the API and the worker

## Context

The API and the worker connected as the database owner and ran migrations on boot. A SQL injection bug or a stolen connection string would then allow dropping tables or changing the schema. The threat model lists a least-privilege role for phase 9. Both apps also start pg-boss, which installs and migrates its own schema by default.

## Options

1. Keep migrating on boot, but with a second, owner connection string in each app. The apps would still hold owner credentials.
2. A one-shot `migrate` service that runs as the owner (Drizzle migrations, pg-boss install, queues), and an app role with SELECT, INSERT, UPDATE and DELETE only. The apps start after it and never touch the schema.

## Decision

Option 2. `docker/app-role.sql` creates `daloy_app`, grants it USAGE on the `public` and `pgboss` schemas, DML on existing tables, and the same through default privileges for tables the owner creates later. It also revokes CREATE on `public` from PUBLIC. `docker/postgres-init/10-app-role.sh` runs it when the Postgres volume is first created and sets the password from `APP_DB_PASSWORD`. `apps/worker/src/migrate.ts` is the `migrate` service. The api and worker get `MIGRATE_ON_BOOT=false`, which skips `migrate()` and starts pg-boss with `migrate: false`.

Outside compose (`pnpm e2e`, local dev, tests) `MIGRATE_ON_BOOT` defaults to true and the apps migrate as before.

`apps/worker/src/app-role.test.ts` applies the same SQL to an embedded Postgres, then checks as `daloy_app` that DML works, that CREATE, DROP, ALTER and TRUNCATE are refused, and that a worker with pg-boss runs a workflow to the end.

## Consequences

A compromised app can still read and change every row, but it cannot change the schema. The init script only runs on a new volume: an existing volume needs `docker compose down -v` or the SQL run by hand. The owner is the `POSTGRES_USER` superuser of the official image. Checked by hand on 2026-11-13 with Docker Desktop: on a new volume the `migrate` service exits with code 0, the api and worker hold only `daloy_app` connections, `CREATE TABLE` as `daloy_app` fails with "permission denied for schema public", and the seed and demo login work.
