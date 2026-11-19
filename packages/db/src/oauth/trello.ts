import { trelloCall, type ProviderUrls } from "../providers";
import type { OAuthProvider } from "./core";
import { consentDeclined, noIdentity } from "./records";

/**
 * Trello OAuth 2.0 three-legged, a confidential client. Atlassian's authorization server issues the grant; the REST
 * API takes the access token as a bearer header (decision 0062). offline_access gives the refresh token. The granular
 * scope names are from Trello's scopes page as found by search (unverified, check each in the app's OAuth 2.0 tab).
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
  // No revokeUrl: no call that ends one Trello OAuth 2.0 grant was found (unverified). The page tells the owner to remove Daloy in Trello.
  scopes: TRELLO_SCOPES,
  requiredScopes: TRELLO_SCOPES.filter((s) => s !== "offline_access"),
  // audience is Atlassian's authorize parameter for its 3LO apps; its value for Trello is unverified.
  extraParams: { audience: "api.atlassian.com", prompt: "consent" },
  tokenFormat: "json",
  // Trello says every OAuth 2.0 authorization requires PKCE (RFC-89 as found by search).
  pkce: true,
  refreshTokens: true,
  // Access token one hour, refresh token 90 days and rotating (confirmed in the plan): half of 90.
  keepaliveDays: 45,
  identity: async (urls, accessToken) => {
    const me = await trelloCall(urls, { bearer: accessToken }, "GET", "members/me?fields=username");
    if (typeof me.id !== "string" || !me.id) throw noIdentity("Trello");
    return { externalId: me.id, account: `@${String(me.username ?? "trello")}` };
  },
  outcome: consentDeclined,
};
