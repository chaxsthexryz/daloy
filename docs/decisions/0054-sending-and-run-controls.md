# 0054: Sending and run controls

## Context

Four gaps remained before a real office relies on Daloy (roadmap N11b):

- Mail through the owner's own Gmail or Outlook had no daily cap. A busy automation could get the owner's mailbox suspended by the provider, and an owner could not tell it was close.
- A signed webhook call could be replayed at any time. `X-Daloy-Signature` covered only the body.
- An owner could not stop an automation without turning it off (which unpublishes it and drops its webhook URL, form and schedule).
- A run that was waiting on a long delay or an approval could not be stopped, only left to wake up.

## Options

Send cap:

1. Count recipients per workspace per day in the existing usage counters, with the step key so a retry is not counted twice, and send the run to review when it is over.
2. A column per workspace with its own cap. Rejected for now: one installation-wide number (`MAILBOX_DAILY_CAP`, default 400) is enough until an operator needs to differ per customer.
3. Fail the run when over the cap. Rejected: a failed run offers Retry but not a plain account of what happened, and a send that was held for a cap should be resumed by a person.

Webhook timestamp:

1. Sign `<timestamp>.<body>` (Stripe style) and reject calls more than 5 minutes from the server clock. Old callers keep working until the owner requires the timestamp.
2. Replace the format at once. Rejected: every existing caller would break on the day of the upgrade with a 401 and no warning.
3. Sign a timestamp header and the body separately. Rejected: the timestamp would not be covered by the signature unless the two were joined, which is option 1.

Pause:

1. A `paused_at` column on the workflow, refused where runs are created.
2. Unpublish. Already exists as Off. It loses the webhook URL, the form link and the schedule, so it is not a pause.
3. Stop each trigger source separately. Rejected: four places to get wrong, and a fifth added later would be missed.

Cancel:

1. A guarded UPDATE from `pending` or `waiting` to `cancelled`, next to the existing `resolveRun`.
2. Let a running run cancel too. Rejected: a worker is in the middle of an outside call, and review already has Stop.

## Decision

Send cap (`packages/db/src/usage.ts`, `mail.ts`, `apps/worker/src/steps/index.ts`):

- New usage kind `mailbox`: recipients per workspace per Manila day through the owner's Gmail (`sendAs`) and the Outlook step, one counter for both. The limit does not depend on the plan.
- Counted before the send, keyed by the step key. Over the cap throws a `QuotaError` with `review: true`. `decideRetry` turns that into `needs_review`, so nothing is sent and nothing is dropped. The reason names the cap and says nothing was sent.
- Because nothing was sent, "It went through" is hidden for that run and `resolveRun` refuses `delivered` when the last attempt's outcome is `not_sent`. Send again and Stop work.
- Not counted: mail through the installation server (it has its own cap), the schedule watchdog's alert and the test email.

Webhook signature (`apps/api/src/public.ts`):

- v1: `X-Daloy-Timestamp: <unix seconds>` and `X-Daloy-Signature: sha256=<hex HMAC of "<timestamp>.<raw body>">`. The signature is checked first, then the window (300 seconds, both directions). A caller that cannot sign learns nothing about the window.
- A call that carries a timestamp header is only ever read as v1.
- Without the header, the old format is accepted until the trigger's `requireTimestamp` is true. Each accepted old call sets `triggers.legacy_signature_at` (at most once an hour) and the 202 carries `Daloy-Signature-Warning: timestamp-missing`. The editor shows the date and a "Require the timestamp" checkbox, on by default when a signing secret is first added.
- A v1 call with no `Idempotency-Key` and no trigger `eventKey` is keyed by `sig:<signature>`, so an identical captured call inside the window returns the first run (decision 0029). Two different events sent in the same second with identical bodies would be treated as one: put an id in the body or send an `Idempotency-Key`.
- No sunset date is forced. N11c can pick one once the owner has seen the notice.

Pause (`packages/db/src/runs.ts`, `apps/api/src/workflows.ts`, `paused.ts`, `public.ts`, `apps/worker`):

- Migration 0032 adds `workflows.paused_at` and `resumed_at`.
- `assertNotPaused` reads the workflow row under a share lock inside the transaction that inserts the run, so a pause waits for runs being created and none starts after it commits. `createRun` calls it (builder test runs are exempt), as do the tracked request insert in `recordRequest` and the booking reschedule, which insert runs directly.
- Webhook, console Run button, MCP and a staff reschedule answer 409 with a plain message (one exception filter). A public form shows a paused page and answers 409. PayMongo events get a 2xx and start nothing, so PayMongo does not disable its webhook. A schedule fire is skipped with a log line. Email-in starts nothing but still moves its checkpoint, so mail that arrives during a pause is skipped, not replayed on resume.
- The watchdog leaves paused automations out and clears an old flag. A fire counts as expected only after `max(publishedAt, resumedAt)`, so a resume raises no false alert.
- The Automations card shows Paused and a Pause/Resume button for the owner. A paused automation is under the Off filter, but a run that needs a person still shows under Needs you.

Cancel (`packages/db/src/runs.ts`, `apps/api/src/runs.ts`, `apps/worker/src/advance.ts`):

- `cancelRun` is one guarded UPDATE from `pending` or `waiting`. The waiting step attempt is closed as failed with outcome `not_sent`, and open approval links of the run expire, so an answer cannot confirm anything.
- A worker that wakes the run at the same moment loses the guarded update and stands down without an error (`advance` checks for `cancelled`).
- Running and review runs are refused with a message (review: use Stop).

## Consequences

- Gmail messages sent outside the steps (the watchdog's alert, the test email) do not count toward the cap. A mailbox used only by Daloy can still reach the provider's own limit by about that much.
- The cap is the same for every workspace on the installation. Per-workspace overrides would need a column.
- Old webhook callers stay unauthenticated against replay until their owner turns on `requireTimestamp`. The editor notice and the response header are how they find out.
- A staff reschedule is refused while the automation is paused, because it would start a run. Cancel by staff still works.
- Cancelling does not undo anything a finished step already sent.
