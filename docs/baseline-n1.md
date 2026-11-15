# Baseline before N2 to N6 (phase N1)

Documentation only. Nothing here was run against a real provider. Written on 15 November 2026.

## Commit check

- Current commit: `8546aa8` (working tree clean).
- Reference: `0d7fd09`, the commit that recorded the disposable Docker Compose verification of P7.
- Between them: one commit, `8546aa8`, which changes `PROJECT.md` only (18 lines added, the "Next phases" section). No code, test, migration or other doc changed.
- So the P7 results recorded at 80b2dd9 and 0d7fd09 still describe the code: 129 tests, 119 harness cases with no gaps, 20 migrations (0000 to 0019), and a clean `docker compose up` under a disposable project name. Test counts after the security fixes (543 unit and API tests, 13 Playwright tests at 55dbb88) are as recorded in `PROJECT.md`; they were not re-run for N1.

## How to read the blocker tables

Severity:

- Blocks: the phase cannot be ticked while this is open.
- Gate: does not stop its phase, but must be closed or accepted in writing before N6 (publishing).
- Limit: a known limit. Record it, keep it listed, no exit work planned.

The sources are the "Also open" list and "Next phases" in `PROJECT.md`, the three `docs/live-*-check.md` files, `docs/retest-eight-workflows.md`, `docs/retest-security-fec03cc.md`, `docs/how-it-works.md` and the README's known limitations.

## N2: live provider checks

| # | Blocker | Severity | Evidence | Exit condition |
| --- | --- | --- | --- | --- |
| N2-1 | Gmail has never been used for real. Everything so far ran against `test/fake-smtp.ts`. | Blocks N2a | `docs/live-gmail-check.md` ("Status: not run yet"); README limitations | Steps 1 to 9 run and recorded in that file with date and commit, plus the booking check in N2a: four confirmations and exactly two reminders in Sent, none for the cancelled booking, and the revoked app password failing with "Gmail rejected the app password" and nothing sent from another address |
| N2-2 | Queued Sheets, Slack, Outlook and Teams deliveries (and idempotent HTTP calls) have no send lock. A booking that changes just before such a send does not stop it, and Retry or Post again do not check the booking. | Blocks N2b | `PROJECT.md` P6b "Remaining"; `docs/how-it-works.md` ("Known race") | Tests first, then code: a delivery linked to a run whose booking changed is not sent, including Retry and Post again. `pnpm test` and the harness stay green |
| N2-3 | Google Sheets never tried on real Google: developer metadata uniqueness, the atomic `batchUpdate`, the metadata size limit, duplicate refusal, marker cleanup after 24 hours | Blocks N2c | `docs/live-sheets-slack-check.md` steps 1 to 4 and 9 to 11; `docs/retest-security-fec03cc.md` "Not covered"; decision 0021 | Those steps run and recorded. If real Google behaves differently from the fake, decision 0021 and the README are corrected before ticking |
| N2-4 | Slack never tried on a real workspace: bot not in channel, revoked token, Retry posting once | Blocks N2d | `docs/live-sheets-slack-check.md` steps 3 to 5 and 8 | Those steps run and recorded |
| N2-5 | No Microsoft account was available for Outlook and Teams | Limit unless accounts exist | `docs/live-microsoft-check.md` ("Status: not run yet"); README limitations | If a free Microsoft account and a Microsoft 365 developer sandbox exist: steps 1 to 9 run and recorded. If not: both stay marked unverified in the README and N2e is closed as skipped |
| N2-6 | `PROJECT.md` lists Discord among the live checks, but no `docs/live-*-check.md` covers it | Limit | `PROJECT.md` "Also open" | Either write a short Discord check, or remove Discord from the "Also open" line with a one-line reason |
| N2-7 | N2 is the only phase that calls real providers, and it must not touch the development stack | Blocks N2 | `PROJECT.md` N2; `docs/retest-security-fec03cc.md` (do not change the development database) | A disposable compose project (own name, remapped ports, throwaway `SECRETS_KEY`, own volume), as in the P7 check. Never `docker compose down -v` without `-p`. Test accounts only |

### Test accounts N2 needs

Record only what is needed. No credentials go in this repo, in this file or in chat; they live in the disposable stack's env file and the provider consoles.

