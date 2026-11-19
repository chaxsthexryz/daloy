import { describe, expect, it } from "vitest";
import { authorizeUrl, FORBIDDEN_SCOPES, GOOGLE_FEATURE_SCOPES, googleSheets, grantedEnough, OAUTH_PROVIDERS, outlook, redirectUri } from "./index";

// R5 (decision 0058): every scope Daloy asks for is listed here. Adding one fails this test until the snapshot, the
// decision record and any provider review submission are updated together.
describe("scope manifest", () => {
  it("asks each provider for exactly these scopes", () => {
    expect(Object.fromEntries(OAUTH_PROVIDERS.map((d) => [d.slug, { scopes: d.scopes, required: d.requiredScopes, pkce: d.pkce }]))).toEqual({
      outlook: { scopes: ["offline_access", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/User.Read"], required: ["Mail.Send", "User.Read"], pkce: true },
      "google-sheets": { scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.file"], required: ["https://www.googleapis.com/auth/drive.file"], pkce: true },
      "google-drive": { scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.file"], required: ["https://www.googleapis.com/auth/drive.file"], pkce: true },
    });
    // Decision 0060: Google scopes per feature live in one table. Gmail (P5) and Calendar (P6) add rows here.
    expect(GOOGLE_FEATURE_SCOPES).toEqual({ sheets: ["https://www.googleapis.com/auth/drive.file"], drive: ["https://www.googleapis.com/auth/drive.file"] });
  });

  it("builds the same authorize URL for Outlook", () => {
    const urls = { microsoftLogin: "https://login.microsoftonline.com", microsoft: { clientId: "client-1", clientSecret: "unused", tenant: "organizations" } } as Parameters<typeof authorizeUrl>[1];
    expect(authorizeUrl(outlook, urls, { redirectUri: redirectUri("https://daloy.example", outlook), state: "STATE", codeChallenge: "CHALLENGE" })).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=client-1&response_type=code&redirect_uri=https%3A%2F%2Fdaloy.example%2Fsettings%2Fconnections%2Foutlook%2Fcallback&scope=offline_access+https%3A%2F%2Fgraph.microsoft.com%2FMail.Send+https%3A%2F%2Fgraph.microsoft.com%2FUser.Read&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&response_mode=query&prompt=select_account",
    );
  });

  it("builds Google's authorize URL with offline access, consent, PKCE and no other app's scopes", () => {
    const urls = { googleOAuth: { clientId: "client-g", clientSecret: "unused", authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "", revoke: "", userinfo: "" } } as Parameters<typeof authorizeUrl>[1];
    expect(authorizeUrl(googleSheets, urls, { redirectUri: redirectUri("https://daloy.example", googleSheets), state: "STATE", codeChallenge: "CHALLENGE" })).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-g&response_type=code&redirect_uri=https%3A%2F%2Fdaloy.example%2Fsettings%2Fconnections%2Foauth%2Fcallback&scope=openid+email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&access_type=offline&prompt=consent&include_granted_scopes=false",
    );
  });

  it("never asks for a restricted Google scope", () => {
    expect(FORBIDDEN_SCOPES).toEqual(
      expect.arrayContaining([
        "https://mail.google.com/",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/drive.readonly",
      ]),
    );
    expect(Object.values(GOOGLE_FEATURE_SCOPES).flat().filter((s) => (FORBIDDEN_SCOPES as readonly string[]).includes(s))).toEqual([]);
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
