# Manual live Google Sheets and Slack check

The automated tests never contact Google or Slack. They use `test/fake-providers.ts`, a local server that checks the service account's JWT signature, keeps sheets and channels in memory, and can answer with 401, 403, 429, a revoked token, or a timeout after accepting a write. This page is the separate check against real accounts. Run it by hand with accounts you control.

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
