# 0060: Google Sheets and Drive through "Connect with Google", with the Google Picker

## Context

Phase P2 of the managed OAuth plan ([docs/plans/managed-oauth-plan.md](../plans/managed-oauth-plan.md), sections 4, 6.1 and R5, R7, R11, R12, R14) replaces the service account JSON key as the main way to connect Google Sheets and Google Drive. Today an owner creates a Cloud project, a service account and a key, pastes the file, and shares each sheet or shared-drive folder with the account's address ([decision 0021](0021-sheets-slack-deliveries.md), [decision 0051](0051-form-files-and-drive.md)). The shared OAuth core ([decision 0058](0058-oauth-core.md)) is in place; this record adds Google on it. The owner approved the plan's recommended answer to each open question in section 14, so the Picker token is server-minted (question 6) and Sheets and Drive deliveries move from a service account to a Google sign-in without review when the destination is the same (question 7).

## Options

Scope:

1. `spreadsheets` and full `drive`, as the service account uses. Full `drive` is a restricted scope: a paid security assessment every year.
2. `drive.file` only (non-sensitive). Daloy reaches files it created and files the owner picks in the Google Picker.

Picking a file:

1. Ask for the sheet or folder link, as today. Under `drive.file` a pasted link gives no access, so it would not work.
2. The Google Picker, with an access token minted by the server.
3. The Google Picker with Google Identity Services in the browser getting its own token: a second popup.

Credentials in the Sheets and Drive calls:

1. A second set of functions for OAuth.
2. One set that takes a service account or an access token.

Pinning when the credential changes:

1. Compare account and destination, as for every provider today: any reconnect with another account, or a move from the service account, sends queued deliveries to review.
2. For Sheets and Drive compare only the destination (spreadsheet and tab, folder).

## Decision

