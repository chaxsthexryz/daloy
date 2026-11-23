# Editor layout and triggers roadmap

Written 24 November 2026 against `main` (`9f42911`). Decision and migration numbers are assigned when each phase is claimed so work never collides with active Resort concierge phases (`C5` to `C10`) or `J1`.

## Current baseline

Daloy already supports 9 triggers in `packages/engine/src/definition.ts`: `manual`, `schedule`, `form`, `webhook`, `email` (IMAP), `payment` (PayMongo), `meta_dm` (Messenger and Instagram DM), `shopify_order`, and `telegram_message`.

Scope boundaries stay unchanged:
- `Viber` remains out unless a customer signs and pays the monthly Viber Business Messages minimum directly (decision `0042` and `docs/plans/resort-concierge.md`).
- `WhatsApp Cloud API` remains tracked under `C10` (`N25`), gated on business verification and approved templates.
- `Onboarding.tsx`, `onboarding.css`, `lib/onboarding.ts`, `e2e/onboarding.spec.ts`, and `apps/web/public/logos/*.svg` remain untouched.

## Editor layout and engine usability (`E1` to `E4`)

| Phase | Scope | Key files |
|---|---|---|
| `E1. Visible leaf/branch adds and pinned header actions` | Render clickable `+` controls below every leaf node and unconnected branch stub (`true -> [+]`, `false -> [+]`), and pin global workflow actions (`Test run`, `Explain`, `Save`, `Publish`) in `a7-head` so the right side panel stays dedicated to the selected step, Setup guide, or AI box. | `apps/web/src/FlowCanvas.tsx`, `apps/web/src/Editor.tsx`, `apps/web/src/editor.css` |
| `E2. Branch-aware layered DAG layout and 1280 px inspector fit` | Replace equal-spacing row centering in `layout(draft)` with a branch-aware layered DAG layout that preserves `BRANCHES` left-to-right order, uses `measured[id].height` dynamically so tall cards never crowd, and avoids horizontal squeeze on 1280 px screens with 3-branch flows. | `apps/web/src/lib/graph.ts`, `apps/web/src/FlowCanvas.tsx`, `apps/web/src/editor.css`, `apps/web/src/lib/graph.test.ts` |
| `E3. Clickable variable picker and upstream sample preview` | Derive available `{{trigger.*}}` and upstream `{{steps.<id>.output.*}}` paths from ancestor walk and show them as click-to-insert chips in the step inspector alongside the upstream step's latest sample output. | `apps/web/src/lib/editor.ts`, `apps/web/src/SchemaForm.tsx`, `apps/web/src/Editor.tsx` |
| `E4. Switch, per-step error policy, transform, and loop` | Add multi-way `switch` branching (N branches for AI labels), per-step error handling (`T3`: stop, skip and carry on, or `failed` edge), deterministic `transform` formatting (dates, PHP currency, phone, split), and `for_each` / `N30` batched Sheets row appends. | `packages/engine/src/definition.ts`, `packages/engine/src/state-machine.ts`, `apps/worker/src/steps/`, `apps/web/src/FlowCanvas.tsx` |

## Triggers and app expansion (`G1` to `G6`)

Build Tier 1 (`G1` to `G3`) before any third-party partner-gated channels, and build `G6` only when a pilot or customer specifically requests that channel and accepts its API/approval constraints.

| Phase | Scope | Approval and risk notes |
|---|---|---|
| `G1. Daloy internal triggers and sub-workflows` | Native `booking_event` (`created`, `rescheduled`, `cancelled`), `payment_event` (`confirmed`, `expired`), and reusable `sub_workflow` triggers/steps with recursion depth and cycle guards. | Zero third-party OAuth approvals; reuses internal state transitions and `run_keys` dedup. |
| `G2. Google Workspace Tier 1 triggers` | `sheets_row` (new or updated row, also covering Google Forms responses), `calendar_event` (new, changed, or starting soon), and `drive_file` (new file in picked folder). | Reuses existing Google OAuth and Picker (`drive.file` scope discipline in `docs/google-scope-submission.md`) with polling cursor state and `run_keys` dedup. |
| `G3. Connected mailbox triggers` | `gmail_message` and `outlook_message` triggers filtered by sender, subject, or folder/label, removing IMAP password setup for OAuth users. | Note: `gmail.readonly` is a Gmail restricted scope requiring Google CASA / restricted-scope verification before public launch; Outlook uses Microsoft Graph mail read permission. |
| `G4. Web monitor, RSS, and team chat triggers` | `page_changed` / RSS trigger (paired with `read_page` snapshots) plus `slack_message`, `teams_message`, and `discord_message` / slash-command triggers. | Reuses existing `read_page` SSRF guard and workspace chat connections. |
| `G5. Record-tool triggers` | `airtable_record`, `notion_page`, and `trello_card` triggers for new items or status changes. | Cursor polling per destination with `run_keys` idempotency. |
| `G6. Demand-gated SMB, resort, and e-commerce triggers` | Facebook/Instagram post comments and Lead Ads; WooCommerce, Shopee, Lazada, and TikTok Shop order triggers; Airbnb / Booking.com iCal sync (or Calendly / Cal.com); Xendit, Maya, and Stripe payments; Google Forms, Tally, and Typeform webhooks. | Gated strictly on real pilot demand plus vendor app review, webhook verification, and fee review. |

## Guardrails

- Claim one phase at a time in `PROJECT.md`, use a separate branch and git worktree, and follow tests-first (`pnpm lint`, `pnpm typecheck`, `pnpm test`, targeted `pnpm e2e`).
- Every new polling or webhook trigger must use `run_keys` idempotency, strict Zod payload schemas, and explicit secrets redaction.
- Never alter `Onboarding` or reset/wipe the owner's local `pgdata` volume.
