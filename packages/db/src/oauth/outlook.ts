import { consentOutcome, outlookMailbox, ProviderError, type ProviderUrls } from "../providers";
import type { OAuthProvider } from "./core";

/** Delegated permissions for Outlook: send and read mail as the signed-in mailbox, keep access without a sign-in each time, read the address. */
export const OUTLOOK_SCOPES = "offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read";

function microsoftBase(urls: ProviderUrls) {
  if (!urls.microsoft || !urls.microsoftLogin) throw new ProviderError("Outlook is not set up on this installation. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.", "invalid");
  return `${urls.microsoftLogin}/${encodeURIComponent(urls.microsoft.tenant)}`;
}

/** Outlook on the shared core (decisions 0023 and 0058). */
export const outlook: OAuthProvider = {
  provider: "outlook",
  slug: "outlook",
  name: "Outlook",
  client: (urls) => urls.microsoft,
  authorizeUrl: (urls) => `${microsoftBase(urls)}/oauth2/v2.0/authorize`,
  tokenUrl: (urls) => `${microsoftBase(urls)}/oauth2/v2.0/token`,
  // No revokeUrl: Microsoft has no call that ends one refresh token for kymavo (unverified, plan section 15 item 11).
  // The page tells the owner to remove kymavo at their Microsoft account page.
  scopes: OUTLOOK_SCOPES.split(" "),
  requiredScopes: ["Mail.Send", "User.Read"],
  extraParams: { response_mode: "query", prompt: "select_account" },
  tokenParams: { scope: OUTLOOK_SCOPES },
  pkce: true,
  refreshTokens: true,
  // Microsoft refresh tokens lapse after a period without use (length unverified); 30 days is well inside it.
  keepaliveDays: 30,
  // Registered in each installation's Entra app before the shared callback existed. Kept so no owner has to change it.
  redirectPath: "/settings/connections/outlook/callback",
  identity: async (urls, accessToken) => {
    const me = await outlookMailbox(urls, accessToken);
    return { externalId: me.id, account: me.mailbox, destination: { mailbox: me.mailbox } };
  },
  outcome: consentOutcome,
};

/** The page an administrator opens to approve kymavo for the whole organization. */
export function outlookAdminConsentUrl(urls: ProviderUrls, redirectUri: string) {
  const q = new URLSearchParams({ client_id: urls.microsoft?.clientId ?? "", redirect_uri: redirectUri, scope: "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read" });
  return `${microsoftBase(urls)}/v2.0/adminconsent?${q}`;
}
