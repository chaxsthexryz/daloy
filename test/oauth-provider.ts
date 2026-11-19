import { call, ProviderError, type OAuthProvider, type Provider } from "@daloy/db";
import type { FakeProviders } from "./fake-providers";

/**
 * A provider definition for the generic fake OAuth app (test/fake-providers.ts), as a later phase would write one. It
 * borrows a real provider column value, since connections and flows check the provider name; tests pick one that has no
 * definition of its own yet.
 */
export function fakeOAuthProvider(fake: FakeProviders, o: { app?: string; provider?: Provider; slug?: string; revoke?: boolean; pkce?: boolean; previousRefreshTokenWorks?: boolean } = {}): OAuthProvider & { provider: Provider } {
  const app = fake.oauth[o.app ?? "test"]!;
  const u = fake.oauthUrls(app.name);
  return {
    provider: o.provider ?? "trello",
    slug: o.slug ?? "trello",
    name: "Test app",
    client: () => ({ clientId: app.clientId, clientSecret: app.clientSecret }),
    authorizeUrl: () => u.authorize,
    tokenUrl: () => u.token,
    revokeUrl: o.revoke === false ? undefined : () => u.revoke,
    scopes: ["read", "write", "offline_access"],
    requiredScopes: ["read", "write"],
    pkce: o.pkce ?? true,
    refreshTokens: app.refresh,
    previousRefreshTokenWorks: o.previousRefreshTokenWorks,
    keepaliveDays: 30,
    identity: async (urls, accessToken) => {
      const res = await call(u.userinfo, { headers: { authorization: `Bearer ${accessToken}` } }, urls.timeoutMs ?? 10_000, false, "Test app");
      if (res.status !== 200) throw new ProviderError("Test app did not say who signed in.", res.status === 401 ? "auth" : "unavailable");
      return { externalId: String(res.body.sub), account: String(res.body.email) };
    },
    outcome: (error, description) => (/admin/.test(description) ? "admin_required" : error === "access_denied" ? "declined" : "failed"),
  };
}
