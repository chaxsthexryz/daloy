# Managed OAuth and "Connect with X": plan

Status: proposed, 18 November 2026. Nothing in this plan is built. No application code, test, migration or config was changed to write it. It waits for the owner's "go", phase by phase (AGENTS.md).

Goal: a customer connects an account with a "Connect with X" button and a consent screen. They create no cloud project, download no JSON key and paste no token. The operator (the owner) registers each provider's OAuth app once.

How the provider facts were checked: Google, Slack, Microsoft, Airtable, Notion, Trello, PayMongo and Telegram were looked up through web search on 18 November 2026. The fetch tool in this session could not open any provider documentation site (DNS refused), so no page was read in full and every fact below comes from the search summaries of the official pages plus the repository. A fact is tagged **confirmed** when current official documentation said it in those results, and **unverified** when it came from a vendor or community page, from memory, or was not found. Section 15 lists every unverified item. Resolve each one against the live page or console before the phase that depends on it.

## 1. Summary and verdicts

| App | Verdict |
|---|---|
| Google Sheets and Drive | Managed OAuth with the single non-sensitive scope `drive.file` and the Google Picker. No Google review needed for that scope (unverified on the unverified-app warning, see 8). Service account kept as advanced. |
| Google Calendar | Managed OAuth. Sensitive scope review likely (tier unverified). Default to a calendar kymavo creates, so the narrowest scope works. |
| Gmail (send) | Managed OAuth through the Gmail API with `gmail.send`, a sensitive scope (confirmed). App password stays for the IMAP inbox trigger, because reading mail is a restricted scope with a paid security assessment. |
| Outlook | Already OAuth. Move it onto the shared core. Add Microsoft publisher verification (free per Microsoft) to cut administrator prompts. |
| Microsoft Teams | Stays a guided paste (Workflows link). A Graph channel post is delegated, needs admin consent and posts as a person. |
| Slack | Managed OAuth install (bot token, `chat:write`, `channels:read`). Do not list on the Marketplace. Read Slack's commercial-distribution terms before charging for it. |
| Telegram | Stays a guided paste. Telegram has no OAuth for bots. kymavo can find the chat id for the owner. |
| PayMongo | Stays a guided paste. No install flow found. Its linked accounts product is a merchant onboarding platform that needs approval, not a connect button. |
| Airtable | Managed OAuth (free to register). Replaces the pasted token, base id and table id with a consent screen and a base and table picker. |
| Notion | Managed OAuth through a public integration. Consent screen has a page picker. |
| Trello | Managed OAuth 2.0 (now available, confirmed). Replaces pasted key and token, and the list id gets a picker. |

Phase list: P0 owner setup, P1 shared core, P2 Google Sheets and Drive with Picker, P3 Slack, P4 Airtable, Notion and Trello, P5 Gmail, P6 Calendar, P7 guided pastes, P8 security review and docs. P2, P3 and P4 can run in parallel after P1. Section 12 has models and effort.

Single biggest risk: refresh tokens. Five of the providers rotate or expire refresh tokens, and today's code has no cross-process refresh lock, so two workers refreshing at once, or a crash after the provider hands back a rotated token, can lock a customer out of their own automations. P1 must be built and tested before any provider is moved onto it.

Rule flags (full list in section 9): Google restricted scopes need a paid assessment, so the plan avoids them by design. Google and Microsoft verification need a domain the owner controls, which the project does not have today (the site is on `pages.dev`), and a domain costs money.

## 2. Findings: how connections and credentials work today

All paths are in `/home/user/daloy`.

**Table and keys.** `connections` (`packages/db/src/schema.ts:545`) has the primary key `(user_id, provider)`. `user_id` is the workspace id, which is the owner's user id (decision 0022), so there is one connection per provider per workspace. The credential is one encrypted string (`credential_ciphertext`, `_iv`, `_auth_tag`). Encryption is AES-256-GCM with the key from `SECRETS_KEY` and associated data `<workspace>:connection:<provider>` (`packages/db/src/connections.ts:6`, `crypto.ts:9`), so a copied ciphertext does not decrypt elsewhere. Status is only `active` or `failed`. `revision` is the credential's IV: every status write and every rotation is guarded by it (`markConnectionFailed`, `updateCredential`, `rotateInto`), so a late answer about an old credential cannot change a new one.

**What each credential is today.**

| Provider | Credential stored | How the owner gets it today |
|---|---|---|
| Google Sheets, Calendar, Drive | `{client_email, private_key}` of a service account | Create a Cloud project, a service account and a JSON key, paste the file, share each sheet, calendar or shared-drive folder with the account's address (`connections.ts:146,182,208`) |
| Slack | Bot token `xoxb-` | Create a Slack app, copy the token (`:225`) |
| Telegram | Bot token plus chat id | BotFather, then find the chat id (`:235`) |
| PayMongo | `{secretKey, webhookSecret}` | Copy the key, create a webhook, copy `whsk_` (`:253`) |
| Airtable | Personal access token, base id, table id | Create a token, copy two ids from links (`:278`) |
| Notion | Internal integration secret and a database link | Create an integration, share the database (`:296`) |
| Trello | API key, token, list id | Get a key and token, find a list id (`:314`) |
| Outlook | Refresh token | OAuth already: signed state, PKCE, callback (`:360`, `:457`) |
| Teams | Workflows webhook URL | Build a Teams workflow, paste its link (`:384`) |
| Gmail (not in `connections`) | App password in `mail_senders` | App password and a verification email (`mail-senders.ts:46`) |
| IMAP inbox trigger | Mailbox password per workflow in `email_sources` | App password |

**Access tokens.** Nothing stores access tokens. Google service account tokens are cached in memory per process (`providers.ts:118`), and Outlook tokens are cached per process by a hash of the refresh token (`providers.ts:647`). The API and each worker refresh on their own.

**Refresh.** Outlook rotates its refresh token on every refresh and the code saves the new one over the revision it came from (`rotateInto`). There is no cross-process lock. That works for Microsoft only because it does not invalidate the old refresh token when a new one is issued (unverified here). It would not work for Airtable (revokes a reused token, confirmed), Trello (single use, confirmed) or Slack with rotation on (single use, confirmed). The new core needs a lock.

**Consent state today (Outlook).** The state is an HMAC-signed JSON of workspace, member, expiry and a nonce, valid 10 minutes, and the PKCE verifier is derived from the state with the secrets key, so nothing is stored (`connections.ts:430-450`). The callback is outside the session guard so an administrator without a kymavo account can return, but a code is exchanged only when the signed-in member equals the member in the state and holds a managing role (`:472`). The browser is sent to a fixed page with a closed outcome code, so there is no open redirect and no provider text reaches the page. Gap: a state can be replayed inside its 10 minutes. The provider's single-use code and the session check make this low risk, but a one-time record is cleaner and also needed for Picker flows.