| For | Account | What it must have |
| --- | --- | --- |
| N2a Gmail | One Gmail account owned by the user, used as the sender | 2-Step Verification on and an app password created for it; a second inbox (any address) to play the guest or customer; ability to revoke the app password for the revoke step |
| N2c Sheets | One Google account and a Google Cloud project (no billing) | Google Sheets API on; a service account and one JSON key (deletable for step 7); one Google Sheet with a tab named `Requests`, shared with the service account's email as Editor; Apps Script or the API explorer to inspect developer metadata |
| N2d Slack | One Slack workspace where apps can be installed | An app with bot scopes `chat:write` and `channels:read`, installed; the Bot User OAuth Token; one public channel the app is invited to (and can be removed from) |
| N2e Outlook | Only if available: a free Microsoft account plus a Microsoft 365 developer sandbox with an Exchange Online mailbox | An Entra app registration (any organizational directory, web redirect `http://localhost:3000/settings/connections/outlook/callback` or the stack's `PUBLIC_URL`), a client secret, Graph delegated `Mail.Send`, `User.Read`, `offline_access`; a second user to act as non-admin and one to act as approver |
| N2e Teams | Same sandbox | One team and channel with a Workflows link from "Post to a channel when a webhook request is received" |

## N3: independent retest and release readiness

| # | Blocker | Severity | Evidence | Exit condition |
| --- | --- | --- | --- | --- |
| N3-1 | `55dbb88` (Sheets marker rules, migration 0013) passed its own checks but awaits Astra's independent retest | Blocks N3 | `PROJECT.md` security regression entry; `docs/retest-security-fec03cc.md` | Astra retests the Sheets, Slack, booking, email and verified delivery paths at one commit and the result is recorded |
| N3-2 | `a6d7636` (staff and MCP reschedule times read in the booking's timezone) has a regression test but no retest of its own recorded | Blocks N3 | `PROJECT.md` "Fix from Astra's retest of cf85966"; `docs/retest-eight-workflows.md` (timezone after a workflow edit); test "reads staff's time in the booking's timezone" | Covered by the N3-1 retest at a commit that includes `a6d7636`, with the result recorded next to its reproduction |
| N3-3 | No backup, restore or stop-all-sends procedure is written down, and monitoring of `failed` and `needs_review` runs is not defined. Searching the README, `docs/reliability.md` and `docs/threat-model.md` finds no mention of backup or restore. | Blocks N3 | Absence in those files; `PROJECT.md` N3 | A deployment with a backup and one tested restore; a way to stop all sends (turn workflows off, drain the worker) tried once; a check or alert for failed and `needs_review` runs; each written up in `docs/` |
| N3-4 | Upgrade from the previous migration is untested. The recorded clean-start checks applied migrations 0000 to 0019 to empty databases. | Blocks N3 | `docs/retest-eight-workflows.md` clean Compose startup; README ("The database role init script only runs when the Postgres volume is created") | A database at 0018 or the previous release, with data, upgraded to the latest migration and checked, in a disposable stack |
| N3-5 | A Discord webhook URL is typed straight into one "Client lead triage" version in the development database. Operators can see it by design. | Gate | `PROJECT.md` "Also open"; `docs/retest-security-fec03cc.md` "Not covered". The URL is not copied here. | The owner moves it into a secret and rotates the webhook; the development version is replaced. Not done by this session. The `QA-01` to `QA-08` workflows and the development data stay untouched |
| N3-6 | Secret values deleted before `retired_secrets` existed are unknown to read-time redaction | Gate | `PROJECT.md` "Also open"; `docs/retest-security-fec03cc.md` | Either those secrets are rotated and the old values treated as exposed, or the gap is accepted in writing for the demo copy |
| N3-7 | A shared-mail approval revoked while a send is in flight lets that one send finish | Limit | `PROJECT.md` "Also open"; `docs/retest-security-fec03cc.md` | Accepted and kept in the README, or fixed with a test |
| N3-8 | A Teams Workflows link replaced under the same channel name is not seen as a destination change | Limit | `PROJECT.md` "Also open" | Destination change compares the link itself, or the limit stays listed |
| N3-9 | Superseded waiting booking runs keep their job until they wake. Reschedule changes the time only. | Limit | `PROJECT.md` P6b "Remaining" | Accepted, or fixed with a test, before real bookings are taken |
| N3-10 | Replay of MCP retries and of event keys built from datetime, resource or padded text fields is only partly covered. An MCP caller key is not scoped to workspace and workflow. | Gate | `PROJECT.md` "Also open" and the ad0173f fixes; `docs/retest-eight-workflows.md` | Booking workflows use a stable event id (documented), and the MCP key scoping is built or the limit is kept in the README |
| N3-11 | Production database failover and client reconnection during an approval decision are untested | Gate | `docs/retest-security-fec03cc.md` "Not covered" | Tried once on the disposable stack, or accepted for the demo copy |
| N3-12 | CI only builds the compose images; it does not start the stack. The reliability numbers come from one laptop with one worker. | Limit | README limitations | Kept listed; the N3 deployment check is the first start of the real stack outside a laptop |

Progress after N1, local and provider free: N3-3 is partly met. Backup, one restore, stopping all sends and a check for failed and `needs_review` runs were tried on a disposable Compose project and written up in `docs/operations.md`. Still open for N3-3: a chosen deployment with its own backup and restore, and an alert (today it is a daily check). There is no per-workflow off switch, so "turn workflows off" means stopping the worker. N3-4 is met by the 0018 to 0019 case in `apps/api/src/upgrade.test.ts`, which runs on the embedded test Postgres. The restore drill above ran the same migrations in Compose.

## N4: AI Workflow Doctor

| # | Blocker | Severity | Evidence | Exit condition |
| --- | --- | --- | --- | --- |
| N4-1 | The fixed rules are the only part that can be checked without a model. Draft warnings come from five rules and can be wrong (a field really named `test` is flagged). The save API and MCP return no warnings. | Limit | README limitations; `packages/engine/src/lint.ts`; `docs/retest-eight-workflows.md` P7 checks | The first Doctor version explains failures from run records, provider errors and lint results with fixed rules and tests per rule, and shows its rule name with every line so a wrong one can be reported |
| N4-2 | Live AI is deferred until DeepSeek through OpenRouter is set up. Real-model generation and repair quality, and prompt-injection behaviour, are unverified. | Gate for any Doctor feature that suggests or applies a fix | `PROJECT.md` "Still unverified" and N4; README limitations | Suggested fixes and applying them with approval stay out of N4's first version. When live AI exists, a measured check using the P3 test controls (numbers from a run, never invented) comes first. Approving a fix never approves a run |
| N4-3 | The "G1" gate that N4 refers to is in the post-P7 roadmap (`post-p7-roadmap.md`), which sits outside this repo. `docs/business-automation-roadmap.md` has no G1 or B1 section. | Limit | Search of `docs/business-automation-roadmap.md` | Copy the G1 and B1 gate text into the repo (or a decision record) when N4 starts, so a fresh session can read it |

## N5: browser automation

| # | Blocker | Severity | Evidence | Exit condition |
| --- | --- | --- | --- | --- |
| N5-1 | Nothing exists yet: no isolated browser worker, no typed operations, no threat-model entries for it. The HTTP step only reaches ports 80 and 443 and has SSRF protection that a browser would bypass. | Blocks N5 | `docs/threat-model.md` has no browser entries; README limitations | A decision record and threat-model rows before code; a separate worker with its own network limits; read-only navigation and extraction with typed, restricted operations; tests first for the restrictions |
| N5-2 | Authenticated actions and AI-proposed actions have no gate | Gate | `PROJECT.md` N5 | Left out of N5's first version; each gets its own gate and review later |
| N5-3 | The B1 gate text is outside the repo (see N4-3) | Limit | `PROJECT.md` N5 | Same as N4-3 |

## N6: publish on the web

| # | Blocker | Severity | Evidence | Exit condition |
| --- | --- | --- | --- | --- |
| N6-1 | There has been no pilot and there are no beta testers. External beta is on hold until N6, so the first outside users arrive at publication. | Blocks N6 | `PROJECT.md` Next phases | N2 and N3 recorded, and N3-1 to N3-6 closed or accepted in writing, before any real account is connected on a public stack |
| N6-2 | Anyone holding an unused approval link can approve or reject. The email is the only check on who clicks. | Gate | README limitations | Accepted for a demo copy that sends nothing real, or a signed-in approver check is added before real accounts |
| N6-3 | Rate limits are counted per API process, MCP calls count per IP, and an API token can start every published form workflow of its owner | Gate | README limitations | Single process for the demo copy, or shared limits and token scopes before real accounts |
| N6-4 | A demo copy has not been built. The planned first step is Mailpit and no real sending. | Blocks N6 | `PROJECT.md` N6 | Demo copy runs with demo copy text, seeded data and no provider credentials; a public page states what it does not do |
| N6-5 | Real accounts need a final security review covering N4 and N5 | Blocks real accounts | `PROJECT.md` N6 | Review done at the release commit, findings fixed or listed |

## Order and what this file does not change

The order is N1, N2 (N2a, then N2b, then N2c, N2d, N2e), N3, N4, N5, N6, as set in `PROJECT.md`. N1 changes no code and calls no provider. Records of N2 results go into the `docs/live-*-check.md` files, not here.
