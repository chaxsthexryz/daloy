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
| SSRF through the HTTP step | Allow only http and https on ports 80 and 443. Block private, loopback, link-local and metadata ranges for IPv4 and IPv6, including IPv4-mapped addresses. Check inside the socket's DNS lookup, so the connection goes to the checked address. Re-check after each redirect (max 3) and drop the caller's headers on a cross-origin redirect. 1 MB and 10 second limits. See [decision 0006](decisions/0006-ssrf.md). | Done, phase 4 |
| Webhook spoofing | Random 32-byte URL path, optional HMAC-SHA256 signature checked in constant time, 256 kb body limit, 60 requests a minute per IP | Done, phase 3 |
| Secrets leaking into logs | Secrets are inserted by reference (`{{secrets.name}}`) only while a step runs. Their values are replaced with `[secret]` in step output and error text before anything is stored. Masking in the run history view comes in phase 6. | Done, phase 4 (view masking in phase 6) |
| Expression injection | Expressions are path lookups only (no eval or Function), with limits on template size, path depth and output size. Resolution is a single pass, so trigger data containing `{{secrets.x}}` stays literal text. See [decision 0002](decisions/0002-expression-resolver.md). | Done, phase 4 |
| Approval link theft and replay | Signed, expiring, single-use links | Planned, phase 7 |
| Prompt injection through trigger data | Trigger data goes in a delimited user message, never the system prompt. Output is validated against a JSON schema. | Planned, phase 7 |
| MCP tool abuse | Bearer token per user, only published form-trigger workflows exposed, approval steps still apply, rate limits | Planned, phase 8 |
| Oversized payloads | Body size limits on every route, 1 MB HTTP response limit, at most 100 steps per definition, expression output limit, at most 10 email recipients | Done, phases 1 to 4 |
| Two workers running the same step at once | Run lease claimed with a conditional UPDATE, guarded state updates, unique `(run_id, step_id, attempt)` | Done, phase 2 |
| Stolen database credentials | Least-privilege role for the API and worker | Planned, phase 9 |
| Password guessing on login | argon2id hashes, 10 login attempts a minute per IP, same response time for unknown emails | Done, phase 3 |
| Cross-site request forgery on console routes | SameSite=Lax session cookie, so other sites cannot send it with a POST | Done, phase 3 |
| Session theft from a database leak | Only SHA-256 of session cookies and API tokens is stored | Done, phase 3 |
| Form spam | Honeypot field, 10 submissions a minute per IP, field validation | Done, phase 3 |
| Test runs used to reach internal hosts or send mail | Test runs mock HTTP and email unless "live calls" is ticked; live test runs use the same SSRF guard and recipient cap as real runs | Done, phase 5 |
| Script injection in the console | React escapes all rendered values, including step outputs and trigger data; no `dangerouslySetInnerHTML`; helmet's CSP blocks inline scripts on the served console | Done, phase 5 |