**Pinning.** `queueDelivery` copies the connection's `account` and `destination` into the delivery (`deliveries.ts:50`). Each attempt compares the pin with the current connection and sends the delivery to `needs_review` when they differ (`deliveries.ts:112`). `sameDestination` compares a fixed list of destination fields (`:230`). A disconnect deletes the row, and queued deliveries then fail with "not connected" and keep their payload for Retry.

**Scopes in use.** Sheets uses `spreadsheets`, Calendar uses `calendar.events`, Drive uses full `drive` (`providers.ts:114-116`). Full `drive` is a restricted scope (confirmed). It must not be copied into the OAuth design.

**Sheets markers.** The at-most-once Sheets write uses developer metadata created in the same `batchUpdate` as the row (`appendRowOnce`). Whether that works under `drive.file` is unverified and needs a live test.

**UI.** `apps/web/src/Connections.tsx` has one component per provider, each with its own paste form and a help link. Outlook already shows a Connect button and reads an outcome code from the page address.

**Tests and fakes.** `test/fake-providers.ts` fakes Google's token endpoint and Sheets, Slack, Telegram, Airtable, Notion, Trello, Microsoft sign-in and Graph, and Teams. It has no Google authorize, revoke, userinfo or Picker. All provider tests use it, and no test contacts a real provider.

**Existing findings this plan touches.** Security review M16 (Airtable table ids), M11 and M12 (Calendar pinning and ordering), M9 (history redaction). PROJECT.md N24 ("Google Sheets through OAuth, bring your own client, verified consent screen out of scope") is replaced by this plan if approved.

## 3. Per-provider table

Scope names are the minimum kymavo needs for what it does today. "Review" means a review by the provider before other organisations can use the OAuth app.

| App | Connects today | OAuth or install flow exists | Minimum scopes | Provider review, time, cost | Stays manual (guided paste) |
|---|---|---|---|---|---|
| Google Sheets | Service account JSON, sheet shared with its address, sheet link and tab typed | Yes: OAuth 2.0 authorization code with offline access | `drive.file` (non-sensitive, confirmed), plus `openid email` to name the account. Sheets API accepts `drive.file` for files the user picks (confirmed). | None for non-sensitive scopes (unverified: confirm the consent screen warning in the console). Free. | Service account JSON as advanced |
| Google Drive | Service account with full `drive`, folder in a shared drive | Yes, same grant | `drive.file`. kymavo creates its own folder, or the user picks one in the Picker. | As Sheets | Service account as advanced |
| Google Calendar | Service account `calendar.events`, calendar id typed | Yes | Default `calendar.app.created` (kymavo makes its own calendar). To use an existing calendar: `calendar.events` plus `calendar.calendarlist.readonly`. Tier of each: unverified (sources disagree for `calendar.events`). | Sensitive review if any scope is sensitive: up to 10 business days (confirmed), free | Service account as advanced |
| Gmail send | App password in `mail_senders`, SMTP | Yes (Gmail API) | `gmail.send`, sensitive (confirmed) | Sensitive review up to 10 business days, free. Brand verification 2 to 3 business days (confirmed). | App password stays for the IMAP inbox trigger. `gmail.readonly` is restricted (confirmed) and needs a paid security assessment, so no OAuth for reading mail. |
| Outlook | OAuth, installation's Entra app | Already built | `Mail.Send`, `User.Read`, `offline_access` (unchanged) | No Microsoft review. Publisher verification is free (confirmed), needs a verified partner account and a domain. Without it, tenants may force administrator consent (unverified details). | None |
| Microsoft Teams | Workflows URL pasted | Graph channel post exists but is delegated, posts as a person, needs admin consent (search summary, unverified) | `ChannelMessage.Send` (delegated), not planned | n/a | Workflows link, as a guided wizard with a live test |
| Slack | Bot token pasted | Yes: OAuth v2 install | `chat:write`, `channels:read` (confirmed). `chat:write.public` would let kymavo post without being invited (unverified). | No review to install in any workspace (unverified). Marketplace is optional, needs at least 5 active installs, timeline not found. Non-Marketplace apps have a 1 request per minute limit on `conversations.history` and `conversations.replies` (confirmed), which kymavo does not call. Slack says Marketplace is the proper channel for commercial distribution (confirmed from a summary, read the terms). | Own-app token as advanced |
| Telegram | Bot token and chat id pasted | None. Bots come from BotFather; Login Widget authorises users, not bots (confirmed). | n/a | n/a | Token from BotFather (guided), chat found by kymavo |
| PayMongo | Secret key and webhook secret pasted | None found. Linked accounts is a platform onboarding product: registered business only, approval 3 to 7 business days, KYB (confirmed). | n/a | n/a | Secret key (guided). Webhook creation by API is unverified. |
| Airtable | Personal access token, base id, table id pasted | Yes: OAuth integration, free to register | `data.records:write`, `schema.bases:read` (to list bases and tables), `data.records:read` only if the check keeps reading a record. | Privacy policy URL, terms URL and support email are required before other users can authorise (confirmed). No review step found (unverified). Free. | Personal access token as advanced |
| Notion | Internal integration secret pasted, database shared by hand | Yes: public integration | Capabilities set on the integration (read, insert content). User picks pages and databases at consent (confirmed). | No review to use a public integration. Security review only to list in the Marketplace (confirmed). Free. | Internal secret as advanced |
| Trello | API key, token, list id pasted | Yes: OAuth 2.0 three-legged, now available; the legacy authorize flow still works (confirmed) | `read`, `write` and `offline_access` for a refresh token (confirmed). | Approval or fee for a Trello OAuth 2.0 app: not found (unverified). | Legacy key and token as advanced |

## 4. Per-provider notes

**Google.** Use one OAuth client per environment and one grant per kymavo provider (Sheets, Drive, Calendar and Gmail each ask for their own scope). This keeps scopes minimal, keeps `connections` keyed as it is, and lets an office use different Google accounts for different things. Do not send `include_granted_scopes=true`. Send `access_type=offline` and `prompt=consent` on connect and reconnect so a refresh token is always returned (confirmed that offline access is what returns one). Read the granted scopes from the token response and refuse the connection when a required scope was unticked (granular consent). Revoke with `https://oauth2.googleapis.com/revoke` (confirmed). A refresh token stops working when the user revokes access, after six months of non-use, after a password change if the token has Gmail scopes, and when the account passes 100 live refresh tokens for the client, which silently invalidates the oldest (all confirmed). In a Testing project they last seven days (confirmed).

**Slack.** Authorize at `slack.com/oauth/v2/authorize`, exchange at `oauth.v2.access`, store the bot token, and use the team id as the stable account id. Leave token rotation off: tokens do not expire without it, and with it they last 12 hours and each refresh token is single use (confirmed). Private channels stay out of scope. The existing channel picker, test message and "app not in channel" hint remain. Slack OAuth PKCE support is unverified.

