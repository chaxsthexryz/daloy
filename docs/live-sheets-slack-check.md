# Manual live Google Sheets and Slack check

The automated tests never contact Google or Slack. They use `test/fake-providers.ts`, a local server that checks the service account's JWT signature, keeps sheets and channels in memory, and can answer with 401, 403, 429, a revoked token, or a timeout after accepting a write. This page is the separate check against real accounts. Run it by hand with accounts you control.

For Connect Slack (the OAuth install), see [live Slack install check](live-slack-oauth-check.md). This page covers the pasted bot token.

Status: not run yet. Record the date, the Daloy commit and what you saw at the end of this file when you do.

## Before you start

- A Google Cloud project (no billing needed) with the Google Sheets API turned on, a service account, and a JSON key for it.
- A Google Sheet with a tab called `Requests`, shared with the service account's email as an Editor.
- A Slack workspace where you can install apps. Create an app, add the bot scopes `chat:write` and `channels:read`, install it, and copy the Bot User OAuth Token. Add the app to a public channel with `/invite`.
- Daloy running with `docker compose up` and seeded.

## Steps

1. Sign in, open Business and email, paste the key file, the sheet link and `Requests`, and select Connect Google Sheets. Expect the sheet's title and tab.
2. Select Add a test row. Expect a row starting with `TEST-` in the sheet.
3. Paste the bot token and select Connect Slack. Expect the workspace name. Pick the channel, save, and select Send a test message. Expect the message in the channel.
4. Set up an office request with both options ticked, turn it on, and send a request through the form. Expect one row starting with the reference, and one note with the reference and subject and no name or email.
5. Remove the app from the channel (`/remove`). Send another request. Expect the row in the sheet, and the Slack note failed with "The Slack app is not in that channel". Add the app back and select Retry. Expect one note, and no second row.
6. Remove the service account's access to the sheet. Send a request. Expect the sheet row failed with "Share the sheet with ...", and the Slack note posted. Share it again and select Retry.
7. Delete the service account key in Google Cloud. Send a request. Expect "Google rejected the service account key" and the connection marked as needing reconnecting.
8. Revoke the Slack token (reinstall the app or revoke it in the app settings). Send a request. Expect "Slack no longer accepts the app's token".

9. Duplicate refusal while the marker exists (decision 0021): send one request, then in Google Sheets open Extensions > Apps Script or the API explorer and confirm one developer metadata entry with key `daloy` exists on the tab, and that the row appears once. Run the delivery again from the database (set `state = 'queued', check_first = true` for that delivery) and confirm no second row appears and the delivery says "already in the sheet".
10. Reconnect to a different sheet while a delivery is queued (stop the worker first). Start the worker. Expect review with both sheets named and no row in either. Choose Post again and expect one row in the new sheet.
11. After 24 hours (or after moving `updated_at` back), confirm the worker removed the metadata entry of a delivery that went through on its first attempt, kept the entry of the delivery from step 9 (it had an uncertain attempt), and that metadata another tool wrote on the same tab under a different key is still there.

## Results

None recorded yet.

## Telegram (N14)

Not run yet. The automated tests use a fake Bot API.

1. In Telegram, message @BotFather, send /newbot, and copy the token. Add the bot to a test group and send any message there.
2. Find the chat id: open `https://api.telegram.org/bot<token>/getUpdates` in a browser and read `chat.id` (a group's is negative). Do not share that address: it contains the token.
3. In Apps, open Telegram, paste the token and chat id, select Connect Telegram. Expect the bot name and the group name. Select Send a test message. Expect it in the group.
4. Add a Telegram step to an automation, turn it on, and run it. Expect one message and a delivered state on the request.
5. Remove the bot from the group and run again. Expect the delivery failed with "The bot cannot message that chat". Add it back, select Retry, expect one message.
6. In BotFather send /revoke, then run again. Expect "Telegram no longer accepts the bot token" and the card showing Needs reconnecting.

## Google Calendar (N13)

Not run yet. The automated tests use a fake Calendar API. You need a Google Cloud project with the Calendar API turned on, a service account with a JSON key (the Sheets one works), and a test calendar.

1. In Google Calendar, create a test calendar. In its settings, share it with the service account's email and choose Make changes to events. Copy its calendar id (Integrate calendar).
2. In Apps, open Google Calendar, paste the key file and the calendar id, select Connect Google Calendar. Expect the calendar's name. Select Add a test event. Expect "Google Calendar accepted a test event" and no test event left on the calendar.
3. Build an automation with a booking step and, after it, an Add to Google Calendar step (title "Massage for {{trigger.guest}}"), turn it on, and make a booking. Expect one event on the calendar at the booked time, in the time zone you chose. The request shows the delivery as delivered.
4. On Bookings, reschedule it. Expect the same event, not a new one, at the new time.
5. Cancel it. Expect the event to disappear, and no reminder email for it.
6. Stop sharing the calendar and make another booking. Expect the delivery failed with the address to share the calendar with. Share it again and select Retry. Expect one event.

## Airtable, Notion and Trello (N15)

Not run yet. The automated tests use fakes. Also confirm here what the docs left open: Notion's database read with version 2022-06-28 still works, Trello's key and token as query parameters still work, and each free plan allows the API.

1. Airtable: create a token at airtable.com/create/tokens with data.records:read and data.records:write on one test base. In Apps, open Airtable, paste the token, the base id (app...) and the table, select Connect Airtable, then Check the connection. Expect it to pass.
2. Notion: create an internal integration, share a test database with it (Connections menu on the database). In Apps, paste the secret and the database link, select Connect Notion, then Add a test page. Expect the page in the database.
3. Trello: get the API key and a token at trello.com/power-ups/admin, and a list id (add .json to a card link, read idList). In Apps, paste them, select Connect Trello, then Add a test card. Expect it on the list.
4. Add a step of each kind to an automation with field names that match your table and database, turn it on, and run it. Expect one record, page and card, and delivered on the request.
5. Use a field name that does not exist. Expect a failed delivery with "refused the request" and no retry.
6. Revoke each token, then run again. Expect "no longer accepts the saved token" and Needs reconnecting.
