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
- Approval links (public, random single-use token)
- MCP endpoint (bearer token)
- Outbound: HTTP request step, email step, LLM calls

## Threats and mitigations

| Threat | Mitigation | Status |
| --- | --- | --- |
| SSRF through the HTTP step | Allow only http and https on ports 80 and 443. Block private, loopback, link-local and metadata ranges for IPv4 and IPv6, including IPv4-mapped addresses. Check inside the socket's DNS lookup, so the connection goes to the checked address. Re-check after each redirect (max 3) and drop the caller's headers on a cross-origin redirect. 1 MB and 10 second limits. See [decision 0006](decisions/0006-ssrf.md). | Done, phase 4 |
| Webhook spoofing | Random 32-byte URL path, optional HMAC-SHA256 signature checked in constant time, 256 kb body limit, 60 requests a minute per IP | Done, phase 3 |
| Secrets leaking into logs | Secrets are inserted by reference (`{{secrets.name}}`) only while a step runs. Their values are replaced with `[secret]` in step input, output and error text before anything is stored. The run history API masks again by key name (`password`, `token`, `authorization`, `api_key`, `cookie` and similar) in trigger data, step input and step output. See [decision 0008](decisions/0008-step-input.md). | Done, phases 4 and 6 |
| Expression injection | Expressions are path lookups only (no eval or Function), with limits on template size, path depth and output size. Resolution is a single pass, so trigger data containing `{{secrets.x}}` stays literal text. See [decision 0002](decisions/0002-expression-resolver.md). | Done, phase 4 |
| Approval link theft and replay | 32 random bytes per link, only the SHA-256 stored, so a database leak gives no working links. The link expires with the step's timeout and works once (guarded UPDATE on `used_at`). GET only shows the request, so link scanners cannot decide; POST records it. Unknown, used and expired links get the same response. `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. 30 views and 10 decisions a minute per IP. Remaining risk: whoever holds an unused link can decide, because the email is the only authentication. See [decision 0009](decisions/0009-approval-links.md). | Done, phase 7 |
| An AI-built workflow does something the owner did not want | The AI only returns a draft. It is checked against the same definition schema as a hand-built workflow, shown in the editor as unsaved, and runs only after the owner saves or publishes it. Test runs mock HTTP and email by default, and live HTTP steps still pass the SSRF guard. `POST /ai/draft` needs a session and is limited to 10 calls a minute per IP. See [decision 0017](decisions/0017-ai-workflow-drafts.md). | Done |
| Provider API keys saved in the console | Encrypted with AES-256-GCM like secrets, with the user and provider as associated data; write-only (the API returns only `hasKey`); error messages never include the provider's response body. See [decision 0016](decisions/0016-ai-settings-page.md). | Done |
| The AI model page used to make the server call internal hosts | No user-entered URLs: hosted providers have fixed URLs in code, and the local choice uses the operator's `LLM_BASE_URL`. The live test is limited to 10 calls a minute per IP. | Done |
| Trigger data sent to a hosted model | Ollama on the host is the default, so nothing leaves the machine. A hosted provider (`LLM_PROVIDER=openai`) is opt-in through env vars and `.env.example` says what it receives. `LLM_API_KEY` comes from the environment and LLM errors never include the provider's response body. Remaining risk: with a hosted provider, form messages, names and emails reach that provider, and free tiers may use them for training. See [decision 0015](decisions/0015-openai-compatible-llm.md). | Done |
| Prompt injection through trigger data | Trigger data only reaches the model inside `<data>` tags in the user message; a closing tag in the data is escaped. The system prompt holds only fixed text and the owner's literal text (the schema rejects `{{` there). Replies are validated against a fixed per-task JSON schema, so classify can only return a configured label. Remaining risk: a model can still be steered within that schema, such as a wrong label or unwanted text in a draft. See [decision 0010](decisions/0010-ai-step.md). | Done, phase 7 |
| MCP tool abuse | Bearer token per user, stored as SHA-256 and checked on every request, so revocation takes effect at once. A token only sees its owner's workflows and runs; another user's run gets the same "run not found" as a missing one. Only workflows with a form trigger and a published version become tools, and their arguments pass the same field schema as the hosted form. Runs keep their approval steps. 60 requests a minute per IP and a 256 kb body limit. Remaining risk: a leaked token can start the owner's form workflows until it is revoked; there are no per-token scopes. See [decision 0011](decisions/0011-mcp-sdk-v2.md). | Done, phase 8 |
| Oversized payloads | Body size limits on every route, 1 MB HTTP response limit, at most 100 steps per definition, expression output limit, at most 10 email recipients | Done, phases 1 to 4 |
| Two workers running the same step at once | Run lease claimed with a conditional UPDATE, guarded state updates, unique `(run_id, step_id, attempt)` | Done, phase 2 |
| Stolen database credentials or SQL injection | In compose the API and worker connect as `daloy_app` (SELECT, INSERT, UPDATE, DELETE only); a one-shot `migrate` service holds the owner credentials. CREATE on `public` is revoked from PUBLIC. Remaining risk: the app role can still read and change every row. See [decision 0013](decisions/0013-app-database-role.md). | Done, phase 9 |
| Password guessing on login | argon2id hashes, 10 login attempts a minute per IP, same response time for unknown emails | Done, phase 3 |
| Cross-site request forgery on console routes | SameSite=Lax session cookie, so other sites cannot send it with a POST | Done, phase 3 |
| Session theft from a database leak | Only SHA-256 of session cookies and API tokens is stored | Done, phase 3 |
| Form spam | Honeypot field, 10 submissions a minute per IP, field validation | Done, phase 3 |
| Test runs used to reach internal hosts or send mail | Test runs mock HTTP and email unless "live calls" is ticked; live test runs use the same SSRF guard and recipient cap as real runs | Done, phase 5 |
| Script injection in the console | React escapes all rendered values, including step outputs and trigger data; no `dangerouslySetInnerHTML`; helmet's CSP blocks inline scripts on the served console | Done, phase 5 |