**Outlook.** Same scopes, same app registration. Move the flow onto the shared core so state, one-time use, locking and revoke are written once. Microsoft publisher verification needs a Microsoft AI Cloud Partner Program global account that has finished verification, an app in a work or school tenant, a publisher domain that is not `onmicrosoft.com` and matches the partner email domain, and an Application Administrator and Partner admin doing it with MFA (confirmed). It costs nothing (confirmed). Client secrets expire in Entra; track the expiry date (unverified).

**Teams.** A guided wizard with numbered steps, the host check kymavo already does, an automatic test message, and the specific error hints already in `teamsPost`. A delegated Graph post would show messages as the connecting person, and the search results say it needs administrator consent.

**Telegram.** Wizard: open `t.me/BotFather`, send `/newbot`, paste the token (kymavo validates it with `getMe`), then "add the bot to your chat and send it any message", and kymavo lists the chats the bot has seen so the owner taps one instead of typing an id. Chat discovery through `getUpdates` is unverified: it needs no webhook to be set on the bot, so check the Bot API page.

**PayMongo.** Guided paste only. Ask for the secret key. Creating the webhook through the API with that key, so the owner no longer pastes `whsk_`, is a worthwhile simplification but unverified because the PayMongo docs could not be opened. Live mode stays behind `PAYMONGO_LIVE` and the owner's own business verification.

**Airtable.** Replaces three pasted values. After consent kymavo lists bases (`schema.bases:read`), then tables, so the table id is chosen from a list, which also closes security review M16 by construction. Refresh tokens are invalidated after 60 days of inactivity and are revoked if reused after rotation (confirmed), so the worker needs a keepalive refresh (5.4).

**Notion.** The consent screen's page picker replaces "share the database with the integration" by hand. Notion's docs say new public connections mint a fresh token pair on each authorisation and refresh returns a new refresh token (confirmed). Treat tokens as rotating, and also handle tokens that never expire. kymavo still finds the database's title property after the user picks it.

**Trello.** Use OAuth 2.0 with a confidential client: access tokens last one hour, refresh tokens 90 days and rotate, `offline_access` is needed to get one (confirmed). After consent kymavo lists boards and lists so the list id is chosen, not typed.

## 5. The shared OAuth core

One module, `packages/db/src/oauth/` (provider-neutral logic) and `apps/api/src/oauth.ts` (routes), plus one UI component. Providers are data (URLs, scopes, extra parameters, whether PKCE is used), not copies of code. Outlook becomes the first provider on it.

### 5.1 Configuration: development and production

