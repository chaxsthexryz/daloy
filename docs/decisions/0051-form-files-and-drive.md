# 0051: Form files and the Google Drive step

## Context

Owners want photos and documents a customer sends (receipts, IDs, site photos) kept with the request and saved to Google Drive. The files come from anonymous visitors on a public form, so the limits and the way files are stored and served matter more than the upload itself. N22 will later let the AI read images, so the storage must be readable by the worker.

## Options

1. Store files on a disk volume. The API and worker run as separate containers, so both would need the same volume, and backups and the database role would not cover it.
2. Store files in Postgres (`bytea`). Both processes already share it, the app role and backups cover it, and a run and its files can commit in one transaction.
3. Send files straight to Drive from the API. A Drive outage would then lose the upload or block the form, and the console could not show the file.

For Drive itself:

1. The owner's existing kind of Google service account key, as for Sheets and Calendar.
2. A per-owner Google sign-in (OAuth) with the `drive.file` scope.

## Decision

Postgres storage, and the service account.

- Limits are 5 MB per file, 3 per field and 5 per submission. Types are read from the first bytes: JPEG, PNG, WebP, HEIC or HEIF, and PDF. SVG, HTML and every other type are refused. 5 MB is the size Google's one-request upload is meant for.
- Files are kept 7 days and then deleted by the worker's sweep. A Drive step saves them well before that.
- The run payload holds references only. A file field is filled by the hosted form handler alone, never from caller data, so no other entry point can point a run at a stored file. The Drive delivery also reads a file by id, run and workspace together.
- Uploads are counted per workspace per Manila day as a new usage kind. Unlike the other kinds, a workspace with no plan is not unlimited (20 files a day), because anyone who signs up could otherwise fill the database.
- The Drive step is a delivery like Sheets: the folder is pinned at queue time, each saved file is recorded under the claim, and an unknown outcome goes to `needs_review`. Drive could be made repeatable with a search by app property, but the operator review already exists and keeps this phase smaller.
- The connection uses the `drive` scope, because `drive.file` cannot see a folder that the owner shared with the account.
- Downloads from the console are owner and operator only, always `Content-Disposition: attachment`, with the stored type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cache-Control: private, no-store`.

## Consequences

- Service accounts have no Drive storage, so uploads into a normal My Drive folder fail with `storageQuotaExceeded`. The Drive step works only with a folder in a shared drive (Google Workspace), and Connect refuses any other folder. Owners on free Gmail cannot use it until a per-owner sign-in is built.
- A leaked key can read and change everything shared with that service account. A dedicated account per business limits this.
- The database and its dumps grow by up to 5 MB times the daily file limit times 7 days per workspace.
- The upload parser keeps a request (up to 25 MB) in memory. The per-IP limit caps one address, not many.
- A replayed tracked submission is counted against the daily file limit again, though it stores nothing.
- Files over 5 MB need Google's resumable upload, which is not built.
