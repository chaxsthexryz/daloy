# 0061: Slack through the OAuth v2 install

## Context

Phase P3 of the managed OAuth plan ([docs/plans/managed-oauth-plan.md](../plans/managed-oauth-plan.md)) replaces "create a Slack app, copy the bot token, paste it" with a Connect Slack button. The shared OAuth core exists ([decision 0058](0058-oauth-core.md)); this record covers what is specific to Slack. Delivery of Slack notes is unchanged ([decision 0021](0021-sheets-slack-deliveries.md)): a queued delivery, a pinned account and channel, and a note that may have arrived goes to review.

Slack's install flow returns a bot token (`xoxb-`) for one Slack workspace. With token rotation off the token does not expire and there is no refresh token. The Slack send code already takes a bot token string.

## Options

Scopes:

1. `chat:write` and `channels:read`, as the pasted-token path documents today.
2. The same plus `chat:write.public`, so Daloy could post in a public channel it was not invited to. The plan lists this as unverified, and the owner's rule is the minimum scope that works.

PKCE:

1. Send a code challenge. Slack documents none for the OAuth v2 install (unverified), and an unknown parameter might be refused.
2. Leave it off. The state is one-time and bound to the member and workspace, and the code is exchanged with the client secret.

What is stored:

1. The bare bot token in the credential, as the pasted path does.
2. The core's token blob (`{ v: 1, accessToken, accessExpiresAt: null, scope }`), so every OAuth connection has the same shape and the history hider already covers its token.

Token rotation: on (12 hour tokens, single use refresh tokens, a refresh lock for Slack) or off (one token that lasts until revoked or the app is removed).

## Decision

- **Scopes: option 1.** Bot scopes `chat:write` and `channels:read` and nothing else. No user scopes: the authorize URL has no `user_scope` parameter. `chat:write.public` is not added; the existing hint stays ("invite the app to the channel", shown by the picker and by the `not_in_channel` error). `oauth/scopes.test.ts` snapshots the scopes and the whole authorize URL, and asserts that no `user_scope` is sent and that `chat:write.public` is absent.
- **PKCE: option 2.** `pkce: false` in `oauth/slack.ts`, with the reason in a comment. Turn it on only after the live check shows Slack accepts and enforces a challenge.
- **Stored credential: option 2.** An OAuth connection holds the blob, and a pasted one still holds the bare token. `slackToken(conn)` returns the bot token from either (by `authMethod`), and the delivery, channel list, channel save and test routes use it. The token never expires, so there is no refresh before a send; `attempt()` still calls `freshToken`, which returns at once for a blob with no expiry. A Slack answer of `invalid_auth`, `token_revoked` or `account_inactive` marks the connection failed, as for a pasted token.
- **Rotation: off.** The Slack app is set up without it, and `refreshTokens: false` tells the core there is no refresh token to require or use.
- **Identity.** The stable account id is the Slack team id and `account` is the team name, both read with `auth.test` (the existing `slackIdentity`, which now also returns `teamId`). A reconnect to the same team id keeps the chosen channel; another team clears it (the core's rule for every provider), because Slack channel ids belong to one workspace. A pasted token connection has no team id stored, so converting it to OAuth clears the channel and the owner picks it again.
- **Granted scopes.** The token answer's `scope` (comma separated) must include both required scopes. Otherwise nothing is saved and the page shows "Some of the permissions Daloy asked for were not allowed".
- **Consent errors.** `access_denied` is `declined`, anything else is `failed`. Slack's admin approval step, when a workspace requires one, may not redirect back with an error (unverified), so the card says an admin may have to approve the app.
- **Revoke.** Disconnect deletes the row, then calls `auth.revoke` with the bot token (5 seconds). It answers HTTP 200 with `ok: false` when it did not revoke (unverified), so the definition says an answer counts only when `ok` is true. A failure never blocks Disconnect; the page then tells the owner to remove the app in Slack under Manage apps.
- **Pinning (R7).** Deliveries compare the team id when both sides have one, otherwise the account name, then the destination. Same team: the new token is used and the note goes on. Another team: the channel is cleared, so a note fails with "No channel is chosen"; if the owner picks a channel in the new team first, the existing destination rule sends it to review with both sides named. A pasted token replaced by an OAuth grant for a workspace of the same name has no pinned team id, so the name is compared and the note goes on once the channel is picked again.
- **Core additions, all optional fields with today's behaviour as the default.** `tokenTypes` (Slack calls the token a `bot`, the core accepted only `bearer`), `scopeSeparator` (Slack documents a comma), `revokeAccepted` (the answer check above), and the keepalive sweep now skips a provider with no refresh tokens. Without that last change a forced refresh of a Slack connection would find no refresh token and mark a healthy connection failed, 30 days after it was made. Tested in `slack-oauth.test.ts` (keepalive).
- **Environment.** `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` (read by `providerUrls()` as `slackClient`), and the existing `SLACK_API_URL` for the base. Both client variables must be set, or the card keeps the paste form as the main option. The redirect URL to register at Slack is `<PUBLIC_URL>/settings/connections/oauth/callback`. `OAUTH_ENV` is required by the boot check as for the other providers.
- **UI.** The Slack card is a `ConnectPanel` with "Connect Slack" (the label decision 0058 chose; the plan's "Connect with Slack" is shown as "Connect Slack" like Outlook). The channel picker, the test message and the error hints stay. The pasted token sits under "Advanced: use your own Slack app token", with its button reading "Save token". Without a client the card is today's token form. English and Tagalog strings are in the existing tables.
- **No new dependency.**

## Consequences

- The e2e installation now has a Slack client, so the three existing e2e specs that paste a Slack token open the Advanced section first. The paste path itself is unchanged and still tested through the API (`slack-oauth.test.ts`, `connections.test.ts`).
- One Slack app serves every Daloy workspace. Isolation is the core's: tokens are keyed by the workspace row and bound with associated data.
- Two Daloy workspaces installing the same Slack app into the same Slack workspace may be given the same bot token by Slack, so revoking one could end the other (plan R14). Unverified, listed in the live check.
- Slack's commercial distribution terms may require the Marketplace for a paid, widely distributed app (summary only, plan section 9 item 4). Daloy does not list on the Marketplace. Read the terms before charging customers for the hosted service with Slack, and ask Slack if unclear.
- Unverified, as in the plan (section 15 item 10) and not resolved here: PKCE support, `auth.revoke` details (token as a form field, the exact answer, whether it also removes the app), `chat:write.public`, that the token answer's `token_type` is `bot` and `scope` is comma separated, that a comma separated `scope` is accepted in the authorize URL, whether any workspace may install an unlisted app without review, Marketplace review time and fees, and the exact commercial distribution wording. Every behaviour here is tested only against `test/fake-providers.ts`; no real Slack request was made. `docs/live-slack-oauth-check.md` is the owner's list.
