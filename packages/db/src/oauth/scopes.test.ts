import { describe, expect, it } from "vitest";
import { authorizeUrl, FORBIDDEN_SCOPES, grantedEnough, OAUTH_PROVIDERS, outlook, redirectUri, slack } from "./index";

// R5 (decision 0058): every scope Daloy asks for is listed here. Adding one fails this test until the snapshot, the
// decision record and any provider review submission are updated together.
describe("scope manifest", () => {
  it("asks each provider for exactly these scopes", () => {
    expect(Object.fromEntries(OAUTH_PROVIDERS.map((d) => [d.slug, { scopes: d.scopes, required: d.requiredScopes, pkce: d.pkce }]))).toEqual({
      outlook: { scopes: ["offline_access", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/User.Read"], required: ["Mail.Send", "User.Read"], pkce: true },
      slack: { scopes: ["chat:write", "channels:read"], required: ["chat:write", "channels:read"], pkce: false },
    });
  });

  it("builds the same authorize URL for Outlook", () => {
    const urls = { microsoftLogin: "https://login.microsoftonline.com", microsoft: { clientId: "client-1", clientSecret: "unused", tenant: "organizations" } } as Parameters<typeof authorizeUrl>[1];
    expect(authorizeUrl(outlook, urls, { redirectUri: redirectUri("https://daloy.example", outlook), state: "STATE", codeChallenge: "CHALLENGE" })).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=client-1&response_type=code&redirect_uri=https%3A%2F%2Fdaloy.example%2Fsettings%2Fconnections%2Foutlook%2Fcallback&scope=offline_access+https%3A%2F%2Fgraph.microsoft.com%2FMail.Send+https%3A%2F%2Fgraph.microsoft.com%2FUser.Read&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&response_mode=query&prompt=select_account",
    );
  });

  // Decision 0061: bot scopes only. chat:write.public is not asked for, and no user scope ever is.
  it("builds Slack's authorize URL with bot scopes only", () => {
    const urls = { slack: "https://slack.com", slackClient: { clientId: "123.456", clientSecret: "unused" } } as Parameters<typeof authorizeUrl>[1];
    const url = authorizeUrl(slack, urls, { redirectUri: redirectUri("https://daloy.example", slack), state: "STATE" });
    expect(url).toBe("https://slack.com/oauth/v2/authorize?client_id=123.456&response_type=code&redirect_uri=https%3A%2F%2Fdaloy.example%2Fsettings%2Fconnections%2Foauth%2Fcallback&scope=chat%3Awrite%2Cchannels%3Aread&state=STATE");
    expect(new URL(url).searchParams.has("user_scope")).toBe(false);
    expect(slack.scopes).not.toContain("chat:write.public");
    expect(slack.extraParams).toBeUndefined();
    // A code challenge is not sent while Slack's PKCE support is unverified.
    expect(authorizeUrl(slack, urls, { redirectUri: "https://x.example/cb", state: "S", codeChallenge: "C" })).not.toContain("code_challenge");
  });

  it("never asks for a restricted Google scope", () => {
    expect(FORBIDDEN_SCOPES).toEqual(expect.arrayContaining(["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/drive"]));
    const asked = OAUTH_PROVIDERS.flatMap((d) => d.scopes);
    expect(asked.filter((s) => (FORBIDDEN_SCOPES as readonly string[]).includes(s))).toEqual([]);
  });

  it("treats a grant as enough only when every required scope came back", () => {
    expect(grantedEnough(outlook, "Mail.Send User.Read")).toBe(true);
    expect(grantedEnough(outlook, "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid")).toBe(true);
    expect(grantedEnough(outlook, "https://graph.microsoft.com/User.Read")).toBe(false);
    expect(grantedEnough(outlook, "")).toBe(false);
    expect(grantedEnough(outlook, undefined)).toBe(true);
    expect(grantedEnough(slack, "chat:write,channels:read")).toBe(true);
    expect(grantedEnough(slack, "channels:read,chat:write,im:write")).toBe(true);
    expect(grantedEnough(slack, "chat:write")).toBe(false);
    expect(grantedEnough(slack, "channels:read")).toBe(false);
  });
});