- One OAuth app per provider per environment. Never share a client between dev and prod.
- Google: a `daloy-dev` Cloud project (consent screen in Testing, redirect `http://localhost:3000/settings/connections/oauth/callback`, up to 100 listed test users, refresh tokens last seven days, all confirmed) and a `daloy-prod` project (consent screen In production, verified, redirect `https://<production host>/settings/connections/oauth/callback`).
- Env vars, read at boot, never stored in the database: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `AIRTABLE_CLIENT_ID`, `AIRTABLE_CLIENT_SECRET`, `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `TRELLO_CLIENT_ID`, `TRELLO_CLIENT_SECRET`, and the existing `MICROSOFT_*`. Public values for the Picker: `GOOGLE_PICKER_API_KEY` (a browser key restricted by referrer) and `GOOGLE_PROJECT_NUMBER`. Picker needing both is unverified.
- Redirect URI is always built from `PUBLIC_URL`, as Outlook's is (`outlookRedirectUri`). One callback route, `/settings/connections/oauth/callback`, for every provider. The existing Outlook route stays as an alias until its phase lands, so the redirect already registered in Entra keeps working.
- A provider with no client configured shows its current paste form and nothing else. A self-hosted installation with no clients behaves exactly as today. A self-hosted installation can register its own clients ("bring your own") and get the same buttons.
- Boot check: when `PUBLIC_URL` is not `localhost` and the Google client id belongs to the dev project, refuse to start. Achieved by an explicit `OAUTH_ENV=development|production` variable that must match the redirect host class. This prevents the dev client reaching real customers and the prod client being used from a laptop.
- Provider base URLs (authorize, token, revoke, userinfo) go through `providerUrls()` with env overrides, so tests and e2e point at the fakes.

### 5.2 Start, state, PKCE, callback

1. `POST /settings/connections/:provider/oauth/start`. Guards: `SessionGuard`, `Allow(MANAGE)`, `RateLimit(10)`. It creates an `oauth_flows` row (section 7): a 32-byte random state (only its SHA-256 stored), a PKCE verifier from `randomBytes` (stored encrypted with the secrets key, workspace and flow id as associated data), the member, the workspace, the provider and a 10 minute expiry. It returns `{ url }` for the page to open. Nothing about the user is inside the state value; it is an opaque token.
2. The browser goes to the provider with `state`, `code_challenge` (S256) when the provider supports PKCE, the minimum scopes from the in-code manifest, and `redirect_uri`.
3. `GET /settings/connections/oauth/callback`:
   - The flow is looked up by `sha256(state)` and consumed with one guarded UPDATE: `consumed_at is null and expires_at > now() and member_id = <session user> and workspace_id = <session workspace>`, returning the row. No row means the outcome `expired` and nothing else happens. A second use of the same state, or a state started by someone else, changes nothing. A managing role is checked again.
   - A provider `error` parameter maps to a closed outcome (`declined`, `admin_required`, `failed`) through a per-provider function, as `consentOutcome` does for Microsoft. Provider text never reaches the page.
   - The code is exchanged at the token endpoint with the client secret from env and the verifier, 10 second timeout.
   - The response is checked: the granted scopes include every required scope (else outcome `missing_scope`, nothing saved), a refresh token is present where the provider has them, and the token type is bearer.
   - The identity is read (Google userinfo, Slack team id, Microsoft `/me`, Airtable whoami, Notion bot owner, Trello member) to get `external_id` and a display `account`.
   - One transaction saves the connection (section 7 columns). A reconnect to the same `external_id` keeps the destination. A different `external_id` clears it and the next steps ask for a new pick.
   - The browser is redirected to `/#/apps/<provider>-<outcome>`, where `<outcome>` comes from a closed list in code. No parameter chooses the target.
   - Response headers: `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. The code is single use and the callback answers with a 302 at once, so it is not rendered into a page or kept in history.
4. The administrator-consent callback that Outlook has today stays the only branch that needs no session, and it stores nothing.

### 5.3 Token storage

The credential stays one encrypted string in the existing columns, with the same associated data. For OAuth connections its plaintext is a versioned JSON blob: `{ v: 1, accessToken, accessExpiresAt, refreshToken, prevRefreshToken?, scope }`. Storing the access token in the database, not only in process memory, lets a second worker use a token the first one just refreshed instead of refreshing again. Service account and paste credentials are unchanged, and `auth_method` (section 7) says which shape a row has. Plaintext tokens exist only in memory inside `withFreshToken`, never in a log line, an error message, a run, a delivery payload or a prompt.

### 5.4 Refresh with a lock

`withFreshToken(db, key, urls, workspace, provider, fn)`:

1. Read the connection. If the access token is valid for at least two more minutes, call `fn(accessToken)`.
2. Otherwise open a transaction and `SELECT ... FOR UPDATE` the connection row, with `lock_timeout` of 15 seconds. This row lock is the cross-process lock. Re-read the credential under the lock: if another worker refreshed while this one waited, use its token.
3. Otherwise call the token endpoint with the refresh token (10 second timeout). On success write the new access token and the new refresh token (when one was returned) to the same row in the same transaction, moving the old refresh token to `prevRefreshToken`, then commit.
4. Outcomes. `invalid_grant` or a revoked grant: mark the connection `failed` for this revision, throw a `ProviderError` of kind `auth`. 429 and 5xx and network errors: throw `quota` or `unavailable` and leave the row untouched. A provider error that says the previous refresh token is still accepted (Notion keeps two, confirmed from the MCP page, unverified for ordinary integrations) is retried once with `prevRefreshToken`.
5. A 401 from the API after a "valid" token forces one refresh through the same path, once, as the current code does.

Refresh happens before the delivery's booking-lock transaction opens (`attempt()` in `deliveries.ts`), so a refresh never waits on a connection that the delivery transaction holds, and the worker's pool of 20 is not drained by ten deliveries each holding two connections. The existing `rotateInto` for Outlook is replaced by this.

A worker sweep (daily, 20 connections at a time) refreshes OAuth connections that have not been refreshed for half their provider's inactivity window: 60 days for Airtable (confirmed), 90 days for Trello (confirmed), and a safe 30 days elsewhere. This stops an idle workspace losing its grant. A failed sweep marks nothing failed unless the provider says `invalid_grant`.

### 5.5 Disconnect and revoke

`DELETE /settings/connections/:provider` keeps its behavior (delete the row, queued deliveries fail with "not connected" and keep their payload). For OAuth connections it first reads the credential, deletes the row, commits, then revokes at the provider with a 5 second timeout (Google `oauth2.googleapis.com/revoke`, confirmed; Slack `auth.revoke` and Trello token deletion, unverified; Microsoft has no refresh token revoke call that kymavo can use, so the page tells the owner to remove kymavo at the Microsoft account page, unverified). A revoke failure does not block the disconnect. The answer carries `revoked: false` and the page tells the owner where to remove the access by hand. The local credential is deleted first on purpose: a connection must never look disconnected in kymavo while still usable.

Two workspaces connecting the same provider account through the same client may share one grant at the provider, so revoking one could end the other. This is unverified for Google; test it live (section 15, item 5) and, if true, warn at connect when the same `external_id` is already connected in another workspace.

### 5.6 Isolation between workspaces

- Every query carries the session's workspace. Flow rows are bound to workspace and member and are consumed only by that member.
- Associated data includes workspace and provider, so a blob copied between rows does not decrypt (existing property, tested).
- One OAuth client serves all workspaces, so isolation depends on tokens never being keyed by anything but the workspace row. No cache is keyed by provider account alone. The in-memory token caches are removed in favor of the database blob.
- A different workspace's flow, state or connection answers as an expired flow or 404, revealing nothing.

### 5.7 UI

One `ConnectPanel` component used by every provider card: a primary "Connect with <App>" button that calls start and opens the returned URL; the outcome message from the page address; the connected account, its status and its last error; Reconnect; Disconnect with the existing confirmation; and an "Advanced: use a key or token instead" disclosure that holds today's form. A provider without a configured client shows today's form as the main option. The Apps page copy keeps the owner-friendly words already used (Apps, Connected, Needs reconnecting). Picker buttons (6.1) and list pickers (Airtable bases and tables, Trello boards and lists) are separate small components. English and Tagalog strings go in the existing string tables.

### 5.8 Backward compatibility

- Migration is additive. Every existing row gets `auth_method` of `service_account`, `token` or `webhook_url` by provider and keeps working with no action.
- Existing queued deliveries and pins are untouched. A workspace that moves from a service account to OAuth changes `account` and `external_id`; see risk R7 for what happens to what is queued.
- Workflows reference steps (`sheets`, `slack`, `calendar` and so on), never credentials, so no definition changes.
- The service account, bot token and other paste paths stay supported and tested.

## 6. Google design

### 6.1 Sheets, Drive and the Picker

- One scope, `drive.file`, for both Sheets and Drive. The Sheets scopes page recommends it and says an app can reach only files the user opens with the Picker or that the app creates (confirmed).
- Easy connect has two choices after consent, both needing no ids: **Create a sheet for me** ("kymavo requests", created through the API under `drive.file`) and **Pick an existing sheet** (Picker). Drive works the same way: **kymavo creates a "kymavo uploads" folder** by default, or the user picks a folder.
- Picker: the web Picker is the supported way to grant per-file access under `drive.file`, and listing a user's spreadsheets through the Drive API would need a restricted scope (confirmed). It can show only spreadsheets and can limit to folders (confirmed in outline, code unverified). Spreadsheets, documents and folders all work through the same Picker; kymavo has no Docs step today, so only spreadsheet and folder views are built. The document view waits for a step that needs it.
- The Picker needs an access token in the browser. `POST /settings/connections/google-sheets/picker-token` (owner only, rate limited, `Cache-Control: no-store`) returns a one-hour access token for `drive.file` only. Its reach is the files kymavo created and the user picked. Alternative: Google Identity Services in the browser gets its own token with a second popup, so the server never hands a token to the page. Recommendation: server-minted, because it is one fewer popup for a no-code owner and the scope is narrow. Owner to confirm (open question 6).
- The Picker loads Google scripts, so the console's content security policy gets the Google hosts for scripts and frames, and a test checks the policy is no wider than that.
- The page sends back the picked id only. The server re-reads the file with its own stored token (`sheetInfo`), which fails for any id the grant cannot reach, so a forged id gains nothing. The tab becomes a dropdown of real tab names instead of a typed name.
- Free improvement over the service account: a user's own My Drive works, so the "shared drive only" limit (`driveFolderInfo`) goes away for OAuth connections.
- To verify live before building on them (unverified): developer metadata markers under `drive.file` (`appendRowOnce`), creating a file inside a Picker-chosen folder, and what happens to picked-file access after a disconnect and reconnect (assume it is lost and the pick must be repeated, and design the "needs picking again" state for it).

### 6.2 Calendar

The Picker does not apply to calendars. Default: kymavo creates a calendar named "kymavo bookings" in the owner's account and uses the narrowest scope that allows it (`calendar.app.created`, which covers calendars the app creates and their events, confirmed). To use an existing calendar the owner needs `calendar.events` plus `calendar.calendarlist.readonly` for a list, both sensitive-reviewed if sensitive. Whether `calendar.events` is sensitive or restricted is unverified: a vendor guide says restricted, another says sensitive, and Google's own page text did not settle it. Check the consent screen "Data access" page in the Cloud console before choosing, and do not request it if it turns out to be restricted. M11 and M12 handling (event bound to its calendar, ordered writes) is unchanged.

### 6.3 Gmail

- Send through the Gmail API `users.messages.send` with `gmail.send` (sensitive, confirmed), building the message with nodemailer's stream transport so every header and the plain-text behaviour stay as now. SMTP with OAuth would need the full `https://mail.google.com/` scope, which is restricted (unverified, treat as true).
- The IMAP inbox trigger keeps its app password. Reading mail needs `gmail.readonly`, a restricted scope with a paid annual assessment (confirmed), which this plan avoids.
- `mail_senders` stays the owner of the sender invariants of decision 0020 (no fallback to another sender, failed or disconnected blocks the send). A new `auth_method` says which transport applies. Google returns a verified address, so OAuth replaces the verification email as proof of ownership. A test email to the owner's own address stays.
- A Gmail grant stops working after a password change (confirmed). The status goes to failed and the page says "Reconnect Gmail", with the existing rule that nothing falls back to another sender.
- Gmail's daily sending limits still apply to the owner's account. kymavo's own per-workspace cap (`MAILBOX_DAILY_CAP`) stays.

