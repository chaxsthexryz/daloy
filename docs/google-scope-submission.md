# Google sensitive scope submission pack

This is what the owner submits to Google so that Gmail and Calendar through "Connect with Google" can be offered to customers on the production client. It covers plan section 8 steps 5 to 7 and plan section 12 phase P8. Sheets and Drive do not need it.

Tags used here: **confirmed** means a Google page said it in search results on 19 November 2026 (the pages were found through search, not opened directly); **unverified** means no current Google page confirmed it. Read the Verification Center in the Cloud Console before submitting, because it is the authoritative version and may differ from this file.

## 1. What is submitted

The production project (`daloy-prod` in [oauth setup](oauth-setup.md) section 5.2) requests exactly the scopes in the in-code manifest. `packages/db/src/oauth/scopes.test.ts` fails if the code asks for anything else, so the consent screen list and this table must match it.

| Scope | Used by | Class | Needs this submission |
|---|---|---|---|
| `openid`, `email` | Every Google connection: the account id (`sub`) and address shown on the card | Non-sensitive | No |
| `https://www.googleapis.com/auth/drive.file` | Sheets and Drive: rows and files go only to a sheet or folder Daloy created or the owner picked | Non-sensitive (confirmed in plan section 8) | No |
| `https://www.googleapis.com/auth/gmail.send` | Gmail sender: the owner's automation email is sent from their own address | Sensitive (confirmed in plan section 8) | Yes |
| `https://www.googleapis.com/auth/calendar.app.created` | Calendar: bookings become events on a calendar Daloy creates, "Daloy bookings" | Unverified. Google's scope list describes it as making secondary calendars and changing events on them, and does not show its class in a column. The console shows the class when the scope is added. | Yes, if the console lists it as sensitive |

Not requested, and refused by the scope test: `https://mail.google.com/`, `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.metadata`, full `drive` and its read and metadata variants, `calendar.events`, `calendar.calendarlist.readonly`. The restricted ones need a paid security assessment every 12 months (plan section 9), which this project avoids.

## 2. Before submitting

- [ ] The production domain is verified in Search Console and set as the authorized domain ([oauth setup](oauth-setup.md) 5.2 step 3).
- [ ] Brand verification is approved (2 to 3 business days, confirmed in plan section 8).
- [ ] The homepage is live on that domain and explains each Google feature in the table above.
- [ ] The privacy policy is on the same domain as the homepage, linked from the homepage and from the consent screen, and both links point to the same page (confirmed). It says how Daloy reads, uses, stores and shares Google user data (confirmed). Section 5 below lists what Daloy does, so the policy can be checked against it.
- [ ] Terms of service are live and linked.
- [ ] The consent screen scopes match section 1 exactly.
- [ ] P5 (Gmail) and P6 (Calendar) run on the staging host with the production client, and the [live Gmail check](live-gmail-oauth-check.md) and [live Calendar check](live-calendar-oauth-check.md) have passed there.
- [ ] Every OAuth client in the production project appears in the demo video (confirmed: the video must cover all clients assigned to the project). Delete unused clients first.

## 3. Scope justifications

Paste these into the submission form, one per scope, and edit them to match the homepage wording. Google expects the narrowest scope that works and may reject a scope broader than the feature needs (confirmed), so each text names the narrower and broader options.

### gmail.send

Daloy runs small offices' automations, such as replying to an inquiry, confirming a booking or asking a manager to approve a request. The office owner can choose to send these emails from their own Gmail address instead of a shared mail server. Daloy uses `gmail.send` to send each email through the Gmail API `users.messages.send`, only when one of the owner's automations sends one, and only from the address that signed in. Daloy never reads, lists, searches, modifies or deletes mail, and asks for no other Gmail scope. Sending through SMTP with OAuth would need `https://mail.google.com/`, which also allows reading all mail, so it is not used. The owner can disconnect at any time in Daloy, which deletes the stored grant and asks Google to revoke it.

### calendar.app.created (only if the console lists it as sensitive)

Daloy takes bookings for small offices (a dental clinic, a salon). When the owner connects Google Calendar, Daloy creates one secondary calendar named "Daloy bookings" in the owner's account and adds an event there for each confirmed booking. The event moves when the booking is rescheduled and is deleted when the booking is cancelled. Daloy uses `calendar.app.created` because it reaches only calendars Daloy created: Daloy cannot see or change the owner's other calendars. Daloy does not request `calendar.events` or `calendar.calendarlist.readonly`, which would reach every calendar. Events hold the customer's name, the booking reference and the time. The owner can disconnect at any time, which deletes the stored grant and asks Google to revoke it; the "Daloy bookings" calendar stays in their account for them to keep or delete.

