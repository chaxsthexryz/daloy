# 0129: Google Workspace triggers (Sheets row, Calendar event, Drive file)

## Context

G2 adds three triggers that reuse the Google connections the owner already made in Apps:

- `sheets_row`: a new row in a chosen tab of the spreadsheet picked for Google Sheets.
- `calendar_event`: a new event, or an event about to start, in the calendar chosen for Google Calendar.
- `drive_file`: a new file in the folder chosen for Google Drive.

Each Daloy app keeps its own Google grant with the narrowest scope it needs (decision 0060): `drive.file` for Sheets and Drive, `calendar.app.created` for Calendar (decision 0064). Restricted scopes such as `drive.readonly` need a paid security assessment and are in `FORBIDDEN_SCOPES`.

The user asked for this phase overnight, so this record holds the plan as well as the decision.

## Plan

- Engine: three trigger types in `definition.ts`, catalog entries, AI draft lines, editor sample payloads and fields.
- DB: migration `0056_trigger_polls`, one row per watching workflow: what it watches (`source`), its `cursor`, `next_poll_at`, `failures`, `problem`, `last_polled_at` and a short `claim_until`.
- DB: `google-triggers.ts`. Pure parts (tested first): the scope and connection check, the first-poll rule, the row and "created since" cursors, the "starting soon" window, the run keys, backoff and the self-loop check. Then the poll itself, which reads Google through `withGoogle` (token refresh unchanged).
- Worker: a timer that polls due rows, like email intake.
- API: `GET /triggers/google/:type` tells the editor whether the connection is ready and, for a saved automation, what the watcher last did. Publish refuses a Google trigger whose app is not connected with a destination.
- Web: trigger picker entries and inspector settings (tab dropdown, event mode, file rule), with the readiness note.
- Tests: unit tests for the pure parts, DB tests for dedupe across polls, API integration tests and one Playwright test, all against `test/fake-providers.ts`.

## Options

1. Push: Drive `changes.watch` and Calendar `events.watch` channels. Google sends notifications only to an HTTPS address with a valid certificate, channels expire (a day for Drive files, a week for Drive changes) and must be renewed, and Sheets has no push for rows at all. A laptop running `docker compose up` has no such address.
2. Polling for all three. Works locally and on any host, one code path, and the cost is a read per watching automation per interval.
3. Push where possible with polling as the fallback. Two code paths to test for a small latency gain.

## Decision

Option 2, polling only. Push can be added later for Calendar and Drive on hosted installs without changing the trigger configs.

- Interval: every 5 minutes, or the plan's minimum schedule interval when that is longer (Preview and Pilot: 60, Business: 15), the same rule as schedule triggers. A failed read backs off: 5 minutes doubled per failure, at most an hour, or Google's Retry-After when longer.
- One run per item: each item starts its run through `createKeyedRun` with a stable key, so a retry, a second worker or a poll repeated after a crash finds the existing run (`run_keys`, decision 0029). The cursor moves only after the runs are created.
  - Sheets: `sheets:<spreadsheet>:<tab>:<row number>:<hash of the row>`. The cursor is the row count. Rows are read with `values.get` on the whole tab, at most 50 new rows start runs per poll.
  - Calendar new event: `gcal:<calendar>:<event id>:created`, read with `updatedMin` and filtered on `created`.
  - Calendar starting soon: `gcal:<calendar>:<event id>:starting:<start>`, so a moved event reminds again.
  - Drive: `gdrive:<file id>`, read with `createdTime >=` the cursor, at most 10 files a poll (each may be downloaded).
  - Time cursors step back 2 minutes on each poll to cover clock skew; the keys make the overlap harmless.
- First poll: it only records where things stand (row count, or the time) and starts no run, so turning a trigger on never replays history. Changing the watched tab, calendar, folder or mode starts over with a new first poll.
- Connection and scopes: before each poll Daloy checks that the app is connected, active, has a destination and, for a Google sign-in, that the stored grant holds the scope (`drive.file` or `calendar.app.created`). The problem names the app to reconnect in Apps and the permission to leave ticked on Google's consent page. A service account key has no stored scopes and is checked by the read itself.
- Paused with a reason: a missing or broken connection, a refused sheet, folder or calendar, or a self-loop sets `problem` and checks again every 5 minutes, so the watcher resumes by itself once the owner fixes it. Items added meanwhile then start their runs; nothing before the first poll does.
- Self-loops: a `sheets_row` automation with an Add to Google Sheets step on the same tab, or a `drive_file` automation that saves files to Drive or makes a document, would start itself again. The poll pauses it with that reason.
- Drive files: the file starts its run with its name, type, size and link. Its contents come along as the upload field `file` (for AI and Drive steps) only when Drive reports a size up to 5 MB and the bytes are a JPEG, PNG, WebP, HEIC or PDF, the same limits as form uploads, and the workspace has upload quota left. Otherwise `fileSkipped` says why. With `requireFile` such a file starts no run.

## Consequences

- With a Google sign-in, `drive.file` lets Daloy see only files it created or that were picked in the Picker. A file someone drags into the folder in Drive is not visible, so with a Google sign-in `drive_file` fires for files Daloy itself saved there (for example by another automation's Save to Drive step). A service account key shared on the folder sees every file. Whether a picked folder grants access to files added later is not stated in Google's docs; we treat it as no.
- With a Google sign-in, Calendar sees only calendars Daloy created (the "Daloy bookings" calendar). Events the owner adds there in Google Calendar do start runs.
- Sheets: a deleted row lowers the count and is not a new row. A row typed while a poll runs can start its run before every cell is filled. Row 1 is read as headers for `{{trigger.cells.<header>}}`.
- Calendar "starting soon" skips all-day events and events that already started.
- Up to one interval of delay. Polling costs one Google read per watching automation per interval, well within Google's free quotas.
- New table `trigger_polls` (migration 0056). It holds no credentials.
