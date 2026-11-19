# Manual live check: Google Calendar through Connect with Google

The automated tests never contact Google. They use the fake Google OAuth app and the Calendar fake in `test/fake-providers.ts`, which lets a Google sign-in reach only calendars it created through `calendars.insert`, the way `calendar.app.created` is expected to work. Each behavior below is unverified until someone runs this page against a real Google account and records the result ([decision 0064](decisions/0064-calendar-oauth.md)).

Status: not run yet. Record the date, the Daloy commit and what you saw under Results when you do.

## Before you start

- The `daloy-dev` Google Cloud project from [the Sheets and Drive check](live-google-oauth-check.md), with the Google Calendar API turned on, the consent screen in Testing and your Google account listed as a test user. The same OAuth client and redirect URI work; Calendar is one more grant.
- On the consent screen's Data access page, add `calendar.app.created` and look at the label Google shows next to it (non-sensitive, sensitive or restricted). Write it down under Results before step 1. Do the same for `calendar.events` and `calendar.calendarlist.readonly`, which Daloy does not ask for: if either is restricted, existing-calendar mode must not be built.
- In `.env`: `OAUTH_ENV=development`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`. Type the values yourself; never paste them into a chat, an issue or a commit.
- Daloy running on `http://localhost:3000` with a test workspace. Do not use a workspace that holds real QA data you need.
- A second Google account for step 8.

## Steps

1. Consent. Open Apps, then Google Calendar, and select Connect with Google. Expect Google's consent screen to name your dev app, ask to see your email address and to create secondary calendars and manage events on them, and nothing more. Note whether Google shows an "unverified app" warning. Allow. Expect "Google Calendar is connected.", your address, and "Events go to Daloy bookings".
2. The calendar. Open Google Calendar as yourself. Expect a calendar named "Daloy bookings" in your list and none of your other calendars changed. Note its time zone (Daloy sends each event with the booking's own zone).
3. Test event. Select Add a test event. Expect "Google Calendar accepted a test event" and the event gone again. This is the first proof that `calendar.app.created` allows `events.insert` and `events.delete` with a chosen event id on that calendar.
4. A booking. Publish an automation with a booking step followed by a Calendar step, and send one request. Expect one event on "Daloy bookings" at the booked time in the booking's zone, with the title and description from the step. Reschedule the booking in Bookings and expect the same event to move (this checks `events.patch`). Cancel it and expect the event to be removed.
5. Reconnect with the same account. Select Reconnect Google Calendar and allow again. Expect the same "Daloy bookings" calendar (no second one in Google Calendar) and new bookings still landing there.
6. Disconnect and connect again. Select Disconnect, expect the card to return to Connect with Google with no warning about revoking, and open https://myaccount.google.com/permissions to see whether your dev app is gone. Connect again with the same account. Disconnect deletes the connection and its calendar id, so expect Daloy to make a second "Daloy bookings" calendar and the first to stay in your Google Calendar with its events. Note whether Google lets the new grant write to the first one (it should not: it was created by an earlier grant, which is unverified).
7. A calendar deleted by hand. In Google Calendar delete "Daloy bookings". Send a booking. Expect the delivery to fail with "Daloy cannot open its calendar... choose Create a new Daloy calendar" and the connection to stay Connected. Select Create a new Daloy calendar, confirm, and retry the delivery from Activity. Expect it held for review ("the calendar connection changed"), because the calendar id differs; choose Post again and expect the event in the new calendar. Note the HTTP status Google gave (403 or 404), which `calendarFailure` treats the same.
8. Another Google account. Reconnect with the second account. Expect the destination cleared and a new "Daloy bookings" calendar in that account. A booking made before the switch and then rescheduled should stop in review and say its event is still in the old calendar.
9. Granular consent. Disconnect and connect again, and untick the Calendar permission if Google offers a checkbox. Expect "Some of the permissions Daloy asked for were not allowed" and nothing connected.
10. Service account. Under Advanced, connect with a service account key and a calendar shared with it, as before. Expect the old behavior: events in that calendar and the address to share it with in any error.
11. Expiry in Testing. Refresh tokens of a project in Testing last seven days. After seven days add a test event and expect "Reconnect Google Calendar" with the connection marked as needing reconnecting.

## Results

Not run yet.
