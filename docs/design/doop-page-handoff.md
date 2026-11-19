# Daloy page-by-page redesign handoff

Updated 20 November 2026, Manila. Planning baseline: `design/paper-redesign` at `14f457d`. This ledger covers the Doop round. The [earlier console redesign ledger](console-redesign-phases.md) records a separate round and its test results.

## Start here

**Next task: B1, Build with AI / Describe.** B1, B2, A1 and A7 have design approval. In Doop, Ready for dev means the owner approved that frame. Implementation and verification are open for every row in this ledger. For the other rows, compare the current page to the shared Daloy design and record whether it needs a new frame, a targeted change, or only verification. The sequence below is a proposed delivery order.

| Owner decision | Reference |
| --- | --- |
| Use the Invoice Follow-up conversation for Describe. Keep the Grok mark, user messages, clarifying reply, composer and plan summary. | [Approved Describe frame](https://doop.design/c/xH-4xV7kGK?frame=ZK4SH9Ws7_) |
| Use the Invoice Follow-up table for Review Plan. Show the trigger, actions, apps, outputs and a worked example. | [Approved Review Plan frame](https://doop.design/c/xH-4xV7kGK?frame=VjdlOnnwzU) |
| Website Inquiries is a draft exploration. Its inbox and branching map have no implementation sign-off. | [Worksheet](https://doop.design/c/xH-4xV7kGK?frame=NZdFLgm73I) and [branch map](https://doop.design/c/xH-4xV7kGK?frame=MQ7XzYIBto) |
| A1. Automations / All automations, `#/`. Use the approved ops table on the Automations canvas page. | [Approved ops table](https://doop.design/c/xH-4xV7kGK?page=QQiGt3KTBw&frame=oInO4nM4FW) |
| A7. Automations / Steps, `#/w/:id`. Use the approved editor on the Workflow editor canvas page. | [Approved workflow editor](https://doop.design/c/xH-4xV7kGK?page=nujtceBnVw&frame=M1AcdA6NJH) |

The invoice conversation and sample run are prototype fixtures. Bind the UI to the current builder, configured model, draft definition and connection states. The Grok mark is a visual choice. Model selection still belongs to Advanced / AI model. Describe and Review are states of the owner-only `#/ai` route. App connections belong under **Apps**. A trigger mailbox, selected steps, run history and versions belong to an individual **automation**.

## How to run a phase

Pick one row per chat. Check the current target branch, working tree, `AGENTS.md`, the parent `CLAUDE.md` when present, `PROJECT.md` claims and the current Doop approval before edits. Plan the named page and wait for the owner's go under the repository rules. These IDs are design work packages. Keep project-roadmap claims separate. Recheck `App.tsx`, `Nav.tsx` and the relevant file on the implementation base because the planning worktree and local main have diverged. Web source filenames below are relative to `apps/web/src/`.

For each changed page, verify its row's action with synthetic data, desktop and phone layouts, keyboard focus, supported languages, theme and applicable roles. Capture an empty, failure or recovery state where the page has one. Keep provider checks on disposable fixtures. Preserve working URLs and back navigation. Record exactly what ran and what remains. The old ledger's test results belong to its own commits.

## Phase 1. Build with AI

| ID | Page and owner tab | Entry and files | Completion check |
| --- | --- | --- | --- |
| B1 | Build with AI / Describe | `#/ai`, `BuildWithAi.tsx`, `lib/ai-chat.ts`, `creation.css` | From a fresh conversation, enter a goal, answer a clarifying question and reach Review. Cover pending, restart, unavailable model, quota and template fallback. Use the approved chat layout. |
| B2 | Build with AI / Review Plan | Summary state in `#/ai`, `BuildWithAi.tsx`, `AiFlow.tsx`, `AiDraft.tsx` | Render the approved table from a generated draft. Show warnings and app connection states. Return to refine, open Apps for a missing connection, and save the draft to its editor. Keep existing activation, permission and failure handling distinct from saving. Check an invoice plan and a plan with branches. |

Start verification with `e2e/build-with-ai.spec.ts` and `e2e/ai-draft.spec.ts`. Compare desktop screenshots with both approved frames. Check that changing the workflow changes the table contents. Doop approval covers the layout, not new engine capabilities such as reading and grouping arbitrary spreadsheet rows.

## Phase 2. Console shell and Automations

| ID | Page and owner tab | Entry and files | Completion check |
| --- | --- | --- | --- |
| A0 | Shared console navigation | `Nav.tsx`, `App.tsx`, `console-shell.css` | Current location, phone menu, back, account and sign-out work for owner and operator. Restricted roles land in their own request area. |
| A1 | Automations / All automations. [Approved ops table](https://doop.design/c/xH-4xV7kGK?page=QQiGt3KTBw&frame=oInO4nM4FW) | `#/`, `Automations.tsx` | Filter, select an automation and open the correct next action. Counts reflect real state. Check empty, failed load, paused and needs-attention states. |
| A2 | New automation / Template chooser | `#/new`, `NewAutomation.tsx` | Start from a template, guided setup, blank editor or Build with AI as supported. Repeated clicks create one intended draft. |
| A3 | Automations / Office-request preview | `#/try/office-request`, `TryOfficeRequest` in `OfficeRequests.tsx` | Submit a sample and inspect projected messages and records. Preview causes no live sends. |
| A4 | Automations / Office-request setup | `#/a/:id`, `SetupWizard`, `GuidedSteps.tsx` | Complete, save, leave and resume at the correct step. Review recipients and optional connections before activation. |
| A5 | Automations / Purchase-request setup | `#/a/:id`, `PurchaseWizard` | Select an eligible approver, check purchasing and optional Teams delivery, and resume the same draft after leaving. |
| A6 | Automations / Live overview and requests | `#/a/:id`, `LivePage` | Open or copy the public form, inspect request and delivery status, and navigate to this automation's Activity and Steps. |
| A7 | Automations / Steps editor. [Approved workflow editor](https://doop.design/c/xH-4xV7kGK?page=nujtceBnVw&frame=M1AcdA6NJH) | `#/w/:id`, `Editor.tsx`, `FlowCanvas.tsx`, `SchemaForm.tsx`, `EmailSource.tsx` | Edit trigger, steps, branches and email intake for this workflow. Exercise the accessible list, mocked test run, save and publish on a disposable workflow. |
| A8 | Automations / Activity | `#/w/:id/runs`, `Runs.tsx` | Only this workflow's runs appear. Opening a run and going back preserves the workflow context. |
| A9 | Automations / Versions | `#/w/:id/versions`, `Versions.tsx` | Compare two versions, distinguish draft from published, and check rollback creates a new version in a fixture. |

## Phase 3. Activity and Bookings

| ID | Page and owner tab | Entry and files | Completion check |
| --- | --- | --- | --- |
| O1 | Activity / Workspace activity | `#/activity`, `Runs.tsx` | Find runs across automations, filter by status and open the correct detail. Verify CSV export where offered and role access. |
| O2 | Activity / Run detail | `#/runs/:id`, `RunPage` in `Runs.tsx` | Inspect timing, masked payloads, approvals and delivery status. Check recovery controls against the actual run state. |
| O3 | Activity / Ask about a request | `#/runs/:id/ask`, `AskRequest.tsx` | Open a permitted explanation, inspect failure/unavailable states, and verify the feature flag, role and quota behavior. |
| O4 | Bookings / Booking list | `#/bookings`, `Bookings.tsx` | Find a booking, move, cancel or mark a past booking as a no-show, and check export using disposable bookings. |

## Phase 4. Apps tab

The directory and all twelve provider panels share `#/apps`. A panel is selected in `Apps.tsx`; a provider name below does not introduce a route. Begin with P0, then take one panel at a time. Verify connect, manage, failure, reconnect and disconnect states where the provider supports them. Exercise real UI paths against the fake provider.

| ID | Page or Apps panel | Main file | Distinct acceptance check |
| --- | --- | --- | --- |
| P0 | Apps directory | `Apps.tsx` | Search All and Connected, open the intended provider, inspect an empty result, and follow the email-intake link into Automations. |
| P1 | Gmail | `BusinessSetup.tsx`, `GmailCard` | Owner can distinguish account connection, sender verification and test-email outcomes. |
| P2 | Outlook | `Connections.tsx` | Preserve consent returns, including the legacy Outlook URL, and show administrator-required or declined outcomes. |
| P3 | Google Sheets | `GoogleConnect.tsx`, `Connections.tsx` | Choose the spreadsheet and tab, save the destination and check the test-row result. |
| P4 | Slack | `Connections.tsx`, `ConnectPanel.tsx` | Select a channel, send a fake test message and recover from a revoked connection. |
| P5 | Microsoft Teams | `Connections.tsx`, `PasteSetups.tsx` | Replace the workflow link without revealing it and accurately label the test result. |
| P6 | Telegram | `Connections.tsx`, `PasteSetups.tsx` | Walk through bot and chat setup and show a useful invalid-token or unknown-chat result. |
| P7 | Google Calendar | `GoogleCalendar.tsx` | Select the target calendar and verify a denied grant or unavailable calendar is recoverable. |
| P8 | Google Drive | `GoogleConnect.tsx`, `Connections.tsx` | Choose and verify the destination folder for form uploads. |
| P9 | PayMongo | `Connections.tsx`, `PasteSetups.tsx` | Clearly distinguish test credentials, webhook setup and payment status. Keep keys masked. |
| P10 | Airtable | `Connections.tsx`, `RecordTargetPicker.tsx` | Select the base and table and verify a test record against the fake provider. |
| P11 | Notion | Same record connection and picker | Select an accessible database, verify the sample-page result and cover missing access. |
| P12 | Trello | Same record connection and picker | Select a board and list, then verify the sample card destination. |
| P13 | Consent return | `#/apps/:slug-:outcome`, legacy `#/settings/business/outlook-:outcome`, `App.tsx`, `Apps.tsx` | Return to the matching panel. Cover success, refusal, expired/unknown flow and shared grants. |
| P14 | Verify Gmail sender | `#/verify-sender/:token`, `VerifySenderPage` | The confirmation action distinguishes valid, expired and already-used links without exposing the token. |

## Phase 5. Workspace, account and Advanced

| ID | Page and owner tab | Entry and files | Completion check |
| --- | --- | --- | --- |
| W1 | Team / Members and invitations | `#/team`, `Team.tsx` | Invite, change role and remove a fixture member with the proper role restrictions. |
| W2 | Business / Profile, brand and inquiry form | `#/settings/business`, `BusinessSetup.tsx`, `FormEmbed.tsx` | Save a profile, inspect logo and accent defaults, and copy or open the correct inquiry form. Sender setup links back to Apps where appropriate. |
| W3 | Settings / Preferences and usage | `#/settings`, `AppSettings.tsx` | Verify language, theme, plan/usage and role-specific links after reload. |
| W4 | Account / Change password | `#/account`, `Account.tsx` | Validate current password, confirm success and preserve the return path for staff and requesters. |
| W5 | Advanced / Directory | `#/advanced`, `Advanced.tsx` | Owner can reach the existing tools with the correct labels and return to the menu. |
| W6 | Advanced / AI model | `#/settings/ai`, `Settings.tsx` | Save or test the configured model against a fake and show a useful failure. Keep stored credentials masked. |
| W7 | Advanced / Resources | `#/resources`, `Resources.tsx` | Manage booking resources and distinguish active and inactive entries. |
| W8 | Advanced / API tokens | `#/tokens`, `Tokens.tsx` | Create a scoped, expiring synthetic token, show it once, then revoke it. |
| W9 | Advanced / Secrets | `#/secrets`, `Secrets.tsx` | Add, replace and remove a synthetic secret. Existing values never appear in the UI. |

## Phase 6. Entry, restricted roles and public pages

| ID | Surface | Entry and files | Completion check |
| --- | --- | --- | --- |
| E1 | Sign in | Signed-out console, `App.tsx` | Sign in, recover from bad credentials and retain the destination of a named approval. |
| E2 | Registration | Sign-in page, register mode | Validate the password requirements and show success and existing-account errors. |
| E3 | Forgot password | `#/forgot-password`, `Account.tsx` | Request a recovery email with the existing account-enumeration protections. |
| E4 | Reset password | `#/reset-password/:token`, `Account.tsx` | Cover valid, expired and reused links, plus return to sign-in. |
| E5 | Accept invitation | `#/invite/:token`, `Team.tsx` | Accept a fixture invitation and land in the correct role. Cover invalid and used links. |
| E6 | My requests | Approver/requester landing, `Team.tsx` | Show the signed-in person's requests and allowed actions. Check empty state, account and sign-out. |
| E7 | Public form and receipt | `/forms/:id`, `apps/api/src/public.ts` | Submit a branded form, inspect validation and receipt, and verify paused, upload and duplicate-submission states. |
| E8 | Embedded public form | `/forms/:id/embed`, `FormEmbed.tsx` and public renderer | Embed at phone width and verify validation, submission and resulting confirmation. |
| E9 | Public booking form | Booking-enabled `/forms/:id`, public renderer | Select a resource and available booking time and recover when the slot is unavailable. |
| E10 | Approval landing and decision | `#/answer/:token` to `/approvals/:token`, `App.tsx`, `apps/api/src/approvals.ts` | Verify signed-in handoff, named approver, approve/reject, expiry and already-decided states. |
| E11 | Browser demo | `apps/web/demo/index.html`, `apps/web/src/demo/Demo.tsx` | Walk the synthetic demo through its stages and restart. Keep the public demo separate from workspace data. |

## Phase 7. Walkthrough and continuation

Q1 covers the integrated journey. Start at Automations, enter Build with AI, describe, review, resolve an app requirement, return, save, open Steps and inspect Activity. Exercise phone navigation, English and Tagalog, both themes and all four roles. Verify non-React public pages separately. Use the [previous offline walkthrough](console-review.html) for historical comparison. Record new screenshots and tests against the actual implementation commit before reporting this round complete. The owner reviews the walkthrough before Docker rollout.

**Checkpoint to copy into the next chat**

> Open `docs/design/doop-page-handoff.md` on `design/paper-redesign`. Read the latest checkpoint and work on its next row only. Verify live Doop approval for B1, B2, A1 and A7, then read the listed files and the current routing code. Follow AGENTS.md to plan, coordinate and verify the phase. Record the outcome below before handing off.

| Date | Status and evidence | Next row |
| --- | --- | --- |
| 2026-11-20 | Inventory checked at `14f457d`. Verified four Ready for dev frames: B1 and B2 on Build with AI, A1 on Automations, and A7 on Workflow editor. The two Website Inquiries explorations remain drafts. All implementation rows are open. No runtime tests were run for this planning handoff. | B1 |

After each row, append the date, row ID, design/implementation status, frame link, branch and commit, checks actually run, open issues and next row. A future session can resume from the last entry without this chat.
