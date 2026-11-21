# 0078: Pre-release checklist from the November review (N11d)

## Context

The "Before release" list at the end of the [19 November security review](../security-review-2026-11-19.md) has three items, and its "Route and data checks" table names two code points to close. The owner was away, so this plan was pre-approved and is recorded here before the work. Each item below got a failing or characterisation test first.

## Plan, by item

**1. Regression coverage for H1, H2 and H3, and a role check on every route.**
- H1 and H2 had template and API-level tests only. New `order-fulfilment.test.ts` drives the real executor against the fake PayMongo: the order starter parks at the owner's approval with no payment session and shows the typed amount; a "no" makes no session; a "yes" makes exactly one for the approved amount and a pesos row. A sandbox payment, and a live payment made by a builder test run, start listener runs that queue no delivery and send no mail. A live payment made by a real run does both, so the test cannot pass by the fakes being deaf.
- H3 already had tests that pause between the two reads for the form, the webhook and the payment listener (`public-intake.test.ts`, `paymongo.test.ts`). Left as they are.
- The route matrix in `members.test.ts` listed about a third of the routes. It now lists every session route (owner, operator, approver, requester and signed out). A completeness test reads the registered routes from the router and fails when a route is in neither the matrix nor the short list of routes with their own rules (sign-in, public forms and hooks, approval links, MCP, OAuth callback, logo). It also fails on a matrix row that matches no route.
- A two-workspace test names 33 objects of workspace A by id (workflow and its sub-routes, run, files, resource, token, delivery, booking, secret, email source) from workspace B's owner. All answered 404 or changed nothing. This did not find a hole.

**2. Deployed topology.** Verifiable in code:
- Aggregate upload budget. The multipart parser buffered a submission before the form was even looked up, and the per-file and per-IP limits do not bound the total. A guard now runs before the parser. It refuses a multipart post with no `Content-Length` (411), one above what a submission can hold, 5 files of 5 MB plus the text fields (413), an unknown form (404) and a form with no file field (415). It reserves the declared length from a 128 MB budget and answers 503 with `Retry-After` while the budget is full; the reservation is released when the response closes. Node never delivers more than the declared length, so the reservation is the most the request can occupy. Options: a size-limited stream wrapper (rejected: more code, same bound), a reverse proxy limit only (kept as advice, but the app must not depend on it).
- Sibling sites. `SessionGuard` now refuses a POST, PUT, PATCH or DELETE whose `Origin` is neither the `PUBLIC_URL` origin nor the host the request was sent to. Reproduced first: a form post from a sibling origin created a workflow with the owner's cookie, because SameSite=Lax cookies go to siblings of the same site and the API parses urlencoded bodies. A request with no `Origin` is not a browser page and passes, so tokens, tests and scripts are unchanged. A custom header or CSRF token was the alternative; it would change every client call.
- URL redaction. Daloy's own errors never carry the request URL or its query (new `provider-errors.test.ts` for Trello, which sends its key and token in the query). Proxy and outbound logs are the operator's.
- Cookie flags already had tests (`api.test.ts`, `deploy.test.ts`).

**Route and data checks.** Both model calls (`generate`, `listModels`) now use `redirect: "error"`. Reproduced first: a 307 from the model host moved the prompt to another origin.

## Skipped, and why

- Trusted proxy hop count, Secure cookie, sibling hosts, and URL redaction in proxy and outbound logs on the real VM: they need the owner's deployment. `docs/deployment.md` section 8 lists the exact checks.
- Signed PayMongo test deliveries, event retry timestamps and refund reconciliation against PayMongo: they need the owner's PayMongo account (`docs/live-paymongo-check.md`).
- Repeating the review on the exact release commit with N11a and N11b: that is the final N11 step, after this phase merges.

## Consequences

- A proxy must pass the browser's `Origin` header unchanged, or send the public `Host`. A console reached by a name that is neither `PUBLIC_URL` nor the proxy's forwarded `Host` gets 403 on every change.
- A slow upload holds its reserved bytes until it finishes, so a few slow clients can fill the budget and see 503 for other uploads. Form posts without files are not counted. The budget is per process, like the rate limits.
- A multipart post to a form with no file field is refused. The hosted page only sends multipart when the form has a file field.
- No migration.
