# 0137: Block unregistered PLATFORM_ADMINS emails at sign-up and invite accept (S2)

## Context

In A1 (`PLATFORM_ADMINS`, decision 0122), any account whose registered email appears in `PLATFORM_ADMINS` gains read access to cross-tenant counts and run metadata plus plan/shared-mail write controls under `/admin`. If an operator configures `PLATFORM_ADMINS` with an email address before creating that account in `users`, anyone who reaches public `POST /auth/register` or accepts an invite for that email could register it first and inherit platform admin rights.

## Options

1. Add mandatory email verification across all public sign-ups. Heavy for local/self-hosted installs without outbound mail configured and changes every onboarding/test flow.
2. Block public `POST /auth/register` and new-account `POST /auth/invites/:token/accept` whenever the normalized email matches `PLATFORM_ADMINS`, returning the same error status and message as an already-registered email. Rejected for admin self-onboarding via public sign-up, chosen for simplicity and zero false-positive surface.

## Decision

- `AuthController.register` checks `isPlatformAdmin(this.config.platformAdmins, body.email)` after hashing the password (keeping timing uniform) and throws `ConflictException("email already registered")`.
- `AuthController.acceptInvite` checks `isPlatformAdmin(this.config.platformAdmins, invite.email)` when creating a new user row inside the invite transaction and throws `UnauthorizedException("this email already has an account: enter its password")`, rolling back `claimInvite` and creating no user row.
- An operator must register or seed their own account first (before adding their email to `PLATFORM_ADMINS`, or directly in Postgres), then sign in via `POST /auth/login`.

## Consequences

- Unregistered emails listed in `PLATFORM_ADMINS` cannot be claimed via public sign-up or team invite acceptance, and the HTTP responses do not reveal whether an email is on the allowlist.
- Existing `PLATFORM_ADMINS` accounts continue to sign in normally through `POST /auth/login`.
