# 0062: OAuth for Airtable, Notion and Trello records

## Context

The record delivery integrations in decision 0046 require pasted credentials and destination IDs. The shared OAuth core in decision 0058 supports provider sign-in, encrypted credentials and serialized refresh. The OAuth path needs destination selection without trusting an ID submitted by the browser.

## Decision

- Use the shared OAuth core for the three providers and keep the existing pasted credential forms. The installation configures its own client credentials and callback.
- Airtable requests `data.records:write` and `schema.bases:read` with PKCE. The manager selects a base and table. The OAuth target accepts a table ID and is checked against the current base and table lists, addressing M16 for the OAuth path. This does not change the pasted credential path.
- Notion uses a public integration with read and insert capabilities. The person authorizing selects content in Notion; Daloy lists accessible databases, checks the choice again, and reads the title property needed to create a page. The existing API version remains pinned for database properties.
- Trello uses a confidential OAuth 2 client, PKCE S256, `offline_access`, `read:member:trello`, `read:board:trello` and `write:board:trello`. The manager selects a board and list. The server checks both against fresh lists. The member scope also permits access to email and memberships, even though Daloy requests the username for display.
- Picker routes require a manager session, validate IDs, use the current workspace credential limit requests and reject a save if the credential changed while the picker ran. Child list reads check the parent against the current list. A successful selection is not a guarantee that the provider will still permit a later delivery. Delivery target pinning and ambiguous-send review remain in force.
- Airtable and Trello use rotating refresh tokens. The shared core serializes refresh and stores a replacement token. The 30-day and 45-day keepalive settings are operational choices, not a guarantee of continued authorization. Notion's code accepts an authorization without a refresh token and retains one if supplied.
- Disconnect deletes the local credential. Provider-side revocation is best effort where implemented; the owner may need to revoke access at the provider. A local disconnect alone does not prove the remote grant was revoked.

## Provider evidence and open questions

The following documentation was read on 19 November 2026. It describes the providers, not a successful Daloy live test.

- [Airtable OAuth reference](https://airtable.com/developers/web/api/oauth-reference) describes the authorization and token flow. [Airtable support](https://support.airtable.com/articles/6811769763-third-party-integrations-via-oauth-overview) says refresh tokens are invalidated after 60 days of inactivity, describes reuse and its duplicate-refresh grace period, and says there is no dedicated API to revoke refresh tokens. Exact duplicate-refresh behavior with Daloy remains unverified.
- [Notion authorization](https://developers.notion.com/guides/authorization/overview) describes a token pair and says refresh returns a new pair. Notion documents [POST /v1/oauth/revoke](https://developers.notion.com/reference/revoke-token) for an access token; Daloy configures that endpoint for best-effort disconnect. Actual revocation and its effect on the associated refresh token remain unverified in a live check. Whether all existing public integration grants expire or rotate, old refresh token reuse, and PKCE support remain unverified.
- [Trello confidential OAuth](https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-confidential-client-usage/) specifies S256, `prompt=consent`, `offline_access`, bearer authentication and single-use refresh tokens. It gives default lifetimes of one hour for access and 90 days for refresh. Its prose and code examples give inconsistent token endpoint paths; the implementation uses the endpoint in the page's endpoint summary and examples. Daloy does not send an `audience` parameter. OAuth 2 grant revocation remains unverified. The [scope table](https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-client-configuration/) describes the permissions, and [card creation](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) identifies the write scope.

Registration requirements: [Airtable](https://airtable.com/developers/web/guides/oauth-integrations) requires privacy policy and terms URLs before other users can authorize. [Trello](https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-client-configuration/) configures the client in the app administration page. [Notion](https://developers.notion.com/guides/connections-and-tokens/public-integrations/overview) describes public integrations and optional Marketplace listing. Provider registration fees, account eligibility and any review required for this deployment remain unverified and must be checked by the operator.

## Verification and consequences

`packages/db/src/oauth/records.test.ts` checks the configured consent URLs and scopes. Fake-provider coverage cannot verify provider registration, consent, refresh, discovery, writes or revocation. These remain unverified until an owner runs [the live check](../live-records-oauth-check.md). A lost rotating token after a crash may require reconnect. Notion search visibility and provider permissions can change; an empty or stale list does not prove a resource does not exist.
