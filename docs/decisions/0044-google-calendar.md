# 0044: Google Calendar events that follow a booking

## Context

N13 asks for a calendar event made from a booking, moved when the booking is rescheduled, removed when it is cancelled, with reminders stopping for a cancelled booking. Bookings, their versions and the stop of runs for a changed booking exist (decision 0032). Sheets already uses a pasted service account and a delivery with pinning and retry (decision 0021 and N2b). Daloy stays free to run, so no Google OAuth app review.

## Options

1. Three steps (create, update, cancel event) that the workflow author places.
2. One step that records "this booking has an event", and the booking's own changes keep the event in line.
3. OAuth with each owner's Google sign-in. Needs Google's app verification for the Calendar scope.

## Decision

Option 2, with a service account like Sheets.

- Connection: `google_calendar`, a service account key file (the same `serviceAccountSchema`) and a calendar id. `PUT /settings/connections/google-calendar { serviceAccount, calendar }` reads the calendar (`events.list`, scope `calendar.events`) to prove access, then saves the account and `{ calendarId, title }`, encrypted like Sheets. The owner shares the calendar with the service account's address ("Make changes to events"). `POST .../google-calendar/test` creates and deletes a one-hour event. One calendar per workspace, as with Sheets.
- Step: `calendar` with a `title` and an optional `description` template, placed after the booking step. It writes `calendar_events (booking_id, user_id, title, description)` for the run's booking and queues a delivery. A test run, and a booking made by one, are mocked and reach no calendar. Without a booking in the run it fails with a plain message.
- Exactly once: the event id is derived from the booking, `dl` plus the first 40 hex characters of sha256(booking id), which is valid Calendar id syntax (a to v, 0 to 9). Google refuses a second insert of an id with 409. Nothing else identifies the event, so no id is stored.
- Every calendar delivery means "make the calendar match the booking as it is when this is sent" and reads the booking then. Active: `events.insert` with the derived id; a 409 means it exists, so `events.patch` the title and times with `status: confirmed` (which also restores one deleted by hand). Cancelled: `events.delete`; 404 and 410 mean it is already gone. Each branch repeats safely, so deliveries that arrive late, twice or out of order end in the same state, and a request whose answer was lost is simply sent again. An ambiguous answer queues again (like Sheets) and never asks a person.
- A cancel has no run of its own and a reschedule's new run starts after the booking step, so the booking change queues the sync itself: `bookFromStep` and `staffChange` call `queueCalendarSync` in the transaction that changes the version. When the booking has a `calendar_events` row it inserts one delivery `calendar:v<version>` on the run that made the change (the booking's latest run for a staff cancel). The delivery's unique key (run, step) makes it one per version.
- The booking-moved check of decision 0032 does not apply to calendar deliveries, since the changed booking is what they sync. Retry and Post again stay available for them.
- Times: UTC `dateTime` and the booking's own IANA zone as `timeZone`, so Google shows the guest's wall time. Title and description are plain text from the templates, resolved when the step runs. A rescheduled run runs the step again with its own resolved text.
- Reminders: unchanged. A run waiting on a reminder is linked to the booking version and stops when it wakes (decision 0032). A cancel supersedes every run linked to the booking, so no reminder goes out, and the event is deleted.
- Migration 0025 widens the two provider checks and adds `calendar_events`. The base URL is `GOOGLE_CALENDAR_URL` (env only, default `https://www.googleapis.com`).

## Consequences

- No attendees and no Meet links: a service account cannot invite people without domain-wide delegation, so the guest still gets the confirmation from the email or Telegram step. Events appear only on calendars shared with the service account.
- An event someone edits by hand is put back in line the next time the booking changes. One deleted by hand is restored then.
- A booking whose last run was deleted gets no sync on cancel, and its event stays (a delivery needs a run). Runs are not deleted in normal use.
- The first insert after a lost answer costs one extra call (409, then patch).
- Migration numbering: 0025, since 0024 belongs to N8. The 0025 snapshot was generated from the 0023 snapshot, so after N8's 0024 lands, its `prevId` needs pointing at 0024's id.
