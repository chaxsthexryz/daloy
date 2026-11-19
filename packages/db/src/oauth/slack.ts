import { slackIdentity, ProviderError } from "../providers";
import { readTokenBlob } from "./blob";
import type { OAuthProvider } from "./core";

/** Bot scopes only, no user scopes. chat:write.public is left out on purpose: the owner invites the app to the channel (decision 0061). */
export const SLACK_SCOPES = ["chat:write", "channels:read"] as const;

/** Slack on the shared core (decisions 0058 and 0061): the OAuth v2 install, which gives a bot token. */
export const slack: OAuthProvider = {
  provider: "slack",
  slug: "slack",
  name: "Slack",
  client: (urls) => urls.slackClient,
  authorizeUrl: (urls) => `${urls.slack}/oauth/v2/authorize`,
  tokenUrl: (urls) => `${urls.slack}/api/oauth.v2.access`,
  // auth.revoke ends the bot token. It answers HTTP 200 with ok: false when it did not (unverified, plan section 15 item 10).
  revokeUrl: (urls) => `${urls.slack}/api/auth.revoke`,
  revokeAccepted: (body) => body.ok === true,
  scopes: SLACK_SCOPES,
  // Slack names the granted scopes in a comma separated list.
  requiredScopes: SLACK_SCOPES,
  scopeSeparator: ",",
  // Slack calls the token a "bot" token.
  tokenTypes: ["bot"],
  // PKCE is off: Slack documents no code_challenge for the OAuth v2 install (unverified, plan section 15 item 10). The
  // state is one-time, bound to the member and workspace, and the code is exchanged with the client secret.
  pkce: false,
  // Token rotation stays off in the Slack app, so the bot token does not expire and there is no refresh token.
  refreshTokens: false,
  keepaliveDays: 30,
  // The workspace (team) id is the stable account. Slack ids channels per workspace, so a reconnect to another one clears the channel.
  identity: async (urls, accessToken) => {
    const me = await slackIdentity(urls, accessToken);
    if (!me.teamId) throw new ProviderError("Slack did not say which workspace this is.", "invalid");
    return { externalId: me.teamId, account: me.team };
  },
  outcome: (error) => (error === "access_denied" ? "declined" : "failed"),
};

/**
 * The bot token to call Slack with. A pasted token is the credential itself; an OAuth connection keeps it in the
 * token blob (decision 0058). The token does not expire, so there is no refresh to run first.
 */
export const slackToken = (conn: { credential: string; authMethod: string }) => (conn.authMethod === "oauth" ? readTokenBlob(conn.credential).accessToken : conn.credential);
