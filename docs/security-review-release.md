# Release-candidate security review, 19 November 2026

Reviewed commit `3d6ee99` (covering phases N6 to N27, including N11a, N11b, N11c-1 to N11c-3, N11d, N24 Managed OAuth, read-side secret redaction across every API and MCP surface, and the 90-day `retired_secrets` purge job), then verified fixes in `2988b78` and `6caf0d2`.

## Release verdict

Code review status after fixes: pass with low findings. Zero high findings exist, all three high findings from the earlier 19 November review (`docs/security-review-2026-11-19.md`) remain closed with no regression, and all five medium findings raised on `3d6ee99` are fixed with regression tests.

Public sign-up stays on hold only until the owner finishes the deployment topology and live provider checks in `docs/deployment.md` section 8 items 1 to 7 (proxy hop count, Secure cookie flags over HTTPS, Origin/Host forwarding, sibling-domain check, proxy query-string logs, VM upload memory under `docker stats`, and live PayMongo test-key verification).

## High severity

None.

## Medium severity (found on `3d6ee99`, fixed in `2988b78` and `6caf0d2`)

### M1. OAuth refresh lock omitted `authMethod = "oauth"`

`connectionsStore.lock`, `refreshed`, `refused`, and `keepOAuthAlive` in `packages/db/src/oauth/core.ts` queried `connections` by `(userId, provider)` without filtering `authMethod = "oauth"`, and `readTokenBlob` in `packages/db/src/oauth/blob.ts` accepted bare strings for every provider. A race when switching an OAuth connection to a pasted credential could send the pasted key or token to an OAuth token endpoint and mark the new connection failed.

Fixed in `2988b78`: added `eq(connections.authMethod, "oauth")` to `connectionsStore` queries and `keepOAuthAlive`, and restricted bare refresh-token parsing in `readTokenBlob` to Outlook (`allowBare`). Covered by `packages/db/src/oauth/core.test.ts`.

### M2. Guided public form generators echoed untrusted visitor text in receipts

`websiteInquiryDefinition`, `officeRequestDefinition`, and `purchaseRequestDefinition` (plus Tagalog strings in `packages/engine/src/template-language.ts`) were missed by the earlier M10 fix and still echoed visitor-supplied `name`, `message`, `summary`, or `cost` into emails sent to visitor-supplied addresses.

Fixed in `6caf0d2` and the follow-up timeout fix: removed visitor fields from public receipt, customer reply, and unapproved `tell_no_decision` timeout steps across `packages/engine/src/website-inquiry.ts`, `office-request.ts`, `purchase-request.ts`, `templates.ts` (`receipt-expense`), and `template-language.ts`, keeping fixed acknowledgement text and the opaque `{{trigger.reference}}` where tracked. Internal staff notifications still carry the submitted details. `packages/engine/src/templates.test.ts` now traverses `on: "timeout"` edges on approval steps in both English and Tagalog. Covered by `packages/engine/src/templates.test.ts` and `packages/engine/src/email-language.test.ts`.

### M3. `purgeRetiredSecrets` loaded all workspace history in one unbounded query

`scrubWorkspaceHistory` in `packages/db/src/retired-secrets.ts` selected every historical row across `runs`, `step_runs`, `deliveries`, `requests`, `calendar_events`, and `payments` at once on worker startup, risking worker OOM crash-loops on high-volume workspaces.

Fixed in `6caf0d2`: converted all six history tables to keyset-paginated batches (`ORDER BY id LIMIT 200`, configurable `batchSize` for tests). Covered by `packages/db/src/retired-secrets.test.ts`.

### M4. `purgeRetiredSecrets` lacked row locks and active-run TOCTOU protection

Selecting without `FOR UPDATE` and rewriting all read columns could overwrite concurrent worker updates, and deleting expired `retired_secrets` rows while a run or delivery was in flight could leave newly written occurrences unredacted.

