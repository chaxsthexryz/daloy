# 0057: Public intake fixes (N11c-2)

## Context

The security review of 19 November ([security-review-2026-11-19.md](../security-review-2026-11-19.md)) found seven problems where a public visitor or a public sign-up reaches more than it should: H3, M1, M6, M10, M14, M15 and M17. Each one gets a failing test that shows the consequence, then the fix, then the review's own check.

## Options and decisions

**H3, a submission crossing a republish.** The public form, the generic webhook and the PayMongo listener each read the trigger row in one query and the latest published version in a later one. Publishing updates both in one transaction, so the gap is only between the two reads. Options: a REPEATABLE READ transaction around the reads, or one SQL statement that joins the trigger to its latest published version. One statement sees one snapshot under READ COMMITTED and needs no transaction, so it was chosen. The handlers also take the trigger settings (fields, signing secret, payment events) from that version's own definition and refuse an entry point whose version no longer has the matching trigger type. The run is created for exactly that version.

**M1, a blank signing-secret name.** The definition schema now requires a secret name that matches the secrets page's rule (`a-z`, `0-9`, `_`). Publishing a webhook with a signing secret checks that the workspace has that secret. At intake any `hmacSecret` key that is present, blank included, means the call must be signed, so an old definition with a blank name fails closed with 401.

**M6, unbounded work for public sign-ups.** Options: give accounts without a plan finite limits (changes every existing private installation), or put new sign-ups on a small plan. A new `preview` plan was added (one live automation, a schedule at most hourly, small daily email, HTTP and upload counts, no shared AI key). Registration sets it unless the installation sets `SIGNUP_PLAN=none`, which keeps the old unlimited behaviour as an explicit choice. The operator approves an account by setting a real plan. Existing accounts are not changed.

**M10, a stranger's text in the office's receipt.** The contact and client-request starters now send a fixed acknowledgement to the address on the form. The submitted text stays in the sheet or the staff record. Existing workflows made from the old starters keep their old wording until the owner edits them.

**M14, a sibling origin posting a tracked request as a member.** The standalone form records a signed-in member as the requester only when the `Origin` header equals the installation's public URL origin. Any other submission, and every embed, is anonymous. A session-bound anti-forgery token was the alternative; the origin check needs no page change and covers the same case.

**M15, repeated uploads spending the allowance.** On a tracked form the upload count is claimed inside the transaction that creates the request, its run and its files. A repeat with the same submission key returns the first reference before any claim, and a concurrent duplicate that loses the unique index rolls back its claim too.

**M17, unverified guests reserving slots.** The Lead to booking starter now puts a staff approval before the booking step, so a public request holds nothing until a person approves it. A held-slot model with expiry was the alternative; it needs a new booking state and a sweeper, and it would overlap N27's booking work. Custom workflows that book straight from a public form remain the owner's choice.

## Consequences

- One query per public entry point instead of two. A request that overlaps a republish runs the version it was authorized against, or is refused.
- Saving a webhook with a signing secret that does not exist yet is refused at publish.
- Sign-ups on a public installation start limited. A private installation that wants the old behaviour sets `SIGNUP_PLAN=none`.
- A requester shows in My requests only for a same-origin submission, so a proxy must pass the browser's `Origin` header unchanged and `PUBLIC_URL` must match the address people use.
- The Lead to booking starter needs an approver to act before anything is booked.
- Migration 0036 widens the plan check.