- **Scope: option 2.** `packages/db/src/oauth/google.ts` defines Google as an `OAuthProvider` through `googleProvider(feature, provider, slug, name)`. `GOOGLE_FEATURE_SCOPES` is the one table of scopes per feature (`sheets` and `drive`, each `https://www.googleapis.com/auth/drive.file`), asked for with `openid email` to name the account. Gmail (P5) and Calendar (P6) add a row and call `googleProvider`. Authorize parameters: `access_type=offline`, `prompt=consent`, `include_granted_scopes=false`, PKCE S256. `drive.file` must come back granted, or nothing is saved (`missing_scope`). Identity is the OpenID userinfo `sub` (stable) and `email` (shown). Revoke posts the refresh token to `oauth2.googleapis.com/revoke`. `keepaliveDays` is 90, half of Google's six months of non-use. `scopes.test.ts` asserts the table, the manifest, the full authorize URL, and that none of `drive`, `drive.readonly`, `gmail.readonly`, `https://mail.google.com/`, `gmail.modify` or `gmail.compose` is asked for.
- **One grant per Daloy app.** Sheets and Drive each connect on their own (`google_sheets`, `google_drive` rows), so an office can use different Google accounts and the `connections` key stays as it is.
- **Endpoints and client from env**, through `providerUrls()`: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and for tests and e2e the overrides `GOOGLE_AUTHORIZE_URL`, `GOOGLE_OAUTH_TOKEN_URL`, `GOOGLE_REVOKE_URL`, `GOOGLE_USERINFO_URL`. Public Picker values: `GOOGLE_PICKER_API_KEY` and `GOOGLE_PROJECT_NUMBER` (the Picker's app id). Without a client nothing changes: the cards show today's service account form only.
- **Credentials: option 2.** `GoogleAuth` in `providers.ts` is a service account or `{ accessToken }`. `sheetInfo`, `appendRow`, `appendRowOnce`, `deleteSheetMarker`, `driveFolderInfo` and `driveUpload` take either. A service account still signs its JWT and caches its token per process, and its messages still name the address to share with. With an access token, a 401 is an `auth` error so `withFreshToken` refreshes once, and a 403 or 404 is a `permission` error that says to pick the sheet or folder again. `withGoogle` in `google-access.ts` chooses by the connection's `auth_method`. Calendar is unchanged until P6.
- **Deliveries** call `withGoogle` for Sheets rows, Drive files and the marker sweep. The access token is refreshed in `attempt()` before the booking-lock transaction opens, as for Outlook.
- **Easy connect (plan 6.1).** After consent, Sheets offers Create a sheet for me (`POST /settings/connections/google-sheets/create`: a spreadsheet named "Daloy requests" made through the Sheets API, its first tab chosen) and Pick an existing sheet (Picker, then `POST .../google-sheets/pick`). The tab is a dropdown of the sheet's real tab names (`GET .../google-sheets/tabs`, and `pick` with a tab). Drive offers Create a Daloy uploads folder (`POST .../google-drive/create`, in My Drive) and Pick a folder (`POST .../google-drive/pick`). The shared-drive-only rule applies to service accounts only; with a Google sign-in a My Drive folder works. These routes are owner only, rate limited, refuse a service account connection, and live in `apps/api/src/google.ts`.
- **Picker: option 2.** One route for both apps, `POST /settings/connections/:app/picker-token` with `:app` `google-sheets` or `google-drive` (owner only, 10 a minute, `Cache-Control: no-store`, never logged). It refreshes the grant first and answers the access token, its expiry, the API key and the app id. The page sends back only the picked id; the server reads the file again with its own stored token, and Google refuses (404) any id the grant cannot reach, so a forged id gains nothing (R12). The token reaches only files Daloy created or the owner picked (R11).
- **The Picker is a seam.** `GoogleSheetsCard` and `GoogleDriveCard` (`apps/web/src/GoogleConnect.tsx`) take a `pick()` function. By default it is `window.daloyPick` when set, otherwise the real Picker, whose loader `https://apis.google.com/js/api.js` is fetched only when the owner presses a Pick button. The e2e suite sets `window.daloyPick` with `addInitScript`. A page script could call it too, but that gives nothing beyond calling the API, since every id is checked on the server.
- **Content security policy.** When `GOOGLE_PICKER_API_KEY` is set, the console's policy adds `https://apis.google.com` to `script-src` and `https://docs.google.com` and `https://drive.google.com` to `frame-src`, and nothing else. A test compares every directive with the default. Without the key the policy is unchanged.
- **Pinning (R7): option 2.** For `google_sheets` and `google_drive`, a queued delivery compares only the destination fields. The core already clears the destination when another Google account connects (another `sub`, or a service account replaced by a sign-in), so the owner picks again: the same spreadsheet and tab, or the same folder, then sends without review, and anything else goes to review as before. The same account keeps its destination. A tab change still goes to review. Gmail and Outlook keep comparing the account. `pinned_external_id` is not needed for these two providers.
- **Lost access after a reconnect.** If a reconnect loses access to a picked file (assumed in the plan, unverified live), the delivery fails with kind `permission` and a plain message to pick the sheet or folder again. The connection stays active, since the grant itself works.
- **UI.** The cards use `ConnectPanel`, which gains an optional `connectLabel` so the main button reads "Connect with Google". The service account form sits under Advanced (`SheetsConnection` and `DriveConnection` gain an `embedded` mode that shows only the form). The console's connection list now includes `authMethod` so the card knows which kind is connected. Strings are in `apps/web/src/lib/locale-google.ts`, in English and Tagalog.
- **No new dependency.**

## Consequences

- A Google sign-in shows Daloy only files it created or the owner picked. Rows, markers and uploads use the same calls as the service account.
- Replacing a Google sign-in with a service account key (Advanced) does not revoke the Google grant. The owner removes Daloy in their Google account if they want it gone. Disconnect does revoke.
- Create a sheet or folder is not idempotent: a timeout after Google created it may leave an unused "Daloy requests" sheet or "Daloy uploads" folder in the owner's Drive.
- The e2e stack now runs with a fake Google client, so specs that use the service account forms open Advanced first.
- Unverified, to settle in [the live check](../live-google-oauth-check.md) before customers use it: developer metadata markers under `drive.file`; creating a file inside a picked folder; whether picked-file access survives a disconnect and reconnect; whether two workspaces on one Google account share one grant at revoke (R14); the Picker's exact host list for the CSP (taken from Google's `drive-picker-element` README, not an official Picker page) and whether it also needs `connect-src` or `accounts.google.com`; the Picker view settings for folders (`setIncludeFolders`, `setMimeTypes`, `setSelectFolderEnabled`, from a Google blog post and the reference page titles); that the app id is the Cloud project number (search summary of Google's Picker guide); and the consent error names `admin_policy_enforced` and `org_internal`. Everything here was tested only against `test/fake-providers.ts`; no Google endpoint was contacted.
