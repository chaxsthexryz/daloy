# Threat model

Kept current with each phase. A mitigation marked "planned" does not exist in code yet.

## Assets

- Stored secrets (API keys and SMTP credentials that workflows use)
- Console sessions and API tokens
- Run data: trigger payloads and step outputs, which can hold customer personal data
- The ability to send email and make HTTP requests from the server

## Entry points

- Console API (session cookie)
- Webhook URLs and hosted forms (public)
- Approval links (public, signed)
- MCP endpoint (bearer token)
- Outbound: HTTP request step, email step, LLM calls

## Threats and mitigations

| Threat | Mitigation | Status |
| --- | --- | --- |
| SSRF through the HTTP step | Allow only http and https on ports 80 and 443. Resolve DNS and block private, loopback, link-local and metadata ranges for IPv4 and IPv6. Connect to the resolved IP. Re-check after each redirect (max 3). 1 MB and 10 second limits. | Planned, phase 4 |
| Webhook spoofing | Random 32-byte URL path, optional HMAC-SHA256 signature, body size limit | Planned, phase 3 |
| Secrets leaking into logs | Secrets inserted by reference at execution time, masked in run history, redacted from logs | Planned, phases 2 to 6 |
| Expression injection | Expressions are path lookups only (no eval or Function), with limits on template size, path depth and output size. See [decision 0002](decisions/0002-expression-resolver.md). | Phase 1 |
| Approval link theft and replay | Signed, expiring, single-use links | Planned, phase 7 |
| Prompt injection through trigger data | Trigger data goes in a delimited user message, never the system prompt. Output is validated against a JSON schema. | Planned, phase 7 |
| MCP tool abuse | Bearer token per user, only published form-trigger workflows exposed, approval steps still apply, rate limits | Planned, phase 8 |
| Oversized payloads | Body size limits on every route, 1 MB HTTP response limit, at most 100 steps per definition, expression output limit | Partly phase 1, rest planned |
| Two workers running the same step at once | Run lease claimed with a conditional UPDATE, guarded state updates, unique `(run_id, step_id, attempt)` | Done, phase 2 |
| Stolen database credentials | Least-privilege role for the API and worker | Planned, phase 3 |
