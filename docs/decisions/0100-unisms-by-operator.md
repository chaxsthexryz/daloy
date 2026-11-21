# 0100: UniSMS is set by the server operator, not connected by the customer

## Context

Decision 0074 let each workspace save its own UniSMS Secret Key and Sender ID in Apps, with the operator's key (`SHARED_UNISMS_KEY=open`, `UNISMS_SECRET_KEY`, `UNISMS_SENDER_ID`) as a fallback for paid plans only. The owner's console review (phase U6 of `docs/plans/console-ui-paper.md`) asks for the opposite: Daloy's customers are sellers, small businesses and VAs who should not need a UniSMS account, and SMS should be something the operator provides, the way the server's mail sender and AI model are.

## Options

- Keep both paths and only hide the Apps card. The stored-key path stays reachable by API and the worker keeps decrypting customer keys.
- Env only. Remove the connection routes and the card, stop reading workspace keys, and treat SMS as configured when the server env holds both values.
- Env only, plus a migration that deletes `unisms` from the allowed providers. The CHECK constraints would then reject the `unisms` delivery rows that still exist.

## Decision

Env only, no migration.

- SMS is set up on a server when `UNISMS_SECRET_KEY` and `UNISMS_SENDER_ID` are both non-empty (`unismsConfig()` in `packages/db/src/connections.ts`). `SHARED_UNISMS_KEY` is dropped and no longer read.
- Any workspace may send. The existing monthly `sms` quota is the limit: preview 0 (refused before the call, with the Preview plan message), pilot 50, business 300, business_plus 1500, and unlimited when `plan` is null, which is a private install.
- The worker and `queueDelivery` never read a `unisms` row from `connections`. A step's own `senderId` is ignored; the Sender ID is the operator's.
- `PUT /settings/connections/unisms` and `POST /settings/connections/unisms/test` are removed and answer 404. The UniSMS card is removed from Apps and `Connections.tsx`. `DELETE /settings/connections/unisms` stays to clear a leftover row.
- `GET /step-schemas` gains `sms: boolean` (true when the server env is set). Turning on a workflow with an SMS step without it is refused with "SMS is not set up on this server.", and a delivery that finds no env fails with the same words. The web app no longer lists SMS as an app to connect (`lib/editor.ts`, the Build with AI app list); hiding the SMS step from Add step with the flag belongs to the editor phase.
- Keys that workspaces saved before this decision: `retireStoredUnismsKeys` runs on every worker start. It copies each stored key into `retired_secrets` (so read-side redaction keeps hiding it and the existing daily purge scrubs it from history) and deletes the `connections` row. It is idempotent and safe with two workers starting at once (it takes the same advisory lock as `saveConnection`).
- `users.unisms_disconnected_at` stays in the schema and is no longer read or written. `unisms` stays in the CHECK constraints because delivery rows still use it.

## Consequences

- A workspace that had its own UniSMS key stops sending with it. Until the operator sets the env, its SMS deliveries fail with "SMS is not set up on this server." and can be retried from Requests once it is set. The owner checks the live server for such workspaces before this deploys.
- With a plan set on every workspace, the operator pays for all SMS and the plan quota is the only cap. A private install with `plan` null has no cap.
- One customer secret fewer is stored. The threat model and `docs/live-unisms-check.md` change accordingly.
- Queued deliveries from before the change are sent with the operator's key and Sender ID, whatever account they were pinned to.
- Decision 0074 is superseded for credential resolution only. Its delivery queue, quota claim, booking check and error classification still apply.
