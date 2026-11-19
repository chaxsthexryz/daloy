# 0058: Shared OAuth core, minimum scopes, and Outlook on it

## Context

The managed OAuth plan ([docs/plans/managed-oauth-plan.md](../plans/managed-oauth-plan.md), phase P1) replaces pasted keys with a "Connect" button and the provider's consent screen for Google, Slack, Airtable, Notion and Trello, and moves Outlook onto the same code. Before any of them is built, one core has to do consent, token storage, refresh, keepalive and revoke the same way for all of them.

What [decision 0023](0023-outlook-teams.md) had for Outlook did not carry over: the state was signed and stateless, so a state could be replayed within its ten minutes; access tokens lived in each process's memory; and a rotated refresh token was saved with no lock across processes. That worked for Microsoft only because Microsoft keeps an old refresh token valid after rotation (unverified). Airtable revokes a reused refresh token and Trello and Slack (with rotation) make them single use, so two workers refreshing at once, or a crash after the provider answers, would lock an office out.

This record covers plan section 13 items 1 and 2. Provider choices (Google `drive.file`, Gmail, pinning across re-authorization) are for their own phases.

## Options

Consent state:

1. Keep the signed, stateless state. Nothing stored, but replayable inside its lifetime, and nowhere to keep a random PKCE verifier.
2. A one-time flow row: a random state stored as its SHA-256, consumed by one guarded UPDATE, with an encrypted random verifier.

Refresh across processes:

1. In-memory caches per process, as today. No coordination, so double refreshes with strictly rotating providers.
2. A Postgres advisory lock keyed by workspace and provider. Works, but the credential must still be re-read and written separately.
3. `SELECT ... FOR UPDATE` on the connection row inside the transaction that also writes the new pair. The lock and the data are the same row.

Access tokens:

1. In memory per process. Every worker refreshes on its own.
2. Stored in the encrypted credential with the refresh token, so a second worker uses the token the first one just fetched.

Disconnect:

1. Revoke at the provider, then delete. A slow or failing provider leaves the row in place.
2. Delete first, then revoke with a short timeout, and say when the revoke did not happen.

## Decision

Everything is in `packages/db/src/oauth/` (provider-neutral logic, plus one file per provider) and `apps/api/src/oauth.ts` (routes), with one UI component, `apps/web/src/ConnectPanel.tsx`.

