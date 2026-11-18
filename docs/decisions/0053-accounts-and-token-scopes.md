# 0053: Accounts and token scopes

## Context

An owner who forgot the password had no way back in, and nobody could change one. API tokens for MCP gave full access to the workspace for ever. A reset link is the one public route that can take over an account, so how it is made, sent and limited matters most. Tokens already exist in live installations and must keep working.

## Options

Enforcing scopes:

1. Check the scope inside each tool handler. One missed check leaves a tool open.
2. Register only the tools a token's scopes allow. The server is built per request already (decision 0011), so this costs nothing.

Answering a reset request:

1. Look up the account, send the mail, then answer. The answer and its timing would show which emails have accounts.
2. Answer 202 first and do the lookup and mail afterwards.

Limiting reset mail to one address:

1. Only a per-IP limit. Many addresses could still mail one person.
2. Also count links per account in Postgres.

API tokens on a password change:

1. Revoke them. Tokens belong to the workspace, so one person changing their password would break the owner's integrations.
2. Keep them and leave revoking to the owner on the tokens page.

Scopes of tokens that already exist:

1. Read only, which would break live clients without warning.
2. Full access, as before.

## Decision

Register by scope, answer first, count in Postgres, keep tokens, and give old tokens full access.

- Change: `POST /auth/password` needs the current password (a wrong one is 400, not 401, so the console does not treat it as signed out) and a new one of 12 to 200 characters, hashed with argon2id. It keeps the current session, deletes the account's other sessions and marks open reset links used. 10 a minute per user.
- Reset request: `POST /auth/password-reset` returns 202 `{ ok: true }` for any email. The lookup and the mail run after the response. 5 requests per 15 minutes per IP, and at most 3 links per account per hour, counted in Postgres under a row lock on the user so the cap holds across processes.
- Link: 32 random bytes, only the SHA-256 stored, 30 minutes, in the URL fragment (`#/reset-password/<token>`) so it is not sent in request lines or Referer. Using it is one guarded UPDATE, so it works once. Using a link or changing the password retires the account's other open links, and success deletes every session. Unknown, used and expired links give the same 400.
- Mail: through the installation's SMTP server in the workspace language. It skips the shared-mail approval, because it is a system message to the account's own address, and an owner who is not approved for shared mail still has to be able to recover the account.
- Scopes: `read` (`get_run_status`, `list_bookings`), `run` (one tool per published form workflow), `manage` (`resolve_run`, `cancel_booking`, `reschedule_booking`). No MCP tool edits workflows, so `manage` covers changing runs and bookings. Tools outside the scopes are absent from `tools/list`, and a call is an unknown tool. The expiry is optional, 1 to 365 days. The console defaults to read and run, no manage, 90 days. Expired tokens get 401 like revoked ones and do not update `last_used_at`.
- Migration 0031 adds `password_resets` and, on `api_tokens`, `scopes` (default `{read,run,manage}`) and a nullable `expires_at`. The token hash is unchanged. `accounts-upgrade.test.ts` migrates a database at 0030 with a session and a token and checks both still work.

## Consequences

- If the SMTP server fails, the error is only logged and the requester sees the same answer. Someone locked out has to ask again or ask the operator.
- Whoever controls the mailbox controls the account. Sign-up emails are not verified, so a reset goes to whatever address registered.
- The per-IP counters live in each process, so several API processes allow more than 5 requests per address. The per-account cap does not have this gap.
- A person could be locked out of reset for an hour by someone who asks 3 times for their address. The links already sent still work.
- A password change leaves API tokens alive. An owner who suspects a leak must also revoke tokens.
- Tokens made before N11a keep full access and never expire until the owner replaces them.
