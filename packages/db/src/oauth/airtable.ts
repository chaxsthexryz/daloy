import { airtableCall, type ProviderUrls } from "../providers";
import type { OAuthProvider } from "./core";
import { consentDeclined, noIdentity } from "./records";

/**
 * Add records, and list bases and tables so the owner picks the table instead of typing ids. No record read: the
 * connect check reads the schema (decision 0062). The user's email would need user.email:read, which is not asked for.
 */
export const AIRTABLE_SCOPES = ["data.records:write", "schema.bases:read"];

const login = (urls: ProviderUrls) => urls.airtableLogin ?? "https://airtable.com";

/** Airtable's OAuth reference requires S256 PKCE and HTTP Basic client credentials. */
export const airtable: OAuthProvider = {
  provider: "airtable",
  slug: "airtable",
  name: "Airtable",
  client: (urls) => urls.airtableClient,
  authorizeUrl: (urls) => `${login(urls)}/oauth2/v1/authorize`,
  tokenUrl: (urls) => `${login(urls)}/oauth2/v1/token`,
  // Airtable documents manual revocation, with no dedicated OAuth refresh-token revoke endpoint.
  scopes: AIRTABLE_SCOPES,
  requiredScopes: AIRTABLE_SCOPES,
  tokenAuth: "basic",
  pkce: true,
  refreshTokens: true,
  // Airtable invalidates idle refresh tokens after 60 days and rotates them on use: refresh halfway through.
  keepaliveDays: 30,
  identity: async (urls, accessToken) => {
    const me = await airtableCall(urls, accessToken, "GET", "meta/whoami");
    if (typeof me.id !== "string" || !me.id) throw noIdentity("Airtable");
    return { externalId: me.id, account: `Airtable account ${me.id}` };
  },
  outcome: consentDeclined,
};
