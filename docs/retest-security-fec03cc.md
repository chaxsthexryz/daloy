# Retest handoff: security regression fixes after fec03cc

For an independent retest of the findings in `Daloy_Security_Regression_fec03cc.md`. Use disposable databases, synthetic identities and the local fakes (`test/fake-providers.ts`, fake SMTP). Do not contact real providers, and do not change the development database at `localhost:5432` except through the console as the demo owner.

## What changed, and how to probe each finding

| Finding | Change | Probe | Expected |
|---|---|---|---|
| P0: a retried approval email leaves two links that record conflicting outcomes | All links of one approval step in one run stand for one decision under the run's row lock. Later links keep the first deadline. `claimTimeout` waits for the deadline. Decision 0009. | 1. Deliver link A, then drop the SMTP connection; the step retries and sends link B. 2. Answer A, approving and then in a second run rejecting. 3. Try B. 4. Repeat with B answered first. 5. Answer A and B at the same moment from two clients. 6. Wake the run early (set `runs.next_attempt_at = now()`) with no answer. | Exactly one decision is stored on every link, and the run takes that branch once (one step row on the branch). The other link answers 404. Both links show the first deadline. Concurrent answers: one wins. Early wake: the run stays waiting until the deadline. |
| P1: a secret is recoverable from run history | Stored inputs are previews resolved with `[secret]`. Outputs and errors are redacted in raw, JSON-escaped, URL- and form-encoded forms. `GET /runs` and `GET /runs/:id` redact again with current and retired secrets. Decision 0025. | 1. Store a secret containing `"`, `\`, a newline and `%`. 2. Use it in a JSON body (quoted, bare and nested), in mock and live runs, against an endpoint that echoes the raw request. 3. Read the run as an operator. 4. Insert a historical row with the secret escaped. 5. Rotate the secret, then delete it, and read again. | No form of the value appears in `GET /runs/:id` or `GET /runs`, before or after rotation and deletion. The secrets route still gives operators 403. |
| P1: unsafe JSON fallback (`{"amount":{{trigger.note}}}`) | Bodies are parsed as JSON templates: a bare placeholder is one typed value. A JSON content type with a body that does not parse is refused at save (400) and fails at run without retrying. | 1. Send `1,"admin":true` as `note` to the unquoted template. 2. Save `{"a": 1` with `Content-Type: application/json`. | The receiver gets `{"amount":"1,\"admin\":true"}`. The bad template is refused. A body without a JSON content type stays raw text. |
| P1: Sheets edit before retry, and reconnect before retry | One atomic `batchUpdate` creates a developer metadata marker with an id chosen at queue time, then appends the row. Markers are kept 24 hours. Deliveries are pinned to the connection's account and destination. Unpinned (legacy) rows go to review. Decision 0021. | 1. Lose the acknowledgment of an applied write (`fake.once(":batchUpdate", "hang-after")`), edit the row, retry. 2. Apply a write late (`{ late: 450 }`) while a second worker takes over the stale claim. 3. Reconnect to another sheet, or another Slack channel, before the retry. 4. Clear `pinned_account` on a queued row. 5. Occupy the marker id with other metadata. | 1-2: one row. 3: review naming both destinations and no write anywhere; Post again writes once to the new destination. 4: review, no write. 5: review, no row. Markers are deleted only after 24 hours. |
| P1 conditional: localhost SMTP trusted as a catcher | With `NODE_ENV=production`, an unset `SHARED_MAIL` means `approved` for any host. Decision 0024. | Start the API or worker with `NODE_ENV=production`, `SMTP_HOST=127.0.0.1` and no `SHARED_MAIL`, as an unapproved sign-up. | No relay call; the step fails with "Connect Gmail". |
| Operator sending secrets to arbitrary destinations | Only owners save workflows and test runs (unchanged, asserted in `apps/api/src/members.test.ts`). Secrets reach HTTP steps only. A secret-bearing request may not take its host from trigger or step data, checked at save and at run. | Save, as the owner, an HTTP step with a secret header and URL `https://{{trigger.host}}/x`. Also run `https://api.example.com{{trigger.path}}` with `@evil.test/x`. Save an email step that names a secret. | Each is refused (400 at save, or a step failure without a request). The email step resolves a secret to nothing. |
| P2: labels | A failed run shows "Stopped, open details". A finished purchase shows "Finished". | Fail a purchase run after its first email. | No "Not sent" or "Decided" wording. |

## Automated evidence on this commit

- `pnpm lint` and `pnpm typecheck` exit 0.
- `pnpm test`: see the commit message for the count.
- `pnpm e2e`: 13 of 13 passed.
- Regression files:
  - `apps/worker/src/approval-retry.test.ts` (5 tests, all failing on the previous code)
  - `packages/db/src/approvals.test.ts` (the "one decision per approval step" block)
  - `apps/worker/src/steps/index.test.ts` (the "stored previews" block)
  - `apps/api/src/secrets-history.test.ts`
  - `packages/engine/src/json-template.test.ts`
  - `packages/db/src/deliveries.test.ts` (the "exactly-once Sheets writes and pinned destinations" block)
  - `packages/db/src/mail.test.ts` (the production default)
- A read-only check of the development database: all 47 saved workflow versions pass the new save checks, and all 29 bodies that declare JSON parse.

## Not covered, so please treat as open

- **Real Google behaviour:** developer metadata id uniqueness, atomic `batchUpdate`, and the roughly 30,000-character metadata limit per sheet were checked only against the local fake. `docs/live-sheets-slack-check.md` steps 9 to 11 cover them.
- **Production database failover and client reconnection** during a decision.
- **The eight-workflow acceptance gaps:** bookings, event dedup keys, outcome-picking previews, AI-only evaluation and scenario fixtures. They are the next phase.
- **Secrets deleted before `retired_secrets` existed** are unknown to read-time redaction.
- **A webhook URL typed into a definition** instead of a secret is visible to operators by design. One development workflow does this.
- **Concurrent revocation of a shared-mail approval** against an in-flight send.
