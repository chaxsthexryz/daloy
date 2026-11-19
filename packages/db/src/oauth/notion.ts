import { NOTION_VERSION, notionCall, type ProviderUrls } from "../providers";
import type { OAuthProvider } from "./core";
import { consentDeclined, noIdentity } from "./records";

const api = (urls: ProviderUrls) => `${urls.notion}/v1/oauth`;

/**
 * Notion public integration on the shared core (decision 0062). Notion has no scopes: what Daloy may reach is the
 * pages and databases the owner ticks on Notion's consent screen, and the capabilities set on the integration (read
 * content, insert content). Token and revoke calls use HTTP Basic client credentials and a JSON body.
 */
export const notion: OAuthProvider = {
  provider: "notion",
  slug: "notion",
  name: "Notion",
  client: (urls) => urls.notionClient,
  authorizeUrl: (urls) => `${api(urls)}/authorize`,
  tokenUrl: (urls) => `${api(urls)}/token`,
  revokeUrl: (urls) => `${api(urls)}/revoke`,
  revokeToken: "access",
  scopes: [],
  requiredScopes: [],
  // The owner who connects, not a workspace-wide install.
  extraParams: { owner: "user" },
  tokenAuth: "basic",
  tokenFormat: "json",
  tokenHeaders: { "notion-version": NOTION_VERSION },
  // The public integration authorization reference documents a code exchange without PKCE.
  pkce: false,
  // The token reference documents rotating refresh tokens without an expires_in field. Keep legacy
  // nonexpiring grants usable too; a refresh token is retained whenever the provider returns one.
  refreshTokens: false,
  keepaliveDays: 30,
  identity: async (urls, accessToken) => {
    const me = await notionCall(urls, accessToken, "GET", "users/me");
    if (typeof me.id !== "string" || !me.id) throw noIdentity("Notion");
    const bot = (me.bot ?? {}) as { workspace_name?: unknown };
    return { externalId: me.id, account: String(bot.workspace_name || me.name || "Notion") };
  },
  outcome: consentDeclined,
};
