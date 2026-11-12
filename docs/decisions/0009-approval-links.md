# 0009: Approval links, decisions and timeouts

## Context

The approval step emails a person a link. PROJECT.md asks for a signed, expiring, single-use link, an approve and reject page, and a configurable path when nobody answers in time. The link works without a login, so anyone who holds it can decide. The run must wait without a worker sleeping, and wake up either when the person answers or when the timeout passes.

## Options

For the link:

1. An HMAC-signed token that carries the step run id and the expiry. The server needs no lookup to check it, but single use still needs a database row, and a leaked signing key forges links for every approval.
2. A random token, with only its SHA-256 stored in `approvals.token_hash` next to `expires_at` and `used_at`.

For waking the run:

1. Schedule a queue job for the timeout, as the delay step does, and queue another job when the person answers.
2. Schedule nothing for the timeout. The answer queues a job, and the worker's sweep picks up the run once `next_attempt_at` (the timeout) has passed.

## Decision

Link option 2. The token is 32 random bytes (base64url, 43 characters). It cannot be guessed or derived from the database, the server checks expiry and use itself, and there is no signing key to rotate or leak. This gives the guarantees a signature would, plus single use. The same pattern already protects sessions and API tokens.

- `GET /approvals/:token` only shows the message and two buttons. The decision is recorded on `POST`, so mail scanners and link previews that fetch the URL cannot approve anything.
- `recordDecision` is one guarded UPDATE (`token_hash = $1 AND used_at IS NULL AND expires_at > now()`), so a replayed or expired link changes nothing. Unknown, used and expired links get the same 404 page.
- A step attempt that runs again after a worker crash deletes the old row and sends a new link. Only the newest link works.

Wake-up option 2. pg-boss keeps one queued job per run (`policy: short` with the run id as singleton key). A job scheduled for the timeout would occupy that slot, and the job queued by an early answer would be dropped until the timeout. So the approval step schedules no job: `POST` sets `next_attempt_at = now()` and queues the run, and the sweep (every 15 seconds) handles the timeout.

When the waiting step wakes, the worker calls `claimTimeout` in the same transaction that finishes the step. It marks an unused approval as `timeout` with a guarded UPDATE. The row lock serialises it with `recordDecision`, so if the click and the timeout race, exactly one wins, and the branch matches what is stored.

## Consequences

- A timeout fires up to 15 seconds late. Approval timeouts are at least one minute, so this is acceptable.
- Whoever holds the link can decide: there is no check that the person clicking is the addressee. The email is the authentication. Links expire with the step and work once, and `Referrer-Policy: no-referrer` and `Cache-Control: no-store` keep the token out of other sites and caches.
- With several addresses in `to`, the first answer decides.
- In a test run without live calls, the approval step does not send an email and takes the `approved` branch at once.
