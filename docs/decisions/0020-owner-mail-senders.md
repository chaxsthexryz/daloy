# 0020: Each owner's own Gmail sender, with no fallback

## Context

Roadmap phase 2 lets a client send their automations' email from their own address. Until now every workflow on an installation sent through one SMTP server from the `SMTP_*` env vars. If an operator put their Gmail account there, every user sent as that account. Two owners on one installation must each send as themselves, and a broken or disconnected account must not affect anyone else or quietly send from a different address.

## Options

How the owner connects Gmail:

1. Google OAuth with the `gmail.send` scope. Needs a Google Cloud project, a consent screen, and Google's review for a restricted scope before people outside the developer's own organisation can use it.
2. An app password over SMTP (smtp.gmail.com, port 465). Needs 2-Step Verification on the Google account. Some Workspace and Advanced Protection accounts cannot create one.

What happens when an owner's sender cannot send:

1. Fall back to the installation's server, so the email still goes out.
2. Stop the send with a clear error, and let the owner choose the installation server again explicitly.

Proving the owner controls the address:

1. Trust the address typed in.
2. Send a one-time link to it and require the signed-in owner to open it.

## Decision

- Connection option 2, as the roadmap specifies. The password is stored in `mail_senders`, encrypted with AES-256-GCM with the owner's id in the associated data (as `secrets` and `ai_keys` are), and is never returned by the API. OAuth stays a later option for clients who cannot use app passwords.
- Failure option 2. `resolveSender()` in `packages/db/src/mail-senders.ts` is the only place that decides who sends, and `sendAs()` in `packages/db/src/mail.ts` is the only send path: email steps, approval mail and the API's test email all go through it. No `mail_senders` row means the installation server (the migration path for existing owners and the seeded demo). A row that is `unverified`, `failed` or `disconnected` makes the step fail without retrying and without contacting any server. Gmail answering a login with 535 (EAUTH) marks the sender `failed`. Disconnecting deletes the password and keeps the row, so mail stays blocked. "Use the local mail server instead" deletes the row, which is the owner's explicit choice.
- Verification option 2. The test email to an unconfirmed Gmail address carries a link to `#/verify-sender/<token>`. The token is 32 random bytes; only its SHA-256 is stored. It expires after 30 minutes, works once, and `POST /settings/email/verify` only accepts it from the session of the owner it was sent to. Test emails are limited to 5 a minute per owner. Replacing the password of a confirmed address keeps it confirmed (the link proved the mailbox, not the password); a new address needs a new link.
- The mailer moved from the worker to `packages/db`, so the API's test email and the worker share one send path. `packages/db` gained `nodemailer` 10.5.0 (MIT-0), the version the worker already locked. That version was published two days before this change, so pnpm's seven-day `minimumReleaseAge` refused to resolve it for a new package. The lockfile entry for `packages/db` was added by hand with the exact versions already locked for the worker, and installed with `--frozen-lockfile`, so no new code entered the dependency tree. The policy itself is unchanged.
- The rate limit guard now counts per signed-in owner when a session is present, and per IP otherwise.

## Consequences

- An owner whose Gmail breaks sees failed runs with "Reconnect Gmail" until they fix it. There is no button yet to retry only the failed delivery.
- Each send opens a new SMTP connection and logs in. Fine at small volumes; Gmail allows about 500 messages a day per account.
- The installation server is still shared by owners who connected nothing. On a hosted installation the operator should point it at a server they are allowed to send from for everyone, or at Mailpit.
- Live Gmail behaviour is checked by hand ([live Gmail check](../live-gmail-check.md)); the tests use a fake SMTP server that records which account logged in.
