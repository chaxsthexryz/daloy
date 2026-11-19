# Manual live Slack install check (Connect Slack)

The automated tests never contact Slack. They use `test/fake-providers.ts`, which plays the install page, `oauth.v2.access`, `auth.test`, `conversations.list`, `chat.postMessage` and `auth.revoke`. This page is the separate check against a real Slack workspace. Run it by hand with a workspace you control. See [decision 0061](decisions/0061-slack-oauth.md). The pasted-token check is in [live Sheets and Slack check](live-sheets-slack-check.md).

Status: not run yet. Every item marked "unverified" in the decision stays open until you do. Record the date, the Daloy commit and what you saw at the end of this file.

## Before you start

- A Slack workspace where you can install apps, with a public channel and a second workspace (a free one is fine) for the other-workspace steps.
- At api.slack.com/apps, create an app (From scratch) for the development environment. Under OAuth and Permissions add the redirect URL `http://localhost:3000/settings/connections/oauth/callback` (or your `PUBLIC_URL` with the same path). Under Bot Token Scopes add exactly `chat:write` and `channels:read`, and no user token scopes. Leave Token Rotation off. Do not enable distribution to the Marketplace.
- Daloy running with `docker compose up`, with `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `OAUTH_ENV=development` set for the API and the worker. You type the secret yourself; never paste it into a chat, a commit or a screenshot.

## Slack

1. Open Apps, then Slack. Expect "Connect Slack", a note listing `chat:write` and `channels:read`, and "Advanced: use your own Slack app token" under it.
2. Select Connect Slack. In Slack's consent page, read the permissions. Expect exactly two: send messages as the app, and view basic information about public channels. Unverified: also check that no user permissions are listed. Allow.
3. Expect to land on Apps with "Slack is connected." and the Slack workspace's name. Unverified: if Slack needs an administrator to approve the app first, note what the page shows and whether Slack sends the browser back at all.
4. Select Pick a channel, choose a public channel the app was not invited to, and save. Select Send a test message. Expect "not in that channel" with the /invite hint (this is why `chat:write.public` is not requested). Type `/invite` and the app's name in the channel, select Send a test message again. Expect the message in the channel.
5. Select Reconnect Slack and allow again in the same workspace. Expect the same channel still chosen. In Slack's app settings (or the token's page), note whether the bot token changed.
6. Install into the second workspace: select Reconnect Slack, and in Slack's consent page switch workspace before allowing. Expect the new workspace's name and no channel chosen.
7. Queue a note: set up an office request with the Slack note ticked, stop the worker, send a request, reconnect to the first workspace and pick the channel, start the worker. Expect the note held for review with both channels named, and nothing posted in either. Choose Post again and expect one note.
8. Decline: select Connect Slack, then Cancel in Slack's consent page. Expect "The permission request was declined" and nothing connected.
9. Scopes: in the app's settings remove `channels:read` and reinstall. Select Connect Slack. Expect either Slack to ask for the missing scope or Daloy to show "Some of the permissions Daloy asked for were not allowed" and save nothing. Add the scope back.
10. Disconnect from Daloy. Expect "Slack is not connected" and the Connect Slack button. Unverified, `auth.revoke`: then open the app's page at Slack (Manage apps, or call `auth.test` with the old token) and note whether the token is dead and whether the app is still installed. If Daloy says Slack did not confirm the removal, note what Slack returned in its own logs, not in Daloy's.
11. Unverified, PKCE: in a scratch copy of the definition, set `pkce: true` and connect once. If Slack accepts the challenge and the verifier, note it. If Slack refuses, leave it off. Do not commit this.
12. Unverified, shared tokens (R14): connect the same Slack workspace in two Daloy workspaces (two accounts), then disconnect one. Expect the other still to send. If it does not, Slack gave both the same token: the decision's warning applies.
13. Paste path: in Advanced, paste the app's Bot User OAuth Token and select Save token. Expect it to replace the install, keep the channel, and post a test message.

Before charging customers for the hosted service with Slack, read Slack's current commercial distribution terms and Marketplace guidelines, and write down what they say here.

## Results

None recorded yet.
