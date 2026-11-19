# 0063: Gmail through Connect with Google and the Gmail API

## Context

Phase P5 of the managed OAuth plan ([docs/plans/managed-oauth-plan.md](../plans/managed-oauth-plan.md), sections 3, 6.3, 7, 8 and R4, R7, R8, R16) lets an owner send their automations' email from their Gmail account with a Google sign-in instead of an app password. Today ([decision 0020](0020-owner-mail-senders.md)) the owner turns on 2-Step Verification, creates a 16-letter app password, pastes it, and confirms the address through a link in a test email. Some Workspace and Advanced Protection accounts cannot create app passwords at all.

The shared OAuth core ([decision 0058](0058-oauth-core.md)) and the Google definition ([decision 0060](0060-google-oauth.md)) are in place. The core was written around the `connections` table, but Gmail's sender lives in `mail_senders`, where decision 0020's rules are enforced: one sender per workspace, and a failed or disconnected sender blocks the send with no fallback. Migration 0037 already gave `mail_senders` the OAuth columns. The owner approved the plan's recommended answer to each open question in section 14, so the inbox trigger keeps its app password (question 5) and a Gmail reconnect with another account is not treated as the same sender (question 7).

## Options

Scope and transport:

1. SMTP with OAuth (XOAUTH2). Needs the full `https://mail.google.com/` scope, which is restricted: a paid security assessment every year (treated as true in the plan, unverified).
2. The Gmail API `users.messages.send` with `gmail.send`, a sensitive scope: a free review of up to 10 business days (confirmed in the plan).

Where the grant lives:

1. A `gmail` row in `connections`. The sender rules of decision 0020 would then be split across two tables, and `connections.provider` would need a new value.
2. The owner's `mail_senders` row, with the token blob in the `password_*` columns (plan section 7), and the core told where the grant is kept.

Building the message:

1. Build the MIME message by hand for the API.
2. Let nodemailer build it with a stream transport (`streamTransport: true, buffer: true`) from the same options the SMTP path uses.

Proving the owner controls the address:

1. Keep the confirmation link for a Google sign-in too.
2. Accept the address Google returns with `email_verified: true`, and refuse the sign-in otherwise.

## Decision

