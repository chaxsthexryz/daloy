import { call, ProviderError, type GoogleOAuthConfig, type ProviderUrls } from "../providers";
import type { OAuthFlowProvider } from "../schema";
import type { OAuthProvider } from "./core";

/**
 * Google on the shared OAuth core (decision 0060). One OAuth client per installation and environment, one grant per
 * kymavo app (Sheets and Drive each connect on their own), so each grant carries only the scopes its feature needs.
 */

/** Who signed in: the stable account id (sub) and the address shown in Apps. Non-sensitive. */
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"] as const;

/**
 * The scopes each Google feature asks for, beside the identity scopes. Gmail (P5) and Calendar (P6) add their rows here.
 * drive.file is non-sensitive: kymavo reaches only files the owner picked in the Google Picker or that kymavo created.
 * Never add a scope listed in FORBIDDEN_SCOPES (oauth/core.ts); scopes.test.ts checks this table.
 */
export const GOOGLE_FEATURE_SCOPES = {
  sheets: ["https://www.googleapis.com/auth/drive.file"],
  drive: ["https://www.googleapis.com/auth/drive.file"],
  // Sensitive, not restricted (decision 0063): send only. Reading mail would need a restricted scope.
  gmail: ["https://www.googleapis.com/auth/gmail.send"],
  // kymavo creates its own calendar and works only on calendars it created (decision 0064). Class unverified: see there.
  calendar: ["https://www.googleapis.com/auth/calendar.app.created"],
} as const satisfies Record<string, readonly string[]>;
export type GoogleFeature = keyof typeof GOOGLE_FEATURE_SCOPES;

function googleConfig(urls: ProviderUrls): GoogleOAuthConfig {
  if (!urls.googleOAuth) throw new ProviderError("Google sign-in is not set up on this installation. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.", "invalid");
  return urls.googleOAuth;
}

/**
 * Google's answer on the way back. access_denied is the person saying no; admin_policy_enforced and org_internal are a
 * Workspace administrator or an internal-only app blocking it (error names unverified against a live consent).
 */
export function googleConsentOutcome(error: string): "declined" | "admin_required" | "failed" {
  if (error === "access_denied") return "declined";
  if (error === "admin_policy_enforced" || error === "org_internal") return "admin_required";
  return "failed";
}

/** The OpenID userinfo answer: sub is stable for the Google account, the email may change. emailVerified: Google confirmed the address. */
export async function googleIdentity(urls: ProviderUrls, accessToken: string) {
  const res = await call(googleConfig(urls).userinfo, { headers: { authorization: `Bearer ${accessToken}` } }, urls.timeoutMs ?? 10_000, false, "Google sign-in");
  if (res.status === 401) throw new ProviderError("Google did not accept the new sign-in.", "auth");
  if (res.status !== 200 || typeof res.body.sub !== "string" || !res.body.sub) throw new ProviderError("Google did not say which account signed in.", "unavailable");
  return { externalId: res.body.sub, account: typeof res.body.email === "string" && res.body.email ? res.body.email : res.body.sub, emailVerified: res.body.email_verified === true };
}

/** One Google app on the core. Exported for Gmail (P5) and Calendar (P6), which add a feature row and call this. */
export function googleProvider(feature: GoogleFeature, provider: OAuthFlowProvider, slug: string, name: string): OAuthProvider {
  return {
    provider,
    slug,
    name,
    client: (urls) => urls.googleOAuth && { clientId: urls.googleOAuth.clientId, clientSecret: urls.googleOAuth.clientSecret },
    authorizeUrl: (urls) => googleConfig(urls).authorize,
    tokenUrl: (urls) => googleConfig(urls).token,
    revokeUrl: (urls) => googleConfig(urls).revoke,
    scopes: [...GOOGLE_IDENTITY_SCOPES, ...GOOGLE_FEATURE_SCOPES[feature]],
    requiredScopes: GOOGLE_FEATURE_SCOPES[feature],
    // offline and consent: a refresh token on every connect and reconnect. No include_granted_scopes, so a Sheets grant
    // never carries another app's scopes.
    extraParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "false" },
    pkce: true,
    refreshTokens: true,
    // A Google refresh token lapses after six months unused; half of that.
    keepaliveDays: 90,
    identity: googleIdentity,
    outcome: googleConsentOutcome,
  };
}

export const googleSheets = googleProvider("sheets", "google_sheets", "google-sheets", "Google Sheets");
export const googleDrive = googleProvider("drive", "google_drive", "google-drive", "Google Drive");
export const googleCalendar = googleProvider("calendar", "google_calendar", "google-calendar", "Google Calendar");