## 4. Demo video script

Google asks for a video that shows the whole flow including the OAuth grant, the same app as submitted, the complete consent screen with the exact scopes, and how each scope is used (confirmed). Upload it to YouTube as Unlisted and paste the link in the form (confirmed). Keep the consent screen in English (confirmed). Record on the staging host with the production client and synthetic customer data only. Never show a token, a callback address with its `code` or `state` in it, or a real customer's details: pause the recording or crop the address bar during the redirect.

1. Show the homepage on the production domain and its link to the privacy policy. About 10 seconds.
2. Sign in to Daloy as the office owner. Open Apps, then Gmail.
3. Press "Connect Gmail with Google". Show the Google account chooser and the whole consent screen: the app name, the developer email and the `gmail.send` line. Hold on the consent screen for a few seconds. Press Allow.
4. Back in Daloy, show the Gmail card saying it is connected with the Google address.
5. Select "Send a test email to me" on the card. Switch to that Gmail account and show the email arriving, sent from the owner's address.
6. Run an automation that sends an email (a booking confirmation from the demo workflow) and show it arriving. Say that Daloy cannot read the inbox.
7. Open Apps, then Google Calendar. Press "Connect with Google" and show the consent screen with the Calendar line. Press Allow.
8. Show the card naming the "Daloy bookings" calendar. Open Google Calendar in the same account and show the new calendar in the side list.
9. Make a booking in Daloy. Show the event appear on "Daloy bookings". Reschedule it and show the event move. Cancel it and show the event disappear.
10. Show that the owner's main calendar has no new events.
11. Disconnect Gmail and Calendar in Daloy and show the cards return to their Connect buttons. Open the Google account's third party access page and show Daloy's access removed (or explain that the owner removes it there if Google still lists it).

Steps 7 to 10 are needed only if `calendar.app.created` is in the submission.

## 5. Google user data: what Daloy does with it

For checking the privacy policy and for reviewer questions. Every line is how the code on branch `oauth-p8-integration` behaves, checked in this review.

- Read: the signed-in account's id (`sub`), email address and whether Google verified it. Nothing else is read from Gmail. From Calendar, only the calendar Daloy created and its events.
- Written: emails the owner's automations send; events on "Daloy bookings"; rows and files in sheets and folders Daloy created or the owner picked (Sheets and Drive, not part of this submission).
- Stored: the access and refresh tokens in one AES-256-GCM encrypted value bound to the workspace, the account id and address, the granted scopes and the OAuth client id. Tokens are never returned by the API, never logged, and replaced with `[secret]` in run history, Activity, CSV exports and the delivery list.
- Shared: with nobody. Google user data is not sent to the AI features (the explain and Ask prompts are built from a closed list of run facts) and is not used to train any model.
- Kept: until the owner disconnects or deletes the workspace. Disconnect deletes the grant first, then asks Google to revoke it within 5 seconds and tells the owner when the revoke did not happen.

## 6. After submitting

- Review is up to 10 business days (confirmed). Plan for at least one round of questions; how long a round adds is unverified.
- Until approval, an unverified app that requests sensitive scopes is capped at 100 users (confirmed), so keep Gmail and Calendar sign-in for test users only.
- Answer from the support email on the consent screen. Keep the answers consistent with sections 3 and 5.
- On approval, record the date and the approved scopes in [oauth setup](oauth-setup.md) section 5.3 and here.
- A new Google scope later needs approval before it can be called (confirmed in plan section 8). `scopes.test.ts` fails until the manifest, the decision record and this pack are updated together.

## 7. Still unverified

- The class of `calendar.app.created`. Check it in the console's data access page.
- Whether a submission with only non-sensitive scopes (Sheets and Drive) shows an unverified app warning or a user cap (plan section 15 item 1).
- Whether `pages.dev` can be the authorized domain (plan section 15 item 8; probably not).
- Whether Google's revoke also ends another Daloy workspace's access when two workspaces connected the same Google account (plan R14, [live Google OAuth check](live-google-oauth-check.md) step 11).

Sources: [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), [Verification requirements](https://support.google.com/cloud/answer/13464321), [Demo video](https://support.google.com/cloud/answer/13804565), [Submitting your app for verification](https://support.google.com/cloud/answer/13461325), [OAuth 2.0 scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes), [Choose Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth).
