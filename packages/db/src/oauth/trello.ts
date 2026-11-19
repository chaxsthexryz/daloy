import { trelloCall, type ProviderUrls } from "../providers";
import type { OAuthProvider } from "./core";
import { consentDeclined, noIdentity } from "./records";

/**
 * Trello OAuth 2.0 three-legged, a confidential client. Atlassian's authorization server issues the grant; the REST
 * API takes the access token as a bearer header (decision 0062). offline_access gives the refresh token. The scopes match
 * Trello's OAuth 2.0 client configuration and confidential client usage references.
 */
export const TRELLO_SCOPES = ["offline_access", "read:member:trello", "read:board:trello", "write:board:trello"];

const login = (urls: ProviderUrls) => urls.trelloLogin ?? "https://auth.atlassian.com";

export const trello: OAuthProvider = {
  provider: "trello",
  slug: "trello",
  name: "Trello",
  client: (urls) => urls.trelloClient,
  authorizeUrl: (urls) => `${login(urls)}/authorize`,
  tokenUrl: (urls) => `${login(urls)}/oauth/token`,
  // The confidential client reference documents no revoke endpoint. Remove the grant in Trello after disconnecting.
  scopes: TRELLO_SCOPES,
  requiredScopes: TRELLO_SCOPES.filter((s) => s !== "offline_access"),
  // Trello documents prompt=consent; its example does not use the site-based audience parameter.
  extraParams: { prompt: "consent" },
  tokenFormat: "json",
  // Trello requires S256 PKCE for confidential clients.
  pkce: true,
  refreshTokens: true,
  // Default access lifetime is one hour, refresh lifetime 90 days: refresh idle grants halfway through.
  keepaliveDays: 45,
  identity: async (urls, accessToken) => {
    const me = await trelloCall(urls, { bearer: accessToken }, "GET", "members/me?fields=username");
    if (typeof me.id !== "string" || !me.id) throw noIdentity("Trello");
    return { externalId: me.id, account: `@${String(me.username ?? "trello")}` };
  },
  outcome: consentDeclined,
};
