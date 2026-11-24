import { describe, expect, it } from "vitest";
import { authorizeUrl, FORBIDDEN_SCOPES, gmail, GOOGLE_FEATURE_SCOPES, googleSheets, grantedEnough, OAUTH_PROVIDERS, outlook, redirectUri, slack } from "./index";

// R5 (decision 0058): every scope kymavo asks for is listed here. Adding one fails this test until the snapshot, the
// decision record and any provider review submission are updated together.
describe("scope manifest", () => {
  it("asks each provider for exactly these scopes", () => {
    expect(Object.fromEntries(OAUTH_PROVIDERS.map((d) => [d.slug, { scopes: d.scopes, required: d.requiredScopes, pkce: d.pkce }]))).toEqual({
      outlook: { scopes: ["offline_access", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/User.Read"], required: ["Mail.Send", "User.Read"], pkce: true },
      "google-sheets": { scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.file"], required: ["https://www.googleapis.com/auth/drive.file"], pkce: true },
      "google-drive": { scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.file"], required: ["https://www.googleapis.com/auth/drive.file"], pkce: true },
      // Decision 0063: send only, a sensitive scope. Never a Gmail read, modify, compose or full mail scope.
      gmail: { scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.send"], required: ["https://www.googleapis.com/auth/gmail.send"], pkce: true },
      // Decision 0064: only calendars kymavo creates. calendar.events and calendar.calendarlist.readonly are not asked for.
      "google-calendar": { scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.app.created"], required: ["https://www.googleapis.com/auth/calendar.app.created"], pkce: true },
      slack: { scopes: ["chat:write", "channels:read"], required: ["chat:write", "channels:read"], pkce: false },
      airtable: { scopes: ["data.records:write", "schema.bases:read"], required: ["data.records:write", "schema.bases:read"], pkce: true },
      notion: { scopes: [], required: [], pkce: false },
      trello: { scopes: ["offline_access", "read:member:trello", "read:board:trello", "write:board:trello"], required: ["read:member:trello", "read:board:trello", "write:board:trello"], pkce: true },
    });
    // Decision 0060: Google scopes per feature live in one table.
    expect(GOOGLE_FEATURE_SCOPES).toEqual({ sheets: ["https://www.googleapis.com/auth/drive.file"], drive: ["https://www.googleapis.com/auth/drive.file"], gmail: ["https://www.googleapis.com/auth/gmail.send"], calendar: ["https://www.googleapis.com/auth/calendar.app.created"] });
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

  it("builds Gmail's authorize URL with gmail.send only", () => {
    const urls = { googleOAuth: { clientId: "client-g", clientSecret: "unused", authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "", revoke: "", userinfo: "" } } as Parameters<typeof authorizeUrl>[1];
    expect(authorizeUrl(gmail, urls, { redirectUri: redirectUri("https://daloy.example", gmail), state: "STATE", codeChallenge: "CHALLENGE" })).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-g&response_type=code&redirect_uri=https%3A%2F%2Fdaloy.example%2Fsettings%2Fconnections%2Foauth%2Fcallback&scope=openid+email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.send&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&access_type=offline&prompt=consent&include_granted_scopes=false",
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
    expect(FORBIDDEN_SCOPES).toEqual(
      expect.arrayContaining([
        "https://mail.google.com/",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.metadata",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/drive.readonly",
      ]),
    );
    expect(Object.values(GOOGLE_FEATURE_SCOPES).flat().filter((s) => (FORBIDDEN_SCOPES as readonly string[]).includes(s))).toEqual([]);
    const asked = OAUTH_PROVIDERS.flatMap((d) => d.scopes);
    expect(asked.filter((s) => (FORBIDDEN_SCOPES as readonly string[]).includes(s))).toEqual([]);
  });

  it("does not ask for the broader Calendar scopes whose class is unverified (decision 0064)", () => {
    const asked = OAUTH_PROVIDERS.flatMap((d) => d.scopes);
    expect(asked).not.toContain("https://www.googleapis.com/auth/calendar.events");
    expect(asked).not.toContain("https://www.googleapis.com/auth/calendar.calendarlist.readonly");
    expect(asked).not.toContain("https://www.googleapis.com/auth/calendar");
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