- **Scope and transport: option 2.** `GOOGLE_FEATURE_SCOPES.gmail` is `https://www.googleapis.com/auth/gmail.send`, asked for with `openid email`. `oauth/scopes.test.ts` asserts it, Gmail's whole authorize URL, and that `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.metadata`, `https://mail.google.com/` and full `drive` stay in `FORBIDDEN_SCOPES` and are never asked for.
- **Where the grant lives: option 2.** `packages/db/src/oauth/gmail.ts` defines `gmail` with `googleProvider("gmail", ...)`, slug `gmail`, so start is `POST /settings/connections/gmail/oauth/start` and the callback lands on `#/apps/gmail-<outcome>`. It is in `OAUTH_PROVIDERS`, so the console's connection list names it when a Google client is set, and the keepalive sweep covers it.
- **The core extension.** `OAuthProvider` gains an optional `store: GrantStore`, which says where a grant is kept: `secretName` (the associated data of the encrypted blob), `lock` (inside the refresh transaction, `SELECT ... FOR UPDATE` on the row and its encrypted credential), `refreshed`, `refused` (marks failed only for the revision read), `connect` (the callback's save), `due` (for keepalive) and `remove` (for disconnect, returning the blob to revoke). Without a store, `connectionsStore` does what the core did before, moved without change: the `connections` row of `provider`. `finishFlow`, the refresh under the row lock, `keepOAuthAlive` and `disconnectOAuth` call the store; nothing else in the core changed. `OAuthProvider.provider` widens to `OAuthFlowProvider`, which is `PROVIDERS` plus `gmail`, and migration 0038 adds `gmail` to the `oauth_flows.provider` check. This is the one migration after P1's; no other open branch adds one.
- **Gmail's store.** `gmailStore` locks the owner's `mail_senders` row with `SELECT ... FOR UPDATE` (only an `oauth` row with a credential). The blob is encrypted with the owner id and the name `gmail_oauth`; the app password uses `gmail_app_password`, so neither decrypts as the other. The revision a refusal is marked against is `password_iv`. Disconnect keeps the row as `disconnected` with no credential, for an app password as for a sign-in, so mail stays blocked, then revokes a sign-in at Google with the core's 5 second revoke.
- **Proving the address: option 2.** Gmail's identity call is Google's userinfo; `email_verified` must be `true` or the sign-in saves nothing and lands on `failed`. A successful callback saves the address in lower case, `status = 'active'` and `verified_at = now()`, with no link. The test email to the owner's own address stays: with a sign-in it carries no link and shows "Google accepted a test email". A reconnect with another Google account replaces the address and `external_id`, as saving a new address does today, and later sends go from the new address. Saving an app password over a sign-in sets `auth_method` back to `app_password` and clears the OAuth columns; the same address stays confirmed, as for a replaced password. Its grant at Google is not revoked then (Disconnect does that).
- **Sending: option 2 for the message.** `resolveSender` returns `{ kind: "gmail_api", address, grant }` for a sign-in; the app password result `{ kind: "gmail", address, password }` is unchanged. `sendAs` builds the message with `rawMessage` (nodemailer's stream transport) from the same `message()` options `sendEmail` gives the SMTP transport, so From with the business name, Reply-To, To, Subject, Message-ID, the plain text and the branded HTML part are built by the same code; a test compares the two messages for a plain text email with a business name and reply address. `gmailSend` posts it base64url encoded to `<GMAIL_API_URL>/gmail/v1/users/me/messages/send` (default `https://gmail.googleapis.com`) through `withFreshToken`. The token is refreshed before the worker's send claim (decision 0030) and the claim is released as the request goes out. The per-workspace recipient cap (`MAILBOX_DAILY_CAP`, decision 0054) counts a sign-in's sends like an app password's.
- **Errors**, all with Daloy's own text: a 401 refreshes once and sends again (Gmail did not take it). A refused refresh (`invalid_grant`, which is what a Google password change gives a grant with Gmail scopes, confirmed in the plan) or a second 401 marks the sender `failed` with "Gmail no longer accepts Daloy's access. Reconnect Gmail in Apps.", and the step fails without a retry. A 429, or a 403 with reason `rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded` or `quotaExceeded`, is `throttled` with Retry-After. A refused connection is `not_sent` and retried. A 5xx or a timeout once the request may have reached Google is `unknown`: the step is not retried and the run waits for review, as an SMTP send does. Other 403 and 4xx answers are `rejected`. A sign-in sender on an installation that no longer has the Google client or the Gmail API URL is blocked. Nothing in any of these falls back to the installation server or another owner.
- **History hider**: `secretValuesToHide` also returns the tokens of the workspace's Gmail sign-in, so run history, Activity, CSV, the delivery list and MCP replace them with `[secret]`.
- **UI.** On Apps, the Gmail card (`GmailCard` in `apps/web/src/BusinessSetup.tsx`) uses `ConnectPanel` when the installation has a Google client: Connect Gmail with Google first, a line saying Daloy cannot read mail and that automations that receive email still use an app password, the sender's status, Send a test email to me, Reconnect Gmail, Disconnect, and the app password form under Advanced. Without a client the card is the app password card as before. `ConnectPanel` gained three optional props for an app that is not in `connections`: a wider `conn` type, a `status` line, and a `disconnect` call. Strings are in `apps/web/src/lib/locale-gmail.ts`, in English and Tagalog.
- **The IMAP inbox trigger is not touched.** Reading mail needs `gmail.readonly`, a restricted scope with a paid assessment, so it keeps its app password (plan section 9 item 1).
- **No new dependency.** nodemailer's stream transport is part of nodemailer 10.5.0 (MIT-0), already a dependency of `packages/db`.

## Consequences

- An owner who cannot create an app password can now send as their Gmail address. Until Google approves `gmail.send` for the production client, at most 100 users can use it (plan section 8, confirmed), so Gmail sign-in goes to customers only after the sensitive scope review. The app password path stays fully supported.
- A Google password change stops sending until the owner reconnects. The status reads "Google no longer accepts Daloy's access" and the page says "Reconnect Gmail to send again".
- Gmail's own daily sending limits still apply to the owner's account; Daloy's per-workspace cap is unchanged.
- An idle sign-in is refreshed by the keepalive sweep after 90 days, half of Google's six months.
- `apps/web/src/lib/connect-panel.test.ts` and every other existing test pass unchanged. `core.test.ts` changed one type annotation, and the fake OAuth definition in `test/oauth-provider.ts` now says its provider is a `connections` provider.
- Unverified, to settle in [the live check](../live-gmail-oauth-check.md) before customers use it: that the Gmail API accepts nodemailer's message as is and keeps its From, Reply-To and Message-ID; the error reasons Gmail gives for rate limits and their Retry-After; that a password change gives `invalid_grant` on refresh and a 401 on the API for an existing access token; and Google's `email_verified` for Workspace accounts. Everything here was tested only against `test/fake-providers.ts`; no Google endpoint was contacted.
