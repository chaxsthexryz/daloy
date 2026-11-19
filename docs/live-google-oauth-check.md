# Manual live check: Google Sheets and Drive through Connect with Google

The automated tests never contact Google. They use the fake Google OAuth app and the Sheets and Drive fakes in `test/fake-providers.ts`, which follow `drive.file` the way the plan expects it to work. Each behaviour below is unverified until someone runs this page against a real Google account and records the result ([decision 0060](decisions/0060-google-oauth.md)).

Status: not run yet. Record the date, the Daloy commit and what you saw under Results when you do.

## Before you start

- The `daloy-dev` Google Cloud project with the OAuth consent screen in Testing, your Google account listed as a test user, and an OAuth client of type Web application with the redirect URI `http://localhost:3000/settings/connections/oauth/callback`.
- The Google Sheets API, the Google Drive API and the Google Picker API turned on in that project.
- A browser API key restricted to the HTTP referrer `http://localhost:3000/*` and to the Picker API, and the project number from the project's dashboard.
- In `.env`: `OAUTH_ENV=development`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`. Type the values yourself; never paste them into a chat, an issue or a commit.
- Daloy running on `http://localhost:3000` with a test workspace. Do not use a workspace that holds real QA data you need.
- A second Google account for step 10, and a second Daloy workspace for step 11.

## Steps

1. Consent. Open Apps, then Google Sheets, and select Connect with Google. Expect Google's consent screen to name your dev app, ask to see your email address and to "See, edit, create and delete only the specific Google Drive files you use with this app", and nothing more. Note whether Google shows an "unverified app" warning (plan section 15 item 1). Allow. Expect "Google Sheets is connected." and your address.
2. Narrower grant. Disconnect, connect again, and untick the Drive permission if Google offers a checkbox. Expect "Some of the permissions Daloy asked for were not allowed" and nothing connected. Connect again with everything allowed.
3. Create a sheet. Select Create a sheet for me. Expect a spreadsheet named "Daloy requests" in your My Drive and the tab list showing its tab. Select Add a test row and expect a row starting with `TEST-`.
4. Markers under `drive.file`. Set up an office request with "A row in your Google Sheet", turn it on, and send one request through the form. Expect one row. With the API explorer (`spreadsheets.developerMetadata.search`, signed in as yourself) or Apps Script, confirm one developer metadata entry with key `daloy`, project visibility, on that tab. Then set that delivery back to `state = 'queued', check_first = true` in the database and let the worker pick it up: expect no second row and "already in the sheet, not written twice". This is the open question in plan section 6.1.
5. Picker for a sheet. Create a spreadsheet by hand in Drive with two tabs. In Daloy select Pick an existing sheet. Expect the Google Picker to open (check the browser console for content security policy errors and note any host it reports), to list spreadsheets only, and after picking, the sheet's title and its real tab names in the Tab list. Choose the second tab, add a test row, and expect it there.
6. A sheet you did not pick. Copy the id of a spreadsheet you own but never picked or created with Daloy, and call `POST /settings/connections/google-sheets/pick` with it from the browser's console (the session cookie applies). Expect a 400 that says to pick the sheet again.
7. Drive, created folder. Open Google Drive in Apps, select Connect with Google, then Create a Daloy uploads folder. Expect a "Daloy uploads" folder in My Drive (not a shared drive). Send a form with a file through an automation with a Drive step. Expect the file in that folder, named with the request reference.
8. Drive, picked folder. Select Pick a folder. Expect the Picker to list folders only and allow choosing one. Pick a folder in My Drive you made by hand, send another file, and expect it inside that folder. This checks creating a file in a Picker-chosen folder under `drive.file`.
9. Revoke. Select Disconnect on Google Sheets. Expect the card to go back to Connect with Google with no warning about revoking. Open https://myaccount.google.com/permissions and expect your dev app no longer listed for that grant (or note what Google shows). Send a request: expect the Sheets delivery to fail with "not connected" and keep its payload.
10. Picked files after disconnect and reconnect. Connect Google Sheets again with the same account. Expect the destination from before to be kept. Add a test row to the picked sheet from step 5 and note whether it still works or fails with "pick the sheet again". Then connect with the second Google account: expect the sheet choice cleared, and after picking the same sheet (shared with that account), a queued delivery to go through without review.
11. Two workspaces, one Google account (plan R14). Connect Google Sheets with the same Google account in a second Daloy workspace. Disconnect it there. In the first workspace, add a test row. Note whether it still works (separate grants) or fails with "no longer accepts Daloy's access" (one shared grant).
12. Expiry in Testing. Refresh tokens of a project in Testing last seven days. After seven days, add a test row and expect "Reconnect Google Sheets" with the connection marked as needing reconnecting.

## Results

Not run yet.
