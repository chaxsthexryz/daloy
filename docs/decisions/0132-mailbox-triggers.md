# 0132: Connected mailbox triggers (`gmail_message`, `outlook_message`)

## Context

Phase G3 adds two triggers that watch the Gmail or Outlook mailbox the owner already connected in Apps, removing IMAP app-password setup for OAuth mailbox users:

- `gmail_message`: polls Gmail API `users.messages.list` / `users.messages.get` using the workspace's OAuth grant in `mail_senders`, with optional `from`, `subjectContains`, and `label` filters.
- `outlook_message`: polls Microsoft Graph `/me/messages` or `/me/mailFolders/{id}/messages` using the workspace's Outlook OAuth grant in `connections`, with optional `from`, `subjectContains`, and `folder` filters.

Both reuse `trigger_polls` from migration `0056` (zero DB migration), `run_keys` idempotency (`createKeyedRun`), and the G2 polling architecture ([decision 0129](0129-google-workspace-triggers.md)).

## Options

1. Add `gmail.readonly` to the default Gmail OAuth consent flow and require `Mail.Read` on Outlook.
   - `gmail.readonly` is a Google restricted scope requiring a paid annual CASA security assessment ($500 to $4,500) before public launch, and `FORBIDDEN_SCOPES` / `scopes.test.ts` explicitly block requesting it by default ([decision 0063](0063-gmail-oauth.md)).
2. Keep Gmail's default OAuth scopes (`gmail.send`) untouched (`FORBIDDEN_SCOPES` intact), add Microsoft Graph `Mail.Read` to `OUTLOOK_SCOPES` (without requiring it for existing send-only grants in `requiredScopes`), and validate the required read scope in `mailboxConnectionProblem` before polling or publishing.

## Decision

Option 2.

- **OAuth scopes**:
  - `gmail`: unchanged (`openid email gmail.send`). `gmail.readonly` stays in `FORBIDDEN_SCOPES`. `mailboxConnectionProblem("gmail_message", ...)` checks `mail_senders.scopes` for `gmail.readonly` or `https://mail.google.com/` and tells send-only workspaces why reading Gmail needs `gmail.readonly` (restricted scope requiring verification before public launch, with the Email IMAP trigger as the alternative) unless a grant already carries that scope.
  - `outlook`: `OUTLOOK_SCOPES` and `outlookAdminConsentUrl` now request `Mail.Read` alongside `offline_access`, `Mail.Send`, and `User.Read`, while `requiredScopes` stays `["Mail.Send", "User.Read"]` so existing send-only organizations do not break on reconnect. `mailboxConnectionProblem("outlook_message", ...)` checks `connections.scopes` for `Mail.Read` (or `Mail.ReadWrite`).
- **Polling and state**:
  - Reuses `trigger_polls` with zero migrations. Both `pollGoogleTriggers` and `pollMailboxTriggers` filter their `SKIP LOCKED` claim query by `triggers.type` so the two pollers never claim or delete each other's rows.
  - Interval: 5 minutes or the plan's `minScheduleMinutes` when longer; failed reads back off exponentially up to 1 hour (or `Retry-After` when longer). Missing connections, missing read scopes, invalid labels/folders, and self-loops pause with `problem` and re-check every 5 minutes.
  - First-poll no-replay: the first poll for a `(workflowId, source)` only records `{ since: now.toISOString() }` and starts no runs. Changing the connected account or watched `label` / `folder` starts a new first poll.
  - Idempotency: each message uses provider-assigned `gmail:<id>` or `outlook:<id>` in `run_keys` (never sender-controlled `Message-ID` headers) before the cursor moves. Gmail's newest-first listing keeps `cursor` at `since` if `nextPageToken` is present so older messages are never skipped.
- **Safety and self-loops**:
  - Static guard: `mailboxSelfLoopProblem` pauses `gmail_message` workflows with an enabled `email` step targeting the watched Gmail address, and `outlook_message` workflows with an enabled `outlook` step targeting the watched Outlook address.
  - Dynamic guard: `isSelfAuthoredMessage` skips inbound messages whose `From` address matches the connected mailbox (unless explicitly watching Sent), and drafts/spam/trash are skipped by default.
  - Header and payload hygiene: inbound `Message-ID`, `In-Reply-To`, and `References` pass through `sanitizeMessageId` / `sanitizeReferences`, and extracted message text is capped at 50,000 characters. `gmail_message` and `outlook_message` are excluded from `priceTrusted`.
- **API and UI**:
  - `GET /triggers/mailbox/:type` (owner/operator, `Cache-Control: no-store`, `RateLimit(30)`) returns connection readiness and watcher status; publish (`checkConnections`) refuses publishing until connected with read permission.
  - Editor `MailboxTriggerSettings` exposes optional `from`, `subjectContains`, and `label` / `folder` filters with EN and Tagalog copy (`kymavo`, zero dashes).

## Consequences

- Outlook OAuth users gain `Mail.Read` consent and can watch Inbox or custom folders without IMAP credentials.
- Gmail OAuth users without `gmail.readonly` get a clear status/publish explanation instead of silent failures, while deployments with a verified `gmail.readonly` grant poll immediately.
- Live Gmail and Microsoft Graph polling behaviour remains unverified against real Google/Microsoft servers; all automated tests run against `test/fake-providers.ts`.
