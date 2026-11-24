# 0120: Platform admin page gated by an email allowlist

## Context

A1 of "Platform admin and ops". The operator set plans and approved accounts for the shared mail server with SQL (decision 0024, `docs/operations.md`), and had no view across workspaces of sign-ups, usage or failing runs. The page must be easy to explain to a client: who can open it, what it can read, and what it can change.

## Options

1. A workspace role such as `platform_admin`. Rejected: roles belong to one workspace, an owner can invite people, and a bug in role checks would then leak every tenant.
2. A separate admin app with its own login. More to build and run, and still needs the same queries.
3. An env allowlist of account emails checked on the server for every admin route, inside the existing API. Chosen.

For the database:

1. A second Postgres role for admin reads. It would read the same tables `daloy_app` already reads, so it adds setup without narrowing anything.
2. Keep `daloy_app`, put every unfiltered query in one module, and run its reads in a read-only transaction. Chosen.

## Decision

- `PLATFORM_ADMINS` holds comma-separated emails, matched trimmed and lowercased. Empty or unset turns the admin page off.
- `AdminGuard` (`apps/api/src/admin.ts`) sits on the whole `AdminController`. It reads the session itself and answers 404 to a missing or expired session and to every account not on the list, so the routes look absent. PUT routes also need the installation's own Origin.
- Cross-tenant queries live only in `packages/db/src/admin.ts`. Reads run inside `SET TRANSACTION READ ONLY`. They select named columns and never a run's payload, step input or output, error text or delivery payloads. The module imports no secrets code, and a test checks that.
- Plan override sets `users.plan` and `users.plan_started_on`, the same columns the SQL in `docs/operations.md` sets. A new plan without a date starts today in Manila time. Removing the plan clears the date.
- Shared mail approval sets `users.shared_mail_daily_limit` (1 to 10000, or null to withdraw), which `sendAs()` already enforces (decision 0024).
- Each change locks the owner's row and writes an `admin_actions` row (admin email, action, workspace, before, after) in the same transaction. Nothing updates or deletes those rows.
- Limits: 30 reads and 10 changes a minute per admin.
- Per-workspace AI and SMS use is the counter for each workspace's current cycle, computed with the same `periodOf` the owner's usage page uses.

## Consequences

- An admin is a normal account, so a stolen admin session reaches every workspace's counts. There is no second factor yet.
- The overview sums every workspace and lists the newest 200. Paging and search come when there are more.
- The run list shows that a run has an error, not the text, because step errors can quote customer data. An admin who needs the text asks the owner or reads the database directly.
- The SQL in `docs/operations.md` and the README still works and stays as the fallback.
