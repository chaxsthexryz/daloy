# 0158. Two-factor sign-in (TOTP) for platform admins

## Status

Accepted

## Context

The platform admin can change every workspace's plan, mail limits and the shared AI key. A stolen password alone should not be enough. The owner asked for TOTP before launch, with recovery codes and a way to reset it when a phone is lost. No TOTP or QR library is installed.

## Options

- WebAuthn passkeys. Stronger, but a much larger change, and the owner asked for authenticator-app codes.
- An npm TOTP library. TOTP is about 20 lines on `node:crypto`, and the RFC 6238 vectors test it.
- TOTP written here, with the recovery codes hashed like passwords.

## Decision

- **TOTP** (`apps/api/src/totp.ts`): RFC 6238 with SHA-1, 30-second steps, 6 digits, accepting one step before and after now. All three candidates are compared with `timingSafeEqual`. A code whose step is not after `admin_totp.last_step` is refused, and the step is claimed in one guarded `UPDATE`, so a code works once even when sent twice at the same moment. Tests use the RFC 6238 appendix B vectors.
- **Storage** (migration `0065_admin_two_factor.sql`): `admin_totp` holds the base32 secret encrypted with `encryptSecret` under the associated-data name `admin_totp`, `confirmed_at` and `last_step`. `admin_recovery_codes` holds ten argon2 hashes with `used_at`, and goes when the TOTP row goes. `sessions.second_factor_at` is when that session last passed the check.
- **Enrollment** (`POST /admin/2fa/enroll`, then `/admin/2fa/enroll/confirm`): a new 20-byte secret, shown as an `otpauth://` link and as the key in groups of four, with no QR code since no QR library is installed. Starting again replaces an unconfirmed secret. One valid code confirms it, passes the session, and returns ten recovery codes (`xxxxx-xxxxx`), shown once. A confirmed enrollment cannot be replaced without a reset.
- **Enforcement** (`AdminGuard`): every admin API route needs `second_factor_at` within 12 hours and not before `confirmed_at`, so a reset and a new enrollment start over. An admin not enrolled gets 403 with `twoFactor: "setup"`, one who must enter a code gets `twoFactor: "verify"`. The page and the `/admin/2fa` routes use `AdminSessionGuard`, the same admin check without two-factor. A second session of the same admin has to pass on its own.
- **Verification** (`POST /admin/2fa/verify`): a code from the app, or a recovery code, which is marked used in a guarded `UPDATE`. Typed recovery codes ignore case, spaces and dashes.
- **Rate limit**: after 5 wrong codes in 15 minutes, every check for that admin (enroll confirm, verify, recovery, reset) answers 429, even with a right code. The count comes from `admin_actions`, so it holds across restarts.
- **Audit**: `admin_actions` gains `2fa_enroll`, `2fa_failed` (with the kind and the step, never the code), `2fa_recovery` (codes left) and `2fa_reset`.
- **Reset**: from the console, with a passed session and a fresh code (`POST /admin/2fa/reset`), or by the server owner in SQL, which deletes the `admin_totp` row (`docs/deployment.md`).

## Consequences

- The first time an admin opens the console they must enroll. Admins in the e2e run enroll through the real screens.
- A lost phone and lost recovery codes need the server owner's SQL reset; nothing in the web app can bypass the check.
- A wrong-code storm fills the audit log with `2fa_failed` rows; that is the point.
- Tests of other admin routes mark their admin enrolled and passed with `test/admin-2fa.ts`.
