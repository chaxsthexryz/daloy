# 0067: Retired secrets retention and scrub-then-delete purge

## Context

Decision 0025 added `retired_secrets` so that rotating or deleting a workspace secret keeps earlier run history hidden on read. That design never removed rows from `retired_secrets`. Keeping rotated and deleted secret ciphertexts indefinitely creates two problems:

- If a database backup and `SECRETS_KEY` are both exposed, an attacker can recover credentials the owner rotated or deleted months or years earlier.
- Every history read decrypts all `retired_secrets` rows for the workspace, so read latency and memory grow with every rotation.

Separately, auditing all API and MCP read endpoints showed that several stored error and text fields outside `GET /runs` were not passed through `historyHider`: approval page messages (`step_runs.input.message`), request subjects (`requests.subject` on both `GET /workflows/:id/requests` and `GET /my/requests`), delivery references (`deliveries.reference`), stored and live errors on connections (`connections.last_error` and connection test/picker errors), email sources (`email_sources.last_error`), and mail senders (`mail_senders.last_error` and email test errors). Also, endpoints that ran `historyHider` after reading history rows would have a read-committed race against a purge that commits between the two queries.

## Options

1. Keep `retired_secrets` forever. No history rows are rewritten, but deleted credentials stay encrypted in the database forever and read-side work grows without bound.
2. Delete `retired_secrets` rows after 90 days without rewriting stored history. This shrinks the table, but any older row that still holds a secret value would start leaking on read as soon as its retired row is removed.
3. Scrub-then-delete after 90 days, atomic per workspace. Permanently replace all four encodings of expired retired secret values with `[secret]` in stored history and error tables, then delete only those exact `retired_secrets` rows in the same database transaction.

## Decision

We adopt option 3 and close the read-side redaction gaps.

- Retention defaults to 90 days (`DEFAULT_RETIRED_SECRET_MAX_AGE_DAYS = 90`), overridable via the positive integer environment variable `RETIRED_SECRETS_MAX_AGE_DAYS`, validated on worker boot by `retiredSecretMaxAgeDays`.
- `purgeRetiredSecrets(db, secretsKey, opts)` in `packages/db/src/retired-secrets.ts` finds distinct workspaces with `retired_secrets.retired_at <= cutoff`. For each workspace, inside one transaction guarded by `pg_advisory_xact_lock(hashtextextended('retired-purge:' || userId, 0))`, it selects only the expired rows for that workspace, decrypts each value safely, builds all four forms (`secretForms`: raw, JSON-escaped, URL-encoded, form-encoded), scrubs changed rows across every table that stores run history, request text, or error text (`runs`, `step_runs`, `deliveries`, `requests`, `connections`, `email_sources`, `mail_senders`, `calendar_events`, `payments`), and deletes only the exact captured ids with `inArray(retiredSecrets.id, deletableIds)`.
- Rows that fail decryption are logged by row id and workspace id without secret data, skipped from deletion, and never allowed to break other rows or workspaces. A retired secret is never deleted unless its plaintext was decrypted and scrubbed first.
- Rows whose scrubbed value is unchanged are not updated, avoiding unnecessary writes.
- `apps/worker/src/worker.ts` runs `purgeRetiredSecrets` on the daily maintenance sweep at worker startup and every 24 hours, using `opts.secretsKey` (falling back to `deliveries`, `watchdog`, or `emailIn` keys) so it runs even if deliveries are disabled. `worker.stop()` awaits any in-flight purge before shutdown.
- No database migration is added.
- On the API read side, `historyHider` now runs on `GET /approvals/:token`, `GET /workflows/:id/requests` (including `subject` and delivery `reference`), `GET /my/requests` (`subject`), `GET /deliveries` (`reference`, `lastError`, `result`), `GET /settings/connections` (`lastError`), `POST /settings/connections/:provider/test` (live error), `GET` / `PUT` / `POST check` on `/workflows/:id/email-source` (`lastError`), `GET /settings/email` / `PUT /settings/email/gmail` / `POST /settings/email/test` (`lastError` and live error), and OAuth picker/calendar `ProviderError` responses. Read endpoints load `historyHider` before querying history rows so a concurrent purge either commits after the hider already captured the retired secret or commits before the history query reads the already-scrubbed rows.

## Consequences

- Rotated and deleted secrets older than 90 days are permanently removed from `retired_secrets`, while history continues to display `[secret]` across every read surface.
- Newer retired copies of the same secret name and secrets in other workspaces stay untouched.
- If a database error interrupts scrubbing mid-transaction, PostgreSQL rolls back the transaction so no `retired_secrets` row is deleted before its history is scrubbed.
- A corrupted row in `retired_secrets` remains in place until investigated rather than being deleted without scrubbing.
- Covered by `packages/db/src/retired-secrets.test.ts`, `apps/api/src/secrets-history.test.ts`, and `apps/worker/src/worker.test.ts`.