## 7. Database changes

Next migration number is 0037 (0036 is the latest). All changes are additive and go in one migration in P1 so parallel provider phases never collide on migration numbers.

**New table `oauth_flows`**

| Column | Type | Purpose |
|---|---|---|
| `id` | uuid pk | |
| `state_hash` | text unique | SHA-256 of the random state |
| `workspace_id` | uuid fk users on delete cascade | |
| `member_id` | uuid fk users on delete cascade | Who started it |
| `provider` | text | Checked against the provider list |
| `verifier_ciphertext`, `_iv`, `_auth_tag` | text | PKCE verifier, encrypted with workspace and flow id as associated data |
| `expires_at` | timestamptz | Ten minutes after start |
| `consumed_at` | timestamptz null | Set by the single guarded UPDATE at the callback |
| `created_at` | timestamptz | |

A worker sweep deletes rows a day after they expire. Check constraint on provider. Index on `expires_at`.

**`connections` new columns**

| Column | Type | Purpose |
|---|---|---|
| `auth_method` | text not null, check in (`token`, `service_account`, `oauth`, `webhook_url`) | Says what the credential is. Backfill: Google Sheets, Calendar, Drive as `service_account`; Teams as `webhook_url`; everything else `token`; Outlook as `oauth`. |
| `external_id` | text null | The provider's stable account id: Google `sub`, Slack team id, Microsoft object id, Airtable user id, Notion bot or workspace id, Trello member id |
| `scopes` | text null | Granted scopes, space separated |
| `oauth_client_id` | text null | The client the grant came from, so a changed client id marks connections for reconnect instead of failing in a loop |
| `access_expires_at` | timestamptz null | For the sweep and the cheap "is it fresh" check without decrypting |
| `refreshed_at` | timestamptz null | For the keepalive sweep |

**`deliveries`**: `pinned_external_id` text null. Copied from the connection when queued, compared when sent (R7). Null for rows queued before the migration, which compare on `pinned_account` as now.

**`mail_senders`**: `auth_method` text not null default `app_password` (check in `app_password`, `oauth`), plus `external_id`, `scopes`, `access_expires_at`, `refreshed_at`. The OAuth blob reuses the existing `password_*` columns, with a comment saying so, to avoid a parallel set of encrypted columns.

**No change** to the `connections` primary key, to `PROVIDERS`, or to delivery states. No new provider is needed for Gmail.

**Retention.** Revoked or deleted connections leave nothing behind. The flow table keeps no secret after consumption beyond the encrypted verifier, which the sweep deletes.

## 8. Google verification: steps and timeline

Facts marked confirmed come from Google's documentation as returned by search on 18 November 2026.

What needs review and what does not:

| Scope | Class | Review |
|---|---|---|
| `openid`, `email`, `profile`, `drive.file` | Non-sensitive (confirmed for `drive.file`) | No scope review. Whether an unverified app with only these scopes still shows a warning or the 100-user cap is unverified. Google states the 100-user cap for unverified apps requesting sensitive or restricted scopes (confirmed). |
| `gmail.send` | Sensitive (confirmed) | Sensitive scope verification, up to 10 business days (confirmed). No independent security assessment. |
| `calendar.app.created`, `calendar.events` | Unverified | Sensitive at most. Settle in the console. |
| `gmail.readonly`, full `drive`, `https://mail.google.com/` | Restricted (confirmed) | Security assessment by a Google-approved assessor, repeated every 12 months, several weeks, fee range $500 to $4,500 per Google's Health API page and about $540 at one vendor in 2024 (unverified current price). Avoided by this plan. |

Steps and rough timing, counted from the owner starting P0:

1. Week 0 to 1. Pick the production domain and put a homepage, a privacy policy and terms of service on it. Google requires these for the consent screen (policy requirement stated from memory, unverified in detail). The homepage must explain the Google features.
2. Week 1. Create `daloy-prod`, set the consent screen to External, add the authorized domain and verify the domain in Search Console (free), upload the logo, request brand verification: 2 to 3 business days (confirmed).
3. Week 1 to 2. Create `daloy-dev` in Testing with test users.
4. After P2 runs on a staging host with the production client: publish the consent screen to In production. With only non-sensitive scopes, Sheets and Drive can go to customers while later scopes wait.
5. After P5 (Gmail) and P6 (Calendar) run on staging: submit the sensitive scopes with a justification per scope and a demo video of the consent screen and each feature (video requirement from memory, unverified). Review is up to 10 business days (confirmed). Plan for one round of questions that adds a week or more (unverified).
6. Approved scopes can be called before the user cap bites: an unverified app that requests sensitive scopes is capped at 100 users (confirmed), so ship Gmail and Calendar to customers only after approval.
7. Re-check whenever a scope is added: a new scope needs approval before it can be called (confirmed).
8. Calendar timeline: end to end about four to six weeks for the sensitive scopes, mostly waiting. Sheets and Drive do not wait on it.

## 9. Flags against "free and open-source only, no paid service"

