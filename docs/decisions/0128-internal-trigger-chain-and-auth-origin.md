# 0128: Internal trigger call chain and Origin checks on sign-in and approvals (S1)

## Context

The 24 November 2026 security audit (daloy-run-1, against 47f34a3) reproduced three findings:

1. High. An automation started by `payment_event` (`expired`) could ask for a payment and expire it at once. `payment_expire` raises a new `payment_event` with a fresh due id, so `dispatchInternalTrigger` started the same automation again, without end. Sub-workflows already carry `_callChain` and stop at `MAX_SUB_WORKFLOW_DEPTH`. Internal events did not.
2. Medium. `POST /approvals/:token` reads the session cookie to check a named approver and had no Origin check. SameSite=Lax still sends the cookie from a sibling origin of the same site, so a sibling page could decide an approval for a signed-in approver.
3. Medium. The `AuthController` routes run without `SessionGuard`, so they had no Origin check. A sibling or foreign page could post a urlencoded form to `/auth/login` and sign the visitor into the attacker's account (login CSRF), or post to `/auth/logout` and sign them out. `cross-site.test.ts` treated login from a sibling origin as allowed.

## Options

For the loop: a per-workspace rate limit on internal dispatches, rejecting the step pattern in `definitionSchema`, or carrying the same call chain sub-workflows use. For the forms: an anti-CSRF token in every auth form and the approval page, or the same Origin rule `SessionGuard` applies.

## Decision

- `InternalTriggerDispatch` takes an optional `callChain`. `dispatchInternalTrigger` skips a listener that is already in the chain, starts nothing once the chain holds `MAX_SUB_WORKFLOW_DEPTH` automations, and gives each new run `_callChain` in its trigger payload. The worker builds the chain with `runCallChain` (the lookup `call_workflow` already did) for the `payment_expire` and booking step events. Events from outside Daloy (webhooks, staff actions in the API) start a new chain.
- `OwnOriginGuard` in `apps/api/src/auth.ts` applies `fromOwnOrigin` to every non-GET route of `AuthController` and to `ApprovalsController.decide`. A request with no `Origin` header passes, as it does for `SessionGuard`. The approval page sends `Referrer-Policy: same-origin` in place of Helmet's `no-referrer`, because under `no-referrer` a browser posts a plain HTML form with `Origin: null`. The link token still never goes to another site in a referrer.

A schema rule would miss loops across two automations, and a rate limit would still let one loop run up to the limit. The Origin rule needs no new form fields and matches the rest of the console.

## Consequences

- An automation can no longer start itself again through a booking or payment event its own steps raised, and a chain of internal events stops after three automations. An automation that relied on that will stop at that point. Before this change, doing that already meant a loop.
- Trigger payloads of internally started runs now include `_callChain`, as sub-workflow payloads already did.
- Sign-in, sign-up, invite accept, sign-out and password reset posts from another origin get 403. The web app and the approval page post from their own origin, so they are unchanged. A proxy that rewrites `Origin` or `Host` has the same caveat as `SessionGuard` (docs/deployment.md section 8).
- Tests: `packages/db/src/internal-triggers.test.ts`, `apps/worker/src/steps/payments.test.ts` (the audit's loop), `apps/api/src/cross-site.test.ts`, `apps/api/src/approvals-named.test.ts`.
