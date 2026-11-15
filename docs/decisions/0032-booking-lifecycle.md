# 0032: Booking lifecycle

## Context

QA-02 (spa appointments) confirmed two bookings for the same therapist and time, and staff had no way to see, cancel or move a booking. P6a added zoned datetime fields and workspace resources (decision 0031). A booking also has to keep the runs around it consistent: a reminder must not go out for a time that was moved or cancelled, and a retried request must not book twice or start a second reminder run.

## Options

1. Check availability in the application before inserting. Two requests can both pass the check and both insert.
2. Lock the resource row while booking. It serialises bookings per resource, but any path that forgets the lock can still double book.
3. A Postgres exclusion constraint on the booked time range, so the database refuses an overlap whatever the path.

For runs around a changed booking: cancel them at the moment of the change, or let each one stop at its next step.

## Decision

Option 3, with versions on every booking.

- `bookings` has a `tstzrange` `during` (`[)`, so back-to-back slots fit), a `status` (active or cancelled) and a `version`. `bookings_no_overlap` excludes overlapping active ranges per workspace, test scope and resource (`btree_gist` gives GiST equality for `uuid` and `boolean`). It is the only availability check. A violation (23P01) inside a savepoint is answered "taken".
- The `booking` step creates, reschedules or cancels, with branches `done`, `taken` and `not_found`. Its `start` must be `{{trigger.<datetime field>}}`, so the field's zone, slot and future rules apply; the step checks the value again with those rules when it runs, whatever path the data came by. A create checks inside the booking transaction that the resource belongs to the workspace and is active.
- Each step attempt is one transaction: if `booking_results` already has a row for this run and step, that result is returned (a retry or takeover never books twice); otherwise the booking changes, the run is linked to the new version, and the result is stored.
- Changing a booking is limited to staff (owner and operator, on the Bookings page or the API), MCP (`list_bookings`, `cancel_booking`, `reschedule_booking`) and webhooks with a signing secret. Saving refuses a reschedule or cancel step on a form or schedule trigger; a manual trigger (the owner's Run button) is allowed.
- Every change is logged in `booking_changes` with primary key (booking, version it moved from), in the same transaction as the version-guarded update, so a version changes at most once. Staff and MCP send the version they saw. A request whose version already has a change gets that change's result with `duplicate: true` when it is the same operation (same action and, for a reschedule, the same start compared as an instant, so `14:00+08:00` and `06:00Z` match), and a 409 otherwise. The booking row is locked first, so racing requests take turns: one changes it, identical ones get the duplicate, different ones the 409. The log is in the database, so this holds after a restart.
- A staff reschedule changes the time only. It needs the published version to still have the booking step that made the booking (same id, a create with a datetime start). The new time is checked with that field's rules. No step after the booking step may read `{{steps.X}}` for a step that ran before it, since the new run would fill it in blank; such a reschedule is refused naming both steps. In one transaction it moves the booking, creates one new run on the published version with the old payload and the new time, records the booking step there as done with the new times (so `{{steps.book.output...}}` reads the new booking), links that run to the new version, and logs the change. The run is queued after commit.
- Runs are linked to (booking, version). Before any attempt (a new step, a retry, a resumed wait, an operator's Send again, Retry or It went through) a run linked to an older version is cancelled with "The booking was rescheduled or cancelled, so this run stopped before step X." The run that made a change moved its own link in that transaction and carries on. A failed attempt of a superseded run is not retried. A waiting reminder stops when it wakes; until then the runs list and run page show it as superseded, without claiming it has stopped.
- For emails and HTTP calls that are not idempotent, the check is repeated inside `claimSend`: the booking row is read `FOR SHARE` under the attempt lock, which is held until the request is on its way. A change either commits first (the send is refused and the run cancelled) or waits until the send has started.
- Sheets, Slack, Outlook and Teams deliveries are sent by the delivery worker apart from the run (decision 0021), so they get the same check there (N2b). Right before the provider call, `attempt()` in `packages/db/src/deliveries.ts` reads the run's current `booking_id` and `booking_version` through `deliveries.run_id` (so a run whose own booking step moved the link reads the new link) and the booking row `FOR SHARE`, in a transaction held until the provider answers. A change that committed first stops the send: the delivery ends `failed` with "The booking was rescheduled or cancelled, so this was not sent." in the Requests list. A change that arrives during the call waits for it to return. Retry and Post again refuse a delivery of a superseded run, and the API's 409 gives the same reason. No migration: the existing `failed` state carries it.
- Test runs (mocked, AI-only or live) only see and make test bookings: `test` is part of the constraint and every lookup, their references start with `TEST-`, and staff lists and MCP never show them. A tester can choose `{booking: "taken"}` or `{booking: "not_found"}`, which books nothing.
- A run that fails after its booking step leaves the booking active. Staff see "needs attention" while the run linked to the current version has failed or waits for review.

## Consequences

- Known race: an idempotent HTTP call has no send lock. A change that commits between the attempt-start check and such a send does not stop that one send. No send already on its way can be recalled.
- Accepted window: a change that arrives while an email is handed to SMTP, or while a delivery's provider call is open (bounded by the provider timeout), waits for it, so that one message goes. A delivery holds a pooled database connection for the length of its provider call.
- A delivery that was uncertain before the change (Sheets with `checkFirst`) says that an earlier attempt may have reached the provider. An uncertain Slack, Teams or Outlook delivery still goes to review first, since it may already be posted.
- A superseded waiting run keeps its job until its wake-up time, then stops.
- A rescheduled run starts after the booking step, so steps before it (a front-desk note) do not run again.
- Bookings are never deleted; resources referenced by a booking cannot be deleted either (there is no resource delete).
- `btree_gist` must be available where the migration runs. It ships with the embedded test Postgres, `postgres:17-alpine` and the CI database, and it is a trusted extension, so the database owner can create it.
- Migration 0019 adds `bookings`, `booking_results`, `booking_changes`, two nullable columns on `runs`, the extension and the constraint. Nothing existing changes.
- Out of scope: moving a booking to another resource, opening hours, lead times and capacity above one.

## Fixes from the 7c73879 review

- A staff reschedule builds its run from the run that created the booking (its `booking_changes` row from version 0) and that run's booking step, never from the run linked to the latest version. After a desk workflow moved a booking, the old code copied the desk run's payload and sent the guest's confirmation and reminder to the desk.
- `bookFromStep` takes a transaction-scoped advisory lock on (run, step) before it reads `booking_results`. Two overlapping attempts of one step (a takeover while the first worker is still in its transaction) take turns, and the second returns the stored result instead of failing on the primary key or the exclusion constraint. The options were this lock or catching the conflict and reading again; the lock was chosen because the exclusion wait between two inserts can also end in a deadlock error, which a catch would have to know about too.
- Each `booking_changes.result` now stores the booking as that change left it. A repeated staff or MCP change from the same version, with the same action and the same start instant, is answered from that row before the new time or the published version is checked, so a replay gets its own version, times and run after later changes and after its time has passed. Rows written before this fix have no stored booking, so a replay of one answers without `booking`.
- A staff or MCP time without an offset is read in the booking's own timezone (the one the Bookings page shows), not the published field's. After a workflow edit moved the field from Manila to New York, 16:00 entered for a Manila booking was saved as 05:00 the next day. The field still supplies the slot grid and the payload field name.
