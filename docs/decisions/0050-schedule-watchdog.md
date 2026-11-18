# 0050: Schedule watchdog

## Context

A scheduled automation can miss a fire without any trace: the worker was down when pg-boss sent the job, the job was lost, or the schedule row is gone. No run exists, so the Automations page shows nothing wrong and the owner learns about it from a customer.

## Options

1. Ask pg-boss which schedules exist and when they last ran. It cannot tell the owner's intent, and a lost schedule row would hide itself.
2. Read the published versions in the database, compute the latest due fire from the cron, and look for a run. The database already says which automations are live schedules and which runs came from a fire.
3. Replay a missed fire when the worker comes back. A replay can send the same email or message twice, and a late run at the wrong hour can be worse than none.

## Decision

Option 2, in `apps/worker/src/watchdog.ts`, run by the worker every 60 seconds.

- The due fire is the latest cron time (UTC, as pg-boss schedules it) at least 15 minutes old. The grace covers pg-boss's one-minute cron check and a busy worker.
- An automation is missed when that fire is later than its live version's publish time and no real run with `firedAt` in its trigger payload was created since. Manual runs and previews do not count, because they would hide a broken schedule.
- "Good run" means the schedule fired and a run exists. A run that then fails is shown as Problem by the existing logic, not as a missed schedule.
- Migration 0028 adds `workflows.schedule_missed_at` (the flag, cleared when the fire is covered or the automation stops being a live schedule) and `workflows.schedule_alert_at` (when the owner was last emailed).
- The Automations card shows "Missed its schedule", and the Problem filter and ordering treat it as a problem unless the last run needs the owner.
- The email goes to the owner through the same sender as every other email (`sendAs`), in the workspace language. A conditional UPDATE on `schedule_alert_at` lets one worker send, at most once per 24 hours per automation, and the time stays when the flag clears, so a flag that comes back the same day sends nothing. A failed send gives the claim back, so the next check retries.
- It reports only. It never replays a missed run.

## Consequences

- A cron that pg-boss fires but the worker skips because of the plan's minimum interval (`tooSoon`) would look missed. Publishing already refuses a cron faster than the plan allows, so this does not happen in normal use.
- Crons are UTC, like the schedule itself.
- A worker that is down cannot send the email. The check and the email happen on the first tick after it starts, so the owner hears about it then.
- The check reads every live workflow once a minute. That is cheap at this scale. Page through the rows if one installation reaches tens of thousands of live automations.
