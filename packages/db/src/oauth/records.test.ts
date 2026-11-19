import { describe, expect, it } from "vitest";
import { airtable, authorizeUrl, FORBIDDEN_SCOPES, grantedEnough, notion, redirectUri, trello } from "./index";

// Decision 0062: the exact consent URLs and scope sets of Airtable, Notion and Trello. Like scopes.test.ts, a change
// that adds a scope or a parameter fails here until this test, the decision record and the provider's app settings agree.
const urls = {
  airtableLogin: "https://airtable.example",
  trelloLogin: "https://auth.example",
  notion: "https://api.notion.example",
  airtableClient: { clientId: "at-client", clientSecret: "unused" },
  notionClient: { clientId: "nt-client", clientSecret: "unused" },
  trelloClient: { clientId: "tr-client", clientSecret: "unused" },
} as unknown as Parameters<typeof authorizeUrl>[1];
const at = (def: Parameters<typeof authorizeUrl>[0], codeChallenge?: string) => authorizeUrl(def, urls, { redirectUri: redirectUri("https://daloy.example", def), state: "STATE", codeChallenge });

describe("record apps: consent URLs", () => {
  it("Airtable asks for exactly two scopes with PKCE S256", () => {
    expect(at(airtable, "CHALLENGE")).toBe(
      "https://airtable.example/oauth2/v1/authorize?client_id=at-client&response_type=code&redirect_uri=https%3A%2F%2Fdaloy.example%2Fsettings%2Fconnections%2Foauth%2Fcallback&scope=data.records%3Awrite+schema.bases%3Aread&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256",
    );
  });

  it("Notion sends no scope and no PKCE, and asks for the owner's own authorization", () => {
    expect(at(notion, "CHALLENGE")).toBe("https://api.notion.example/v1/oauth/authorize?client_id=nt-client&response_type=code&redirect_uri=https%3A%2F%2Fdaloy.example%2Fsettings%2Fconnections%2Foauth%2Fcallback&state=STATE&owner=user");
  });

  it("Trello asks for offline access and the granular scopes with PKCE S256", () => {
    expect(at(trello, "CHALLENGE")).toBe(
      "https://auth.example/authorize?client_id=tr-client&response_type=code&redirect_uri=https%3A%2F%2Fdaloy.example%2Fsettings%2Fconnections%2Foauth%2Fcallback&scope=offline_access+read%3Amember%3Atrello+read%3Aboard%3Atrello+write%3Aboard%3Atrello&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&audience=api.atlassian.com&prompt=consent",
    );
  });

  it("asks for no restricted scope and for nothing beyond writing records and reading the schema, boards and member", () => {
    const all = [...airtable.scopes, ...notion.scopes, ...trello.scopes];
    expect(all.filter((s) => (FORBIDDEN_SCOPES as readonly string[]).includes(s))).toEqual([]);
    expect(all.filter((s) => /read.*records|data\.records:read|user\.email|webhook|delete|admin/i.test(s))).toEqual([]);
  });

  it("refuses a narrower Airtable or Trello grant and has nothing to refuse for Notion", () => {
    expect(grantedEnough(airtable, "data.records:write schema.bases:read")).toBe(true);
    expect(grantedEnough(airtable, "data.records:write")).toBe(false);
    expect(grantedEnough(trello, "offline_access read:member:trello read:board:trello write:board:trello")).toBe(true);
    expect(grantedEnough(trello, "offline_access read:board:trello")).toBe(false);
    expect(grantedEnough(notion, "")).toBe(true);
  });

  it("maps a refusal to declined and anything else to failed, with no administrator branch", () => {
    for (const def of [airtable, notion, trello]) {
      expect(def.outcome("access_denied", "")).toBe("declined");
      expect(def.outcome("server_error", "admin")).toBe("failed");
    }
  });
});