1. **Restricted Google scopes need a paid assessment** and an annual repeat. Avoided: no `gmail.readonly`, no full `drive`, no `https://mail.google.com/`. This is why the IMAP trigger keeps its app password and why Drive uses `drive.file`. A decision record should state this limit so nobody adds a restricted scope later.
2. **A domain you own.** Google's consent screen needs a verified authorized domain, and Microsoft publisher verification needs a publisher domain that is not `onmicrosoft.com` (confirmed). The project today is on `daloyapp.pages.dev` and a Cloudflare Tunnel. Whether a `pages.dev` subdomain can be verified as an authorized domain is unverified and probably not (it is a shared suffix). A domain costs a yearly fee. This is the one likely paid item. The owner decides whether it is acceptable.
3. **Microsoft Partner Center account** for publisher verification: free (confirmed), but needs the business to be verified. It is a paperwork cost, not money.
4. **Slack Marketplace** listing: no fee found, but it needs at least five active workspace installs (confirmed from a July 2025 change summary), and Slack's terms say the Marketplace is the appropriate channel for commercial distribution (confirmed from a summary). The plan does not list on it. Read the terms before charging customers for an unlisted app.
5. **PayMongo linked accounts** needs a registered business and approval, so it is not used.
6. **Google Cloud project billing**: the APIs used here are free, and whether a project can be created without a billing account is unverified (the owner already accepted a card for the VM in N3).
7. **Privacy policy and terms pages** are required by Google, Airtable and Slack. They are free to host on the existing Pages site but someone must write them. They should be real and match what kymavo does.
8. **Cost to customers**: none of the OAuth apps charges per user. PayMongo, SMS and AI costs are unchanged.

## 10. Security risks and mitigations

| # | Risk | Mitigation | Test |
|---|---|---|---|
| R1 | CSRF or a swapped code at the callback | Opaque random state stored hashed, single use through a guarded UPDATE, ten minute expiry, bound to the member and workspace, and the session must be the same member with a managing role. PKCE S256 where the provider supports it (Google, Microsoft, Airtable per forum, Notion and Slack unverified), verifier random and stored encrypted, never in the URL. | Wrong member, other workspace, replayed state, expired state, missing state, code with a wrong verifier (fake provider refuses). |
| R2 | Open redirect | The callback never reads a redirect target. It sends the browser to `/#/apps/<provider>-<outcome>` with the outcome from a closed list in code. The `redirect_uri` sent to providers is built from `PUBLIC_URL`, never from input. | Callback with extra `redirect`, `next` and `return_to` parameters still lands on the fixed page. |
| R3 | Tokens in logs | Code, state and tokens are never logged or put in an error message. The callback is a 302 with `Referrer-Policy: no-referrer` and `no-store`. Request logging must not record query strings for the callback path (whether any access log exists is unverified; check). Provider error mapping returns kymavo's own text. | A recording logger plus a failing fake provider: assert no token, code or state in any log, error or response. |
| R4 | Tokens in run history, delivery payloads, CSV exports or AI prompts | Tokens exist only inside `withFreshToken`. The history hider's list of values to hide adds the active connection tokens as defense in depth (`secretValuesToHide` today covers only workspace secrets). The AI prompt allowlist is unchanged and tested. | A fake provider that echoes the token in an error body: run history, Activity, CSV, delivery list and the explain and Ask prompts show `[secret]` or nothing. |
| R5 | Scope creep | Scopes live in one manifest in code per provider and feature. A unit test snapshots the manifest and the generated authorize URL, so a pull request that adds a scope fails until the snapshot, this plan or its decision record, and the Google submission are updated. Restricted scopes are listed as forbidden in the same test. Granted scopes are stored and shown to the owner. | Snapshot test, forbidden-scope test, a grant narrower than requested is refused. |
| R6 | Refresh token loss | Row lock across processes (5.4). The new token pair is written in the same transaction that received it. The previous refresh token is kept for one generation where the provider tolerates it. A crash between the provider's answer and the commit loses the new token but not the old one (provider side, which for strictly rotating providers marks the grant failed, and the owner reconnects, with an email and a clear message). Daily keepalive so idle workspaces do not expire. | Two workers refreshing together against a fake that rotates and rejects reuse: exactly one refresh happens. Crash injection after the fake answers. Idle connection kept alive. |
| R7 | A pinned delivery whose connection was re-authorized | Same provider account (`external_id`) and same destination: only the credential changes, deliveries continue. A different account or destination: the existing `destination_changed` review applies, with the account compared by `external_id` and not by an email that can change or be reassigned. Moving from a service account to OAuth changes `account` and `external_id`: for providers where identity does not change where data goes (Sheets, Drive, Calendar with the same sheet, folder or calendar id) the pin compares only the destination and the delivery proceeds, and for identity-bearing ones (Gmail, Outlook) it goes to review. Decision for the owner (open question 7). With `drive.file`, a reconnect may lose access to a picked file, so the delivery fails with a permission error that says "pick the sheet again". | Reconnect same account, reconnect other account, service account to OAuth, queued delivery in each case. |
| R8 | A disconnected or revoked account mid-run | Each attempt reads the connection fresh, so a removed row is "not connected" with the payload kept (existing). A provider answer of 401 or `invalid_grant` mid-send marks the connection failed for that revision and the delivery fails with kind `reconnect`. A send already on the wire when the owner disconnects may still land. Ambiguous outcomes keep today's rules (Sheets and Calendar re-check, Slack, Outlook, Gmail and the rest go to review). The owner gets one email per connection per day on failure, like the watchdog (proposed). | Disconnect during a held fake request, revoke at the provider during a refresh, each across Sheets and Slack. |
| R9 | Granular consent: the user unticks a scope | The token response's scopes are compared with the manifest. A missing required scope saves nothing and shows "kymavo needs permission to X". | Fake provider returns a narrower grant. |
| R10 | Login CSRF: attacker links their account to a victim's workspace | The flow is bound to the member who started it and the callback requires that member's session, so an attacker cannot finish a flow in the victim's browser and cannot start one that the victim's session would complete. | Attacker state used by a victim session is refused. |
| R11 | Picker token exposure in the console | Narrow scope (`drive.file`), one hour, owner only, no-store, never logged. A cross-site script in the console could read it, but the console session already allows more than that token does. Content security policy extended only for the Google hosts. | CSP test, token endpoint role matrix. |
| R12 | Forged or foreign picked file id | The server re-reads the file with its own token. Google refuses ids outside the grant. | Fake returns 404 for an id not picked. |
| R13 | Dev client or secrets used in production, or the reverse | `OAUTH_ENV` boot check against `PUBLIC_URL`. Client secrets only from env. The `oauth_client_id` column marks connections for reconnect when the client changes. | Boot refuses mismatched config. |
| R14 | One grant shared by two workspaces ends when one disconnects | Warn at connect. Detect on failure and show Reconnect. Verify live (unverified). | Live check. |
| R15 | Outlook or Google token refresh storms taking the database | Lock timeout, short outbound timeout, refresh before the delivery transaction, pool left for the worker. | Concurrency test at the worker's batch size. |
| R16 | An account owner leaves the office or a member's password changes | Connection belongs to the workspace, not to a member. The member who connected is recorded in the flow row only. A removed member's access to the provider account is not kymavo's to end, and the owner is told to disconnect if the connecting person left. Gmail tokens stop on a password change (confirmed). | Member removal does not break deliveries. |

## 11. Tests required

