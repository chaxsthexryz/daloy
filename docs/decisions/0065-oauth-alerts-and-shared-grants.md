# 0065: Owner email for a broken grant, and a warning for a shared provider account

## Context

The final review of the managed OAuth work ([plan](../plans/managed-oauth-plan.md) phase P8, [threat model](../threat-model.md) "Managed OAuth final review") left two risks open:

- R8 and open question 10: when a provider refuses a grant mid-run, the connection is marked failed and deliveries stop, but the owner learns about it only by opening Apps or Activity. The accepted answer to question 10 was one email per connection per day, reusing the watchdog mailer.
- R14: one provider account connected in two places. A provider may keep one grant per account and client (unverified), so disconnecting in one place can end Daloy's access in the other. The plan's mitigation was "warn at connect".

## Options

Which mail server sends the R8 email:

1. `sendAs`, the owner's own sender, as the missed schedule email does (decision 0020). When the broken grant is the owner's Gmail sign-in, `sendAs` refuses to send, so that alert would never arrive.
2. The installation's server, as the password reset email does. Always available, and the email goes only to the owner's login address, so it cannot be used to mail anyone else.

What counts as "the same account" for R14:

1. Same provider and the same `external_id`.
2. The same, plus every Google app and the Gmail sign-in as one family, because they share one Google client and one Google account id (`sub`), in the same workspace too.

Where the warning shows:

1. Only on the page the consent lands on.
2. On the card whenever the account is shared, and again in the Disconnect confirmation, which is the moment the risk applies.

## Decision

- R8: option 2. `alertBrokenGrants` in `apps/worker/src/connection-alerts.ts` runs after the schedule watchdog, once a minute. It picks OAuth connections and Gmail sign-ins with status `failed` whose `alert_at` is empty or more than a day old, claims each with a conditional UPDATE, and emails the owner through the installation's server. A failed send puts the old `alert_at` back so the next check tries again. The email names the app and links to Apps; it never quotes the stored error, which can hold provider text. Pasted keys are left out: they are not grants that stop on their own, and their cards already say what to fix.
- R14: option 2 for matching, option 2 for display. `sharedGrants` in `packages/db/src/oauth/shared.ts` returns the workspace's app keys whose account id appears in another OAuth grant. `GET /settings/connections` returns them as `shared`. The Apps page provides them through the `SharedGrants` context, and `ConnectPanel` shows the warning under the account line and adds it to the Disconnect confirmation. Nothing about the other workspace is returned.
- Migration 0039 adds `alert_at` to `connections` and `mail_senders`, and an index on `connections.external_id` for the shared check.

## Consequences

- After deploying 0039, every OAuth connection already marked failed gets one email at the next check.
- An owner whose installation has no working mail server gets no R8 email; the worker logs the failure and retries each minute until the server works. The card still shows the problem.
- The R14 warning says "may", because whether a revoke at Google, Slack or the record apps ends the other grant is unverified. Settling it is step 11 of the [live Google OAuth check](../live-google-oauth-check.md) and the matching steps of the other live checks.
- The warning tells an owner that their provider account is connected somewhere else in Daloy. It does not say where. The owner already controls that provider account, so this tells them nothing about another customer they could not learn at the provider.
- Tests: `apps/worker/src/connection-alerts.test.ts`, `packages/db/src/oauth/shared.test.ts`, `apps/web/src/ConnectPanel.test.tsx`, and the isolation test in `apps/api/src/oauth.test.ts`.
