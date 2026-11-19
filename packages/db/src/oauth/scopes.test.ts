import { describe, expect, it } from "vitest";
import { authorizeUrl, FORBIDDEN_SCOPES, grantedEnough, OAUTH_PROVIDERS, outlook, redirectUri } from "./index";

// R5 (decision 0058): every scope Daloy asks for is listed here. Adding one fails this test until the snapshot, the
// decision record and any provider review submission are updated together.
describe("scope manifest", () => {
  it("asks each provider for exactly these scopes", () => {
    expect(Object.fromEntries(OAUTH_PROVIDERS.map((d) => [d.slug, { scopes: d.scopes, required: d.requiredScopes, pkce: d.pkce }]))).toEqual({
      outlook: { scopes: ["offline_access", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/User.Read"], required: ["Mail.Send", "User.Read"], pkce: true },
      airtable: { scopes: ["data.records:write", "schema.bases:read"], required: ["data.records:write", "schema.bases:read"], pkce: true },
      notion: { scopes: [], required: [], pkce: false },
      trello: { scopes: ["offline_access", "read:member:trello", "read:board:trello", "write:board:trello"], required: ["read:member:trello", "read:board:trello", "write:board:trello"], pkce: true },
    });
  });

  it("builds the same authorize URL for Outlook", () => {
    const urls = { microsoftLogin: "https://login.microsoftonline.com", microsoft: { clientId: "client-1", clientSecret: "unused", tenant: "organizations" } } as Parameters<typeof authorizeUrl>[1];
    expect(authorizeUrl(outlook, urls, { redirectUri: redirectUri("https://daloy.example", outlook), state: "STATE", codeChallenge: "CHALLENGE" })).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=client-1&response_type=code&redirect_uri=https%3A%2F%2Fdaloy.example%2Fsettings%2Fconnections%2Foutlook%2Fcallback&scope=offline_access+https%3A%2F%2Fgraph.microsoft.com%2FMail.Send+https%3A%2F%2Fgraph.microsoft.com%2FUser.Read&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&response_mode=query&prompt=select_account",
    );
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
  });
});