Everything uses the fake providers in `test/fake-providers.ts` and a disposable database. No test contacts a real provider.

**Fakes to add in P1 and P2.** Authorize endpoint (consent, decline, narrower grant, administrator required), token endpoint (code and refresh, rotation, reuse rejection, invalid_grant, 429, 5xx, slow), revoke, userinfo, Slack `oauth.v2.access`, Airtable, Notion and Trello token endpoints, a Gmail send endpoint and a Picker stand-in. The Picker is an iframe and cannot be driven in e2e, so the UI takes a `pick()` function and Playwright supplies a fake. The real Picker is covered only by the manual live check.

**P1 (core).**
- Unit: state generation and single-use consumption under concurrency, expiry, wrong member, wrong workspace, PKCE challenge and verifier, scope manifest snapshot, forbidden scopes, redirect URI built from `PUBLIC_URL`, boot check for `OAUTH_ENV`.
- Refresh lock: N workers in parallel get one refresh against a rotating fake that rejects reuse. Crash after the provider answers. Prev-token fallback. 429 and 5xx leave the row unchanged. Keepalive sweep.
- Isolation: two workspaces, the same provider account in both, no cross-use of a token, a copied ciphertext fails to decrypt, other workspace's flow answers as expired.
- Disconnect: revoke succeeds, revoke fails and the row is still gone with `revoked: false`, queued deliveries keep their payload.
- Leakage: tokens never appear in logs, errors, run history, Activity, CSV, delivery list, explain or Ask prompts.
- Migration: a database at 0036 with every provider connected upgrades, every credential still decrypts and works, pins unchanged (extend `apps/api/src/upgrade.test.ts`).
- Role matrix: start, callback, disconnect and picker-token for owner, operator, approver, requester and signed out (extend the route matrix in `members.test.ts`).
- Outlook regression: every existing Microsoft test passes unchanged on the new core, including administrator consent and rotated refresh tokens.

**Per provider phase (P2 to P6).**
- Consent success, decline, missing scope, wrong account on reconnect, reconnect keeps or clears the destination as designed.
- A delivery before and after re-authorization, same and different account (R7).
- Service account or paste connection still works, and its form is still the fallback when no client is configured.
- Provider specific: Sheets created for the user, Picker id re-verified, markers under `drive.file` (fake only, live later); Slack team id as identity and channel list; Airtable base and table lists and table id check (M16); Notion title property after pick; Trello board and list pick; Gmail sends through the API with identical headers and no fallback sender when failed; Calendar with a Daloy-created calendar.
- Playwright: Connect, outcome message, test action, Disconnect, for each provider, with the fake authorize page.

**P7 (guided pastes).** Wizard steps render, the live test runs, the Telegram chat list shows only chats the bot has seen, PayMongo webhook creation through a fake.

**P8.** Final review reruns every R1 to R16 case on the release commit.

**Live checks the owner runs by hand** (add to `docs/live-*-check.md`): one real Google consent in the dev project (Sheets row with markers, Drive upload into a created and a picked folder, Picker, revoke), Gmail send, Calendar, Slack install, Outlook, Airtable, Notion, Trello. Each is marked unverified in the README until run.

## 12. Phases, parallelism, complexity and models

Complexity is the rough size of one phase: S under one session, M about one, L about two, XL about three. These are estimates. Model and effort follow the AGENTS.md table: Opus 5.5 high for security-heavy work, Sonnet 5.5 for approved mechanical work, with the Codex equivalents.

| Phase | What | Complexity | Claude | Codex | Depends on |
|---|---|---|---|---|---|
| P0 | Owner setup, no code: domain, privacy and terms pages, Google dev and prod projects, brand verification request, Slack, Entra (and publisher verification), Airtable, Notion and Trello apps, client ids into env. Write `docs/oauth-setup.md` once the plan is approved. | S, mostly waiting | Owner by hand. Setup doc: Sonnet 5.5 low | GPT-6.1 Terra | none, starts now |
| P1 | Shared core: migration 0037, `oauth_flows`, state, PKCE, callback, token blob, `withFreshToken` and lock, keepalive, revoke, `ConnectPanel`, provider data structure, fakes, scope manifest test, Outlook moved onto it, history hider addition. Decision records. | XL | Opus 5.5 high | GPT-6.1 Sol High | none (P0 can lag) |
| P2 | Google Sheets and Drive: `drive.file`, create-for-me, Picker with token endpoint and CSP, tab dropdown, service account kept as advanced, live check doc. | L | Opus 5.5 high | GPT-6.1 Sol High | P1 |
| P3 | Slack install (OAuth v2), team id identity, existing channel picker, own-token advanced. | M | Sonnet 5.5 high | GPT-6.1 Sol Medium | P1 |
| P4 | Airtable (base and table pick, closes M16 in the OAuth path), Notion (page picker consent), Trello (OAuth 2.0, board and list pick). | L | Sonnet 5.5 high | GPT-6.1 Sol Medium | P1 |
| P5 | Gmail through the Gmail API: `mail_senders` OAuth, `resolveSender` with the new transport, no fallback, test email, reconnect after password change. | L | Opus 5.5 high | GPT-6.1 Sol High | P1, and P2's Google module |
| P6 | Calendar: Daloy-created calendar, optional existing calendar, M11 and M12 behavior kept. | M | Sonnet 5.5 high | GPT-6.1 Sol Medium | P1, P2's Google module |
| P7 | Guided pastes: Telegram wizard with chat discovery, Teams wizard, PayMongo guided key and webhook creation. | M | Sonnet 5.5 medium | GPT-6.1 Sol Medium | none technically; run after P3 to avoid conflicts in `Connections.tsx` |
| P8 | Final security review of the OAuth work, threat model and how-it-works rows, README live-check list, Google sensitive scope submission pack and demo script. | M | Review: Opus 5.5 high. Docs: Sonnet 5.5 low or medium | Review: GPT-6.2 Astra, Extra High. Docs: GPT-6.1 Terra | P2 to P6 |

Parallel runs: P2, P3 and P4 can run at the same time once P1 is merged, in separate worktrees (AGENTS.md). P5 and P6 start after P2 lands the shared Google module, and can run at the same time as each other. P7 can start whenever, but to limit conflicts run it after P3.

Conflicts to expect: every provider phase touches `apps/web/src/Connections.tsx`, `packages/db/src/providers.ts` (the URL list) and the fake provider file. P1 reduces this by moving provider data into new files (`packages/db/src/oauth/<provider>.ts`, `apps/api/src/oauth-<provider>.ts`) and by owning the single migration. Each phase report must say which of these files it changed.

Ship order for customers: Sheets, Drive, Slack, Airtable, Notion, Trello, Outlook need no Google review and can go as soon as their phase passes. Gmail and Calendar go after the Google sensitive scope review.

Rollout: a provider's button appears only when its client env vars are set, so each phase can merge dark and be switched on by the owner per environment.

## 13. Decisions proposed for `docs/decisions/` after approval

