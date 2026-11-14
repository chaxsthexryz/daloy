# 0024: Only approved accounts may use the shared mail server

## Context

An independent QA review found that a new sign-up with no verified sender could send to any address through the installation's SMTP server. It could do this from a live test run, a published workflow, an approval email or the "Send a test email to me" button, which goes to a sign-in address nobody has checked. On Mailpit that harms nobody. Once an operator points `SMTP_*` at a real relay and opens sign-up to outside beta users, it is an open relay. Decision 0020 only told operators not to do that.

## Options

1. Keep the documentation only. Not enough for a public beta.
2. Email verification for every sign-up. Proves the account owns its sign-in address. It does not stop that account from mailing anyone else, so it does not close the relay.
3. Operator approval per workspace with a daily recipient limit, enforced where mail is sent. Every send that can reach the shared server already goes through `sendAs()`.

## Decision

Option 3.

- `SHARED_MAIL=open|approved`. When unset, it is `open` only if `SMTP_HOST` is unset, `mailpit`, `localhost`, `127.0.0.1` or `::1`, and `approved` otherwise. So the local demo needs no setting. Pointing `SMTP_HOST` at a real server locks the shared server down unless the operator explicitly writes `open`. An unknown value counts as `approved`.
- `users.shared_mail_daily_limit` is the number of recipients a workspace owner may reach per UTC day through the shared server. Null means not approved. Only the operator sets it, with SQL (README). No API route changes it.
- `sendAs()` checks the policy after `resolveSender()` returns the installation server. It counts the resolved recipients into `shared_mail_usage` (`user_id`, `day`) with one `INSERT ... ON CONFLICT DO UPDATE ... WHERE sent + n <= limit`. The row lock makes the limit exact across any number of API and worker processes. An unapproved account or a full day gets a non-retryable step error that points to Connect Gmail, and no server is contacted.
- Owners who send from their own confirmed Gmail, or through Outlook, are not affected: they use their own mailbox.
- `GET /settings/email` returns `installationAllowed`, so Business and email says when the shared server will not send for this account.

## Consequences

- Each attempt counts, including a retry of a send that failed, so the limit errs on the safe side. Failed sends are not refunded.
- Approving an account is an SQL statement for now. An admin page can come later.
- Limits are per workspace per UTC day. There is no per-minute burst limit beyond the existing route limits.

## Update, November 2026

A localhost SMTP server can itself be a proxy to a real relay. With `NODE_ENV=production` (which hosted deployments set for secure cookies anyway), an unset `SHARED_MAIL` now always means `approved`, whatever the host. Local development keeps Mailpit open.
