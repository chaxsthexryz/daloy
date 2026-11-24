# 0133. Web page / RSS monitor and team chat triggers (phase G4)

Status: Accepted (24 November 2026)

## Context

Users want automations that react when a public web page or RSS/Atom feed updates (for example, a supplier price sheet or a news feed) and when a team message or slash command arrives in Slack, Microsoft Teams, or Discord.

Two constraints shaped the design:
1. Zero database migrations: `trigger_polls` (migration `0056`), `triggers.webhook_path`, `run_keys`, and `usage_claims` (`http`) already exist and cover polling cursors, per-workflow webhook paths, run idempotency, and daily request caps.
2. No OAuth scope expansion: `SLACK_SCOPES` is locked to `["chat:write", "channels:read"]` by `packages/db/src/oauth/scopes.test.ts`, and Teams and Discord outbound connections use incoming webhooks rather than bot tokens.

## Decision

### 1. Public web page and RSS/Atom feed monitor (`page_changed`)

- **Config**: strict Zod schema (`pageChangedConfigSchema`) with `mode` (`"page"` or `"feed"`, default `"page"`), `url` (`http:` or `https:` up to 2,000 chars), optional `selector` (allowed only in `page` mode), and `maxChars` (100 to `READ_PAGE_MAX_CHARS`, default 4,000).
- **Reuse `read_page` guards**: `apps/worker/src/monitor-triggers.ts` reuses `checkUrl` and `defaultGuard` (`ssrf.ts`), `checkPageRobots` (`read-page.ts`), `httpRequest` with `PAGE_MAX_BYTES` (2 MB) and `If-None-Match` / `If-Modified-Since` conditional headers, `extractPage`, and `claimUsage(db, ws, "http")` before each fetch. RSS 2.0 and Atom XML feeds are parsed with `cheerio` in XML mode (`parseFeed`), stripping HTML from descriptions/summaries and capping items at 50 per response (20 runs max per poll).
- **Cursor and idempotency**: reuses `trigger_polls` without a schema migration. To isolate Google triggers and web monitors sharing `trigger_polls`, both `pollGoogleTriggers` (`packages/db/src/google-triggers.ts`) and `pollMonitorTriggers` (`packages/db/src/monitor-triggers.ts`) filter their claim queries by `triggers.type`.
  - First poll baselines without starting runs (`page` stores `{ mode: "page", hash, value, title, etag, lastModified }`; `feed` stores `{ mode: "feed", seenIds, etag, lastModified }` up to 200 ids).
  - HTTP `304 Not Modified` updates conditional headers and starts zero runs.
  - Changes start keyed runs through `createKeyedRun`: `page:<sourceHash>:<prevHash16>:<newHash16>` for pages (allowing a value that flips back to fire again with a new transition key while deduplicating retries/crashes) and `feed:<sourceHash>:<itemHash24>` for feeds.
  - Retryable errors (429, 5xx, network timeouts) back off exponentially via `pollDelay`; non-retryable errors (SSRF refusal, `robots.txt` disallow, wrong content type) and `QuotaError` record a plain `problem` message and re-check on the regular interval.
- **Worker and API**: `startWorker` runs a `monitorTriggers` timer loop (default 15 s tick; 5-minute base poll interval or workspace plan `minScheduleMinutes`), and `GET /triggers/monitor` (`apps/api/src/monitor.ts`, `SessionGuard`, `Allow(OPERATE)`, `RateLimit(30)`) returns watcher status and daily `http` quota usage for the editor.

### 2. Team chat triggers (`slack_message`, `teams_message`, `discord_message`)

- **Verified per-workflow webhooks**: all three triggers use `triggers.webhook_path` (32 random bytes generated at publish, rotatable via `POST /workflows/:id/webhook-url`) under dedicated routes:
  - `POST /hooks/slack/:path`: verifies `X-Slack-Signature` (`v0=` HMAC-SHA256 over `v0:<ts>:<rawBody>`) and `X-Slack-Request-Timestamp` (5-minute replay window) in constant time against the workspace secret named in `signingSecret`. Answers Slack `url_verification` challenges only after verifying the signature, filters by optional `channelId`, `textContains`, and `ignoreBots` (default `true`), and keys runs as `slack:<event_id>`.
  - `POST /hooks/teams/:path`: verifies either Teams Outgoing Webhook `Authorization: HMAC <base64>` (raw body HMAC-SHA256) or Teams Workflows `X-Daloy-Signature` + `X-Daloy-Timestamp` (5-minute replay window) against `signingSecret`. Strips `<at>...</at>` mention markup into `cleanText`, filters by optional `channelId` and `textContains`, and keys runs as `teams:<messageId>`.
  - `POST /hooks/discord/:path`: verifies either Discord Interactions Ed25519 (`X-Signature-Ed25519` + `X-Signature-Timestamp` over `timestamp + rawBody` within 5 minutes against the 64-hex-character `publicKey`, answering `type: 1` PING with `{ type: 1 }` and slash commands with ephemeral `{ type: 4 }`) or HMAC-signed relay webhooks (`X-Daloy-Signature` + `X-Daloy-Timestamp` against `signingSecret`). Ignores bot relay messages, filters by optional `channelId`, `commandName`, and `textContains`, and keys runs as `discord:<id>`.
- **Publish checks and boundaries**: `checkSigningSecret` in `apps/api/src/workflows.ts` refuses publishing any chat trigger whose named `signingSecret` does not exist in the workspace. None of the four G4 triggers are added to `priceTrusted` or Shopify trusted trigger lists, preserving L7 payment and store write boundaries. Leaving `provider` unset on the chat triggers in `TRIGGER_CATALOG` (while setting `mark` for logos) keeps the editor from forcing an outbound posting connection in Apps when a user only wants inbound triggers.

## Consequences

- Zero SQL migrations and zero new OAuth scopes.
- Public page monitoring inherits every SSRF, `robots.txt`, response size, and daily `http` quota protection from `read_page`.
- Teams and Discord message listening do not require long-lived WebSocket gateway bots inside the worker; Slack Events API, Teams Outgoing Webhooks/Workflows, and Discord Interactions/relays work cleanly over verified HTTP webhooks.