Written only after the owner approves, one per phase.

1. Shared OAuth core: one-time flow table instead of the signed stateless state, row lock for refresh, access tokens stored encrypted, revoke after delete.
2. Minimum scopes and forbidden restricted scopes, with the scope manifest test.
3. Google: `drive.file` for Sheets and Drive, Picker with a server-minted token, created-for-you sheet and folder.
4. Gmail: Gmail API with `gmail.send`, app password kept for IMAP.
5. Pinning rules across re-authorization (R7).
6. Which providers stay manual and why (Telegram, Teams, PayMongo).

## 14. Open questions for the owner

Each has a recommendation, so a plain "go with the recommendations" is a valid answer.

1. **Domain.** Is paying for a domain acceptable? Google verification and Microsoft publisher verification both need one, and `pages.dev` probably will not qualify (unverified). Recommendation: yes, one domain, used for the app, the policy pages and the Google and Microsoft apps.
2. **Who runs the production OAuth apps?** One production Google, Slack, Airtable, Notion, Trello and Entra app owned by the owner, used by the hosted service. Self-hosted installs register their own. Recommendation: yes.
3. **Scope of the first release.** Ship Sheets, Drive, Slack, Airtable, Notion and Trello first (no Google review), and Gmail and Calendar after review. Recommendation: yes.
4. **Calendar default.** A calendar kymavo creates ("kymavo bookings", narrowest scope) versus the owner's existing calendar (broader scope, a list screen, possible sensitive review). Recommendation: kymavo creates its own, with existing-calendar and service account as options.
5. **Gmail.** Accept that the inbox trigger stays on an app password because reading mail needs a paid assessment. Recommendation: yes.
6. **Picker token.** Server-minted `drive.file` token (one popup) versus Google Identity Services in the browser (a second popup, no token handed to the page). Recommendation: server-minted.
7. **Re-authorization and pinning (R7).** When a service account is replaced by OAuth for the same sheet, folder or calendar, should queued deliveries go on without review? Recommendation: yes for destination providers, no for Gmail and Outlook.
8. **Slack distribution.** Slack's terms point commercial distribution to the Marketplace. Recommendation: install through OAuth without listing, read the terms, and decide before charging. Ask Slack if unclear.
9. **Personal Microsoft accounts.** Outlook uses `organizations` today. Allow personal accounts too? Recommendation: no, not until a pilot asks.
10. **Owner emails on a broken connection.** One email per connection per day when a grant stops working. Recommendation: yes, reuse the watchdog mailer.
11. **Trello and Notion OAuth details** and **PKCE support** for Slack and Notion are unverified. Recommendation: the P4 and P3 sessions read the live pages first and report before building.
12. **Replace PROJECT.md N24.** This plan supersedes it (a verified public consent screen is now in scope). Recommendation: yes, edit PROJECT.md when the plan is approved. It was not edited here.

## 15. Sources and what is unverified

Sources, all found through web search on 18 November 2026 (not opened directly):

- Google: [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), [OAuth app verification help](https://support.google.com/cloud/answer/13463073), [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes), [Picker overview](https://developers.google.com/workspace/drive/picker/guides/overview), [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth), [OAuth for web server apps](https://developers.google.com/identity/protocols/oauth2/web-server), [Manage app audience](https://support.google.com/cloud/answer/15549945), [Health API app verification (assessor fee range)](https://developers.google.com/health/app-verification).
- Slack: [Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [Token rotation](https://docs.slack.dev/authentication/using-token-rotation/), [Rate limit changes for non-Marketplace apps](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/).
- Microsoft: [Publisher verification overview](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview), [Mark an app as publisher verified](https://learn.microsoft.com/en-us/entra/identity-platform/mark-app-as-publisher-verified), [Send a channel message](https://learn.microsoft.com/en-us/graph/api/channel-post-messages?view=graph-rest-1.0).
- Airtable: [OAuth integrations](https://airtable.com/developers/web/guides/oauth-integrations), [Third-party integrations via OAuth](https://support.airtable.com/articles/6811769763-third-party-integrations-via-oauth-overview), [Builder Hub](https://support.airtable.com/articles/9362950318-using-builder-hub-in-airtable).
- Notion: [Authorization](https://developers.notion.com/guides/get-started/authorization), [Public connections](https://developers.notion.com/guides/get-started/public-connections).
- Trello: [OAuth 2.0 now available](https://community.developer.atlassian.com/t/oauth-2-0-3lo-is-now-available-for-trello/102691), [Authorizing with Trello's REST API](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/), [OAuth 2.0 confidential client usage](https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-confidential-client-usage/).
- PayMongo: [Linked accounts](https://docs.paymongo.com/docs/account-settings-linked-accounts), [Authentication](https://docs.paymongo.com/reference/authentication-1).
- Telegram: [Bots](https://core.telegram.org/bots), [Login Widget](https://core.telegram.org/widgets/login-legacy).

Unverified list, to resolve against the live pages or consoles before the phase that depends on each:

1. Whether an app with only non-sensitive scopes shows an unverified warning or is capped at 100 users (P2).
2. Whether `calendar.events`, `calendar.app.created` and `calendar.calendarlist.readonly` are sensitive or restricted (P6). Sources disagreed.
3. Picker requirements (API key, app id), folder-only views, and creating files in a Picker-chosen folder under `drive.file` (P2).
4. Developer metadata markers under `drive.file` (P2).
5. Behavior of picked-file access after disconnect and reconnect, and whether two workspaces sharing one Google account and client share one grant at revoke (P2, R14).
6. Google's exact consent screen submission requirements, including the demo video, and review round trips (P8).
7. The current price of the Google restricted scope assessment (not needed while restricted scopes are avoided).
8. Whether a `pages.dev` subdomain can be a verified authorized domain (P0).
9. Whether a Google Cloud project can be created without a billing account (P0).
10. Slack: PKCE support, `chat:write.public`, `auth.revoke`, Marketplace review time and cost, whether non-Marketplace apps may be installed by any workspace without review, and the precise wording of the commercial distribution terms (P3).
11. Microsoft: how unverified publishers affect user consent in other tenants, whether old refresh tokens stay valid after rotation, client secret maximum lifetime, a refresh token revoke call, and whether `ChannelMessage.Send` is metered (P1 Outlook move, P8).
12. Airtable: PKCE requirement, any review step, access token lifetime (P4).
13. Notion: whether ordinary public integration tokens expire and rotate, whether a non-admin member can authorise, and a revoke endpoint (P4).
14. Trello: where an OAuth 2.0 app is registered, whether it needs approval or a fee, PKCE for confidential clients, and token deletion for revoke (P4).
15. PayMongo: webhook creation through the API with a secret key, and what returns the signing secret (P7).
16. Telegram: that `getUpdates` works for chat discovery while no webhook is set (P7).
17. Whether the API has any request access log that records query strings (P1, R3).