Fixed in `6caf0d2`: `purgeRetiredSecrets` now skips a workspace when any `runs` row is `running` or any `deliveries` row is `sending` (checked inside the workspace transaction before scrubbing and before deleting), locks each batch with `FOR UPDATE`, recomputes scrubbed values on locked rows, and updates only columns that changed. Covered by `packages/db/src/retired-secrets.test.ts`.

### M5. Out-of-order PayMongo refund started `paid` listeners and ignored `livemode`

When `payment.refunded` arrived before `checkout_session.payment.paid`, `apps/api/src/public.ts` started `paid` fulfilment listeners before checking kept refunds, and kept refund rows neither stored nor checked `livemode`.

Fixed in `2988b78`: kept `payment.refunded` rows now store and enforce `livemode` in both `apps/api/src/public.ts` and `packages/db/src/paymongo.ts`, and matching kept refunds are applied before `startRuns(..., "paid")` so already-refunded payments trigger only `refunded` listeners. Covered by `apps/api/src/paymongo.test.ts` and `packages/db/src/paymongo.test.ts`.

## Low severity

- L1 (closed in `2988b78`): `fromOwnOrigin` in `apps/api/src/auth.ts` now compares `${req.protocol}://${host}` so an `http://` origin cannot pass against an HTTPS `Host` header. Covered by `apps/api/src/cross-site.test.ts`.
- L2 (closed in `2988b78`): `GET /approvals/:token` in `apps/api/src/approvals.ts` now loads `findPendingApproval` and `historyHider` in one `REPEATABLE READ` read-only transaction, and `asBadRequest` in `apps/api/src/connections.ts` redacts `ProviderError.message` through `historyHider`. Covered by `apps/api/src/secrets-history.test.ts`.
- L3 (open, low): `PUT /secrets/:name` still accepts short values (`min(1)`), so rotating a 1-character or 2-character secret would cause broad substring replacement during the 90-day purge. Consider raising the minimum secret length in a follow-up.
- L4 (closed in `2988b78` for stale warnings): `sharedGrants` in `packages/db/src/oauth/shared.ts` now excludes disconnected Gmail senders (`status <> 'disconnected' and password_ciphertext is not null`). Covered by `packages/db/src/oauth/shared.test.ts`.
- L5 (closed in `2988b78`): `docker-compose.yml` now forwards `MAILBOX_DAILY_CAP`, `RETIRED_SECRETS_MAX_AGE_DAYS`, and `PAYMONGO_LIVE`, and `.env.example` documents `RETIRED_SECRETS_MAX_AGE_DAYS`.
- L6 (open, low): password reset and invite acceptance still POST tokens in URL paths (`/auth/password-reset/:token`, `/auth/invites/:token/accept`). Moving the token into the JSON body is a low-risk follow-up.
- L7 (closed in `6caf0d2`): removed local machine paths and username references from `PROJECT.md`, `docs/design/console-redesign-phases.md`, and `docs/oauth-try-it.md`.

## Control verification summary

- N11a (password change/reset, scoped and expiring API/MCP tokens): verified.
- N11b (daily mailbox recipient caps, webhook timestamp and 5-minute replay window, pause, pending run cancel): verified.
- N11d (scheme-aware own-origin guard, pre-multipart upload budget, complete route role matrix covering all PR #2 OAuth routes, LLM redirect refusal, Trello error URL redaction): verified.
- N24 (Managed OAuth state/PKCE/AAD/scope manifests/disconnect/shared-grant checks): verified after M1 and L4 fixes.
- Read-side secret redaction and 90-day purge (`docs/decisions/0067-retired-secrets-purge.md`): verified across every API and MCP read surface after M3, M4, and L2 fixes.
- Frontend DOM XSS (`apps/web/src/`): zero `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `document.write`, `eval`, or `new Function`.

## Public-repository secret and PII audit

All 672 tracked files (`git ls-files`) were checked for `.env` files, real API keys, OAuth secrets, private keys, webhook URLs, personal emails, and local machine paths. Zero `.env` files, zero real credentials, zero personal emails, and zero local machine paths remain. All secret-looking strings in test files are synthetic test fixtures.
