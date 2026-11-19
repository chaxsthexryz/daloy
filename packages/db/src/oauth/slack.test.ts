import { describe, expect, it } from "vitest";
import { providerUrls } from "../providers";
import { slack, slackToken } from "./index";

// Decision 0061: what only the Slack definition decides.
describe("Slack on the OAuth core", () => {
  it("is offered only when both client variables are set", () => {
    expect(slack.client(providerUrls({}))).toBeUndefined();
    expect(slack.client(providerUrls({ SLACK_CLIENT_ID: "123.456" }))).toBeUndefined();
    expect(slack.client(providerUrls({ SLACK_CLIENT_ID: "123.456", SLACK_CLIENT_SECRET: "secret" }))).toEqual({ clientId: "123.456", clientSecret: "secret" });
  });

  it("builds its addresses from the Slack base, so a fake can stand in", () => {
    const urls = providerUrls({ SLACK_API_URL: "http://127.0.0.1:9/" });
    expect([slack.authorizeUrl(urls), slack.tokenUrl(urls), slack.revokeUrl!(urls)]).toEqual(["http://127.0.0.1:9/oauth/v2/authorize", "http://127.0.0.1:9/api/oauth.v2.access", "http://127.0.0.1:9/api/auth.revoke"]);
  });

  it("maps consent errors to closed outcomes and counts a revoke only when Slack says ok", () => {
    expect(slack.outcome("access_denied", "")).toBe("declined");
    expect(slack.outcome("invalid_scope", "anything")).toBe("failed");
    expect(slack.revokeAccepted!({ ok: true, revoked: true })).toBe(true);
    expect(slack.revokeAccepted!({ ok: false, error: "invalid_auth" })).toBe(false);
    expect(slack.revokeAccepted!({})).toBe(false);
  });

  it("does not expire, rotate or use a code challenge", () => {
    expect([slack.refreshTokens, slack.pkce, slack.tokenTypes, slack.extraParams, slack.tokenParams]).toEqual([false, false, ["bot"], undefined, undefined]);
  });

  it("reads the bot token from a pasted credential and from an OAuth blob", () => {
    expect(slackToken({ credential: "xoxb-pasted", authMethod: "token" })).toBe("xoxb-pasted");
    const blob = JSON.stringify({ v: 1, accessToken: "xoxb-oauth", accessExpiresAt: null, scope: "chat:write,channels:read" });
    expect(slackToken({ credential: blob, authMethod: "oauth" })).toBe("xoxb-oauth");
  });
});