- **Providers are data.** `OAuthProvider` (in `oauth/core.ts`) has the authorize, token and revoke URLs (functions of `ProviderUrls`, so tests and e2e point at fakes), the scope manifest, the scopes that must come back granted, extra authorize and token parameters, whether PKCE is used, whether refresh tokens exist, whether the previous refresh token still works, the keepalive interval, the identity call and the consent outcome mapper. `OAUTH_PROVIDERS` in `oauth/index.ts` lists them; Outlook is the only one in this phase.
- **Consent state: option 2.** Migration 0037 adds `oauth_flows`. `POST /settings/connections/:provider/oauth/start` (owner only, 10 a minute) stores the SHA-256 of 32 random bytes, a random 32-byte PKCE verifier encrypted with the workspace and flow id as associated data, the member, the workspace, the provider and an expiry ten minutes ahead, and answers `{ url }`. The callback consumes the row with one UPDATE that requires `consumed_at is null`, `expires_at > now()`, and the session's member and workspace, then checks the owner role. No row means `expired` and nothing else happens. Flow rows are deleted a day after they expire.
- **One callback**, `GET /settings/connections/oauth/callback`, outside the session guard. It sends the browser to `/#/apps/<slug>-<outcome>` with an outcome from a closed list (`connected`, `declined`, `admin_required`, `admin_approved`, `missing_scope`, `expired`, `failed`); an unknown flow lands on `/#/apps/oauth-expired`. No parameter chooses the target and provider text never reaches the page. It answers with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Microsoft's administrator consent stays the one answer handled without a session, and it stores nothing.
- **Granted scopes** are compared with the required ones (a granted scope may carry the provider's resource prefix). A narrower grant saves nothing and lands on `missing_scope`. A provider that has refresh tokens must return one, and the token type must be bearer. The identity call gives `external_id` and the account name. One transaction saves the connection: a reconnect to the same `external_id` keeps the destination, another account clears it.
- **Tokens: option 2.** The credential is still one AES-256-GCM string with the same associated data. For `auth_method = 'oauth'` its plaintext is `{ v: 1, accessToken, accessExpiresAt, refreshToken, prevRefreshToken?, scope }`. Outlook rows written before this decision hold the bare refresh token; they read as an expired blob and become version 1 on their first refresh, so nobody reconnects. Migration 0037 backfills `auth_method` by provider: Google as `service_account`, Teams as `webhook_url`, Outlook as `oauth`, the rest as `token`.
- **Refresh: option 3.** `freshToken` returns the stored access token while it has two minutes left. Otherwise it opens a transaction with `lock_timeout` 15 seconds, locks the row, decrypts it again, and uses what it finds if another worker refreshed or the owner reconnected meanwhile. Only then does it call the token endpoint (10 second timeout) and write the new pair, moving the old refresh token to `prevRefreshToken`, in the same transaction. A refused grant marks the connection failed for the revision it read and throws `auth`; with `previousRefreshTokenWorks` it first tries the previous token once. 429, 5xx, a timeout or a lock timeout leave the row as it was. `withFreshToken` calls a function with the token, and after an `auth` refusal from the API refreshes once (unless another worker already replaced that token) and calls it again.
- **Deliveries refresh before the booking-lock transaction opens**, so the common refresh never holds a second pool connection while that transaction holds one. The rare refresh after a 401 inside the transaction still uses a second connection, as `rotateInto` did before. `rotateInto`, `updateCredential` and the in-memory Outlook token cache are gone.
- **The console's Test button forces a refresh**, so a test proves the grant itself still works, not only an access token that has not expired yet.
- **Keepalive**: the worker runs `keepOAuthAlive` at start and then daily, 20 connections at a time, for active OAuth connections not refreshed for their provider's `keepaliveDays` (30 for Outlook). Only a refused grant marks one failed.
- **Disconnect: option 2.** `DELETE /settings/connections/:provider` deletes the row first, then posts the refresh token to the provider's revoke URL with a 5 second timeout. It answers 200 `{ revoked: true | false }` when the provider has a revoke call and 204, as before, when it has none (Outlook) or the connection was not OAuth. The page then tells the owner to remove Daloy at the provider. Queued deliveries fail with "not connected" and keep their payload, as before.
- **History hider**: `secretValuesToHide` also returns the access, refresh and previous refresh tokens of the workspace's OAuth connections, in the same statement as the secrets, so every reader that already hides secrets (run history, Activity, CSV, the delivery list, MCP) hides them too. Explain and Ask prompts were already built from closed facts.
- **Pinning**: `deliveries.pinned_external_id` is copied when a delivery is queued and compared when both sides have one; otherwise the account name is compared as before. The full re-authorization rules (plan R7, open question 7) are for the provider phases.
- **Boot check**: `oauthEnvProblem` refuses to start the API and the worker when `OAUTH_ENV` is set to something other than `development` or `production`, when it is `development` and `PUBLIC_URL` is not a local address, or `production` and it is. It is required once any of the new clients (`GOOGLE_OAUTH_CLIENT_ID`, `SLACK_CLIENT_ID`, `AIRTABLE_CLIENT_ID`, `NOTION_CLIENT_ID`, `TRELLO_CLIENT_ID`) is set. An installation with only `MICROSOFT_*` keeps starting without it, so no existing deployment breaks on upgrade.
- **Scopes (plan section 13 item 2).** Each provider asks for the minimum its features need, listed in its definition. `oauth/scopes.test.ts` asserts the whole manifest and Outlook's full authorize URL, so a change that adds a scope fails until the test, this record and any provider review submission are updated together. `FORBIDDEN_SCOPES` lists Google's restricted scopes (`https://mail.google.com/`, the Gmail read and modify scopes, full `drive` and its read and metadata variants), which need a paid security assessment every year; the same test fails if any provider asks for one.
- **Outlook stays compatible.** Its definition keeps the redirect address registered in every installation's Entra app, `/settings/connections/outlook/callback`, which is now an alias of the shared callback and still lands on `#/settings/business/outlook-<outcome>`. `POST /settings/connections/outlook/start` is an alias of the shared start. Scopes, PKCE, the outcome mapping and every Microsoft test behave as before.
- **No new dependency.**

### How to add an OAuth provider

1. Write `packages/db/src/oauth/<provider>.ts` exporting an `OAuthProvider`, following `outlook.ts`: `provider` (the `connections.provider` value), `slug` (dashes, as in the URL), `client` from `ProviderUrls` (add the env vars to `providerUrls()` in `providers.ts`), the authorize, token and, if the provider has one, revoke URLs built from base URLs that `providerUrls()` reads with an env override, the minimum `scopes`, `requiredScopes` as the token answer names them, `pkce`, `refreshTokens`, `previousRefreshTokenWorks` only if the provider documents it, `keepaliveDays` (half the provider's inactivity window, 30 if unknown), `identity` (a stable account id and a display name, and a destination only if the identity fixes it), and `outcome` for consent errors.
2. Add it to `OAUTH_PROVIDERS` in `oauth/index.ts`, and its scopes to the expected manifest in `oauth/scopes.test.ts`. Never add a scope listed in `FORBIDDEN_SCOPES`.
3. Where the provider is called, read the connection with `connectionCredential` and, for `authMethod === "oauth"`, wrap the call in `withFreshToken(db, key, urls, workspaceId, def, conn, (token) => ...)`. Map a 401 from the API to `ProviderError` kind `auth` so the core refreshes once. In `deliveries.ts`, `attempt()` already calls `freshToken` before the transaction for any provider with a definition; add the send in `send()`.
4. In `apps/web/src/Connections.tsx`, render the app's card through `ConnectPanel` with `configured={conns.oauth.includes("<slug>")}` and today's paste form as `form`, so an installation without the client keeps the paste form. Add new strings to the English and Tagalog tables.
5. Tests: add an app to the generic fake with `fake.addOAuthApp("<name>", { rotation, expiresIn, refresh })` (or an entry in the `oauth` list in `test/fake-providers.ts`) and point the definition at `fake.oauthUrls("<name>")`; `test/oauth-provider.ts` shows the shape. Cover consent, decline, a narrower grant, reconnect to the same and another account, refresh with the provider's rotation rule, and revoke.
6. Put the client id and secret in `.env.example` as comments, register the redirect `<PUBLIC_URL>/settings/connections/oauth/callback` at the provider, and add the live check to `docs/live-*-check.md`, marked unverified until run.

## Consequences

- A consent started before this version is deployed lands on `expired` (its signed state is no longer read). The owner presses Connect again.
- Reconnect and a refresh in flight for the same connection run one after the other: the reconnect waits for the row lock until the refresh's provider call ends (at most its 10 second timeout).
- A crash between the provider's answer and the commit loses the new pair. For a provider that keeps the old refresh token (Microsoft, unverified) nothing breaks; for a strictly rotating one the next refresh is refused, the connection is marked failed and the owner reconnects. Tested with the generic fake.
- One OAuth client serves all workspaces. Isolation rests on tokens being keyed only by the workspace row and on the associated data; no cache is keyed by provider account.
- The plan's button label `Connect with <App>` is shown as `Connect <App>` (Connect Outlook), the wording the console and its tests already use.
- Unverified, as in the plan: whether Microsoft keeps an old refresh token valid after rotation, Microsoft's refresh token inactivity window, and that Microsoft has no refresh token revoke call Daloy can use. Every behaviour here is tested only against `test/fake-providers.ts`; no real provider was contacted.
- Whether the API has an access log that records query strings (plan R3) was checked in code: Nest is created with the `error` and `warn` log levels only and no request logger, so the callback's query string is not logged by Daloy. Whether a reverse proxy or tunnel in front of it (cloudflared in [deployment](../deployment.md)) records query strings is not checked here; the code is single use and bound to the PKCE verifier either way.
