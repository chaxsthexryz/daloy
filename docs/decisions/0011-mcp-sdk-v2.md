# 0011: MCP server with SDK v2, stateless, behind a bearer token guard

## Context

PROJECT.md asks for the official MCP TypeScript SDK at its current stable release, with Streamable HTTP, and says to use v1.x if v2 is still in beta. Each published workflow with a form trigger becomes a tool, and `get_run_status` reports a run's state. Auth is a per-user bearer API token. The API is NestJS 12, which is ESM only: a CommonJS package that loads Nest internals breaks dependency injection under tsx (see HANDOFF notes and decision 0005).

## Options

SDK:

1. `@modelcontextprotocol/sdk` 1.32.2, the v1 line. It depends on express, hono, cors, express-rate-limit, jose, ajv and more.
2. `@modelcontextprotocol/server` 2.4.0, the v2 line, with `@modelcontextprotocol/node` for Node HTTP.

Serving:

1. Sessionful: keep one server and transport per MCP session in memory, keyed by `Mcp-Session-Id`.
2. Stateless: build a fresh `McpServer` for every HTTP request.

## Decision

SDK option 2. On 2026-11-13, `pnpm view @modelcontextprotocol/server versions` lists 2.0.0 to 2.4.0 after the betas, and its README calls v2 "the stable release line". It implements the 2026-07-28 spec and answers 2025-era clients through a stateless fallback, so older clients still connect. It is ESM, Apache-2.0, and depends only on zod and `@modelcontextprotocol/core`. `@modelcontextprotocol/node` (Apache-2.0) adds `toNodeHandler()`, which adapts the web-standard handler to an Express request and streams SSE responses. It pulls in `hono` and `@hono/node-server` (MIT), neither of which touches Nest. The "use v1 while v2 is in beta" rule in PROJECT.md no longer applies.

Serving option 2, through `createMcpHandler(factory)`. The factory runs once per request with the caller's `authInfo`, loads that user's published form workflows, and registers one tool per workflow plus `get_run_status`. Nothing is kept between requests, so:

- there is no session table to clean up and the API can run as several processes,
- a newly published or unpublished workflow shows up on the next request,
- a revoked token stops working on the next request.

Auth sits in front of the SDK. `McpTokenGuard` (`apps/api/src/mcp.ts`) parses `Authorization: Bearer dly_...` and runs one `UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id`. No row means 401 with `WWW-Authenticate: Bearer`. The guard puts the owner's id in `req.auth`, which `toNodeHandler` passes to the factory as `authInfo`. The SDK itself never sees the token check, so the check is the same for both protocol eras.

The tool input schema is `fieldsSchema()` from `apps/api/src/public.ts`, the same zod schema the hosted form uses. The SDK reads its JSON Schema for `tools/list` and validates `tools/call` arguments with it, so a tool call and a form submission accept the same input.

## Consequences

- One extra database query per MCP request (the tools list), plus the token UPDATE. Fine for one user's handful of workflows.
- Server-to-client features that need a session (subscriptions over a long-lived stream, server-initiated requests) are not used. The tools do not need them.
- The rate limit (60 requests a minute) is per IP, like the other routes, and counted in process memory.
- The v2 SDK is newer than v1 and has fewer examples in the wild. The integration tests drive the endpoint with the official v2 client, and one test sends a raw 2025-era `initialize` POST.
