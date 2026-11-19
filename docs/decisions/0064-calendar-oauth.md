# 0064: Google Calendar through "Connect with Google", in a calendar Daloy creates

## Context

Phase P6 of the managed OAuth plan ([docs/plans/managed-oauth-plan.md](../plans/managed-oauth-plan.md), sections 3, 6.2, R7, R8 and open questions 4 and 7) replaces the service account key and the typed calendar id as the main way to connect Google Calendar. Today an owner makes a Cloud project, a service account and a key, pastes the file, and shares a calendar with the account's address ([decision 0044](0044-google-calendar.md)). The shared OAuth core ([decision 0058](0058-oauth-core.md)) and the Google module ([decision 0060](0060-google-oauth.md)) are in place. The owner approved the plan's recommended answers: Daloy creates its own calendar by default (question 4), and a destination provider such as Calendar proceeds when the destination is the same after re-authorization (question 7).

## Options

Scope:

1. `calendar.events` for the owner's existing calendar, with `calendar.calendarlist.readonly` to list them.
2. `calendar.app.created` only. Daloy creates a calendar and works only on calendars it created.

Existing-calendar mode as a second, explicit consent: build it, or leave it out.

Pinning when the credential changes:

1. Compare account and destination, as for every provider before 0060.
2. For a Google sign-in compare only the calendar id. For a service account keep comparing the account.

## Decision

- **Scope: option 2.** `GOOGLE_FEATURE_SCOPES.calendar` is `https://www.googleapis.com/auth/calendar.app.created`, asked for with `openid email` through `googleProvider("calendar", "google_calendar", "google-calendar", "Google Calendar")`. It is in `OAUTH_PROVIDERS`, so start, callback, refresh, keepalive, revoke and the history hider apply. `calendar.app.created` must come back granted or nothing is saved. `scopes.test.ts` asserts the row and that `calendar.events`, `calendar.calendarlist.readonly` and `calendar` are not asked for.
- **Existing-calendar mode is not built.** Its class could not be settled (see Sources), so the plan's rule "do not request it if it turns out to be restricted" cannot be shown to pass. It would also need the core to remember which consent a flow started, because a flow stores only the provider and the callback reads the definition by provider, so a second set of scopes for the same `google_calendar` row would be refused as `missing_scope`. An owner who wants an existing calendar uses the service account form under Advanced, as before. To add it later: read the class of `calendar.events` and `calendar.calendarlist.readonly` on the consent screen's Data access page in the Cloud console, then add a feature row, a flow variant in `oauth_flows`, a calendar list route and a picker, and update `scopes.test.ts` and the Google submission together.
- **One set of Calendar calls.** `calendarInfo`, `calendarWriteTest` and `syncCalendarEvent` take a `GoogleAuth`: a service account (JWT grant, cached token, 401 retried once, messages that name the address to share with, all as before) or `{ accessToken }` made fresh by `withFreshToken`. With an access token a 401 is an `auth` error so the core refreshes once, and a 403 or 404 is a `permission` error that says to create a new Daloy calendar. `withGoogle` now also serves `google_calendar`. `deliveries.ts` calls it, so the choice follows the connection's `auth_method`, and `attempt()` already refreshes before the booking-lock transaction opens.
- **Easy connect.** `ensureCalendar` (`packages/db/src/google-calendar.ts`) creates a calendar named "Daloy bookings" with `calendars.insert` and stores `{ calendarId, title }` as the destination. The shared callback runs it right after a successful consent for `google_calendar`; if Google refuses, the connection stays without a destination and the card offers "Create the Daloy bookings calendar" (`POST /settings/connections/google-calendar/create`, owner only, 5 a minute). A destination already there is kept, so the calendar is made once: a reconnect with the same Google account keeps the destination (core rule), a different account clears it and gets a new calendar, and the old one keeps its events. `{ "again": true }` makes a new calendar for one deleted by hand. The save is guarded by the account's `external_id`, because a refresh changes the credential revision. The existing "Add a test event" button proves write access.
- **M11 and M12 are unchanged.** An event is still bound to the account and calendar of its last write (`calendar_events`), and `queueSync` still pins a delivery to that. A different calendar id still goes to review. Writes for one booking are still ordered by the share lock on the booking row, held until Google answers.
- **Pinning (R7): option 2.** `destinationOnly` includes `google_calendar` only while the connection is a Google sign-in. A Google sign-in can reach only calendars Daloy created, so the calendar id is what decides where an event lands, and the same id after re-authorization sends without review, even if the Google address changed. A service account keeps comparing the account, so its behavior and tests are unchanged. A reconnect with another Google account clears the destination, the new calendar has another id, and the existing review applies. Until the new calendar exists, a delivery fails as "no calendar chosen" and keeps its payload.
- **Lost calendar.** If the owner deletes the calendar in Google Calendar, deliveries fail with kind `permission` and a plain message to create a new one. The connection stays active.
- **UI.** `GoogleCalendarCard` (`apps/web/src/GoogleCalendar.tsx`) uses `ConnectPanel` with "Connect with Google" first. The service account form and calendar id are under Advanced (`CalendarConnection` gains an `embedded` mode). Without `GOOGLE_OAUTH_CLIENT_ID` the service account form is the whole card. English and Tagalog strings are in `apps/web/src/lib/locale-calendar.ts`.
- **No new dependency.**

## Consequences

- A Google sign-in sees only the calendar Daloy created. The owner's other calendars are out of reach, which is the point of the narrow scope.
- Events appear in a calendar called "Daloy bookings". The owner shares it from Google Calendar if staff need to see it. No attendees are invited, as before.
- Creating the calendar is not idempotent: a lost answer or two simultaneous presses can leave an unused "Daloy bookings" calendar in the owner's account.
- Replacing a Google sign-in with a service account key (Advanced) does not revoke the Google grant. Disconnect does.
- Calendar goes to customers only after Google's sensitive scope review, if `calendar.app.created` is sensitive (plan section 8, unverified).

## Sources and what stays unverified

Checked on 19 November 2026 with web search in standard mode. The fetch tool could not resolve `developers.google.com` in this session, so no Google page was read in full and the class of each scope was not found.

- [Google OAuth 2.0 scopes](https://developers.google.com/identity/protocols/oauth2/scopes) and [Calendar API authorization](https://developers.google.com/calendar/api/auth): the search summaries describe `calendar.app.created` as "create secondary calendars and manage events on calendars created by the app" and `calendar.calendarlist.readonly` as viewing the user's calendar list. They gave no sensitive or restricted label for any of the three scopes, and `calendar.events` came back with no description.
- [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification): gives reading events in Google Calendar as an example of a sensitive scope. It does not name the three scopes.
- Third party pages ([Easy Appointments thread](https://groups.google.com/g/easy-appointments/c/cDp9ukYBlik), [a scope list](https://damln.com/tools/resources/google-workspace-permissions), [Nango](https://nango.dev/docs/integrations/all/google-calendar)) were returned but not read; they are not evidence.

Still unverified, to settle in [the live check](../live-calendar-oauth-check.md) and the Cloud console before customers use it: whether `calendar.app.created` is sensitive (so the review in plan section 8 applies) and that none of the three is restricted; that Google lets `calendar.app.created` call `calendars.insert`, `events.insert` with a chosen id, `events.patch` and `events.delete` on the calendar it created (the code and the fake assume it); that a calendar made by Daloy keeps working after a disconnect and reconnect with the same account; that the 403 or 404 a deleted calendar gives is what `calendarFailure` expects; and the consent screen wording. Every behavior here was tested only against `test/fake-providers.ts`; no Google endpoint was contacted.
