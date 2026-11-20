# Daloy page-by-page redesign handoff

Updated 20 November 2026, Manila. Planning baseline: `design/paper-redesign` at `14f457d`. This ledger covers the Doop round. The [earlier console redesign ledger](console-redesign-phases.md) records a separate round and its test results.

## Start here

**Next task: A0, shared console navigation.** B1, B2, A1 and A7 have design approval. In Doop, Ready for dev means the owner approved that frame. B1 and B2 are implemented on the design branch. For the other rows, compare the current page to the shared Daloy design and record whether it needs a new frame, a targeted change, or only verification. The sequence below is a proposed delivery order.

| Owner decision | Reference |
| --- | --- |
| Use the Invoice Follow-up conversation for Describe. Keep the Grok mark, user messages, clarifying reply, composer and plan summary. | [Approved Describe frame](https://doop.design/c/xH-4xV7kGK?frame=ZK4SH9Ws7_) |
| Use the Invoice Follow-up table for Review Plan. Show the trigger, actions, apps, outputs and a worked example. | [Approved Review Plan frame](https://doop.design/c/xH-4xV7kGK?frame=VjdlOnnwzU) |
| Website Inquiries is a draft exploration. Its inbox and branching map have no implementation sign-off. | [Worksheet](https://doop.design/c/xH-4xV7kGK?frame=NZdFLgm73I) and [branch map](https://doop.design/c/xH-4xV7kGK?frame=MQ7XzYIBto) |
| A1. Automations / All automations, `#/`. Use the approved ops table on the Automations canvas page. | [Approved ops table](https://doop.design/c/xH-4xV7kGK?page=QQiGt3KTBw&frame=oInO4nM4FW) |
| A7. Automations / Steps, `#/w/:id`. Use the approved editor on the Workflow editor canvas page. | [Approved workflow editor](https://doop.design/c/xH-4xV7kGK?page=nujtceBnVw&frame=M1AcdA6NJH) |

The invoice conversation and sample run are prototype fixtures. Bind the UI to the current builder, configured model, draft definition and connection states. The Grok mark is a visual choice. Model selection still belongs to Advanced / AI model. Describe and Review are states of the owner-only `#/ai` route. App connections belong under **Apps**. A trigger mailbox, selected steps, run history and versions belong to an individual **automation**.

## Design source of truth and motion

Build from the approved Doop frames. Where an approved frame and `DESIGN.md` differ, the frame wins: the Inter font, the near-black ink and text, the neutral grey page background, the cards, and the desktop navigation (the dark 64px rail that expands on hover). Take colours, sizes and radii from the Doop canvas tokens (`--daloy-*`, read with the Doop `get_tokens` tool for canvas xH-4xV7kGK). The brand-kit tokens `--brand-sample-*` and `--brand-alt-*` are sample businesses only; on public pages use the workspace's own accent and logo. Keep `DESIGN.md` for what a still frame cannot show: the motion tokens, the run animation, reduced motion and the contrast rules.

Motion for the parts added in the Doop round, using the `DESIGN.md` tokens `--ease`, `--dur-fast` and `--dur-base`:

| Part | Motion |
| --- | --- |
| Rail expand (A0 update) | Opens after a 150ms hover delay, or at once on keyboard focus. The width grows from 64px to 232px over `--dur-base` with `--ease` and the page column moves with it. Labels fade in over the second half. It closes the same way on pointer leave or Escape. |
| Apps setup panel (P1 to P14) | The panel content fades in and rises 8px over `--dur-base`. The app list beside it does not move. |
| Phone bottom sheets | The sheet rises from the bottom over `--dur-base` while the dimmed backdrop fades in. Closing reverses it. |
| Dialogs | Fade in and scale from 0.98 to 1 over `--dur-base`. |
| Saved, Copied and test results | The message fades in over `--dur-fast`, is announced with `role="status"` and stays until the next action. It does not slide or bounce. |
| Status labels | A label that changes state changes colour over `--dur-fast`. Only the existing Working node pulses. |

Under `prefers-reduced-motion: reduce` all of these take 0s, as `DESIGN.md` already says. The rail still opens and closes; it only stops animating.

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

**Owner selections, 20 November 2026.** One option per page is Ready for dev in Doop.

| Page | Selected design |
| --- | --- |
| O1. Activity / Workspace activity | Option A, [Run register](https://doop.design/c/xH-4xV7kGK?frame=iIHhpAQIUx) |
| O2. Activity / Run detail | Option A, [Step timeline](https://doop.design/c/xH-4xV7kGK?frame=aquI2X-gdg) |
| O3. Activity / Ask about a request | Option A, [Question reader](https://doop.design/c/xH-4xV7kGK?frame=jdE6cTyvay) |
| O4. Bookings / Booking list | Option B, [Day agenda](https://doop.design/c/xH-4xV7kGK?frame=PtNZfoOj94) |

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

**Approved Phase 4 designs, 20 November 2026.** Every frame below is Ready for dev in Doop. On desktop a panel opens beside a narrow app list. On a phone it opens full screen with a back link to Apps. An app with any saved connection, including a failed one, is listed under Connected. The two panel templates and the unused P0 option B remain drafts.

| ID | Desktop, main state | Desktop, failure or recovery | Phone |
| --- | --- | --- | --- |
| P0. Apps directory | [Status list](https://doop.design/c/xH-4xV7kGK?frame=YLXBiloA_n) | None | [Connected search with no match](https://doop.design/c/xH-4xV7kGK?frame=EnxeVPkBaL) |
| P1. Gmail | [Connected and sending](https://doop.design/c/xH-4xV7kGK?frame=M6raw-Fbxh) | [App password rejected](https://doop.design/c/xH-4xV7kGK?frame=7XI9eIjksq) | [Connected](https://doop.design/c/xH-4xV7kGK?frame=o7MkIm2yLs) |
| P2. Outlook | [Connected](https://doop.design/c/xH-4xV7kGK?frame=8pEDeDvK1S) | [Administrator approval needed](https://doop.design/c/xH-4xV7kGK?frame=x-Zz8x_3R1) | [Connected](https://doop.design/c/xH-4xV7kGK?frame=eMk6LHKCcO) |
| P3. Google Sheets | [Destination and test row](https://doop.design/c/xH-4xV7kGK?frame=wph3f1e-ts) | [Test row failed](https://doop.design/c/xH-4xV7kGK?frame=RftPawva0a) | [Destination and test row](https://doop.design/c/xH-4xV7kGK?frame=kVzdSacSDZ) |
| P4. Slack | [Channel and test](https://doop.design/c/xH-4xV7kGK?frame=5XTF9JWD8C) | [Needs reconnecting](https://doop.design/c/xH-4xV7kGK?frame=VfdSNUH7R2) | [Channel and test](https://doop.design/c/xH-4xV7kGK?frame=zTbWtcHyQn) |
| P5. Microsoft Teams | [Link saved](https://doop.design/c/xH-4xV7kGK?frame=GwtqCAfjKX) | [Link failed](https://doop.design/c/xH-4xV7kGK?frame=F9aapBE9kA) | [Link saved](https://doop.design/c/xH-4xV7kGK?frame=iwbciuWQMk) |
| P6. Telegram | [Bot and chat](https://doop.design/c/xH-4xV7kGK?frame=82M6iUd9IQ) | [Invalid token, chat not found](https://doop.design/c/xH-4xV7kGK?frame=ZLP6Moc2e5) | [Bot and chat](https://doop.design/c/xH-4xV7kGK?frame=Hb-s-5wTph) |
| P7. Google Calendar | [Bookings calendar selected](https://doop.design/c/xH-4xV7kGK?frame=Ec-6oPBVgC) | [Permission declined](https://doop.design/c/xH-4xV7kGK?frame=UrVNfVlu6e) | [Bookings calendar selected](https://doop.design/c/xH-4xV7kGK?frame=QUWUYLzHku) |
| P8. Google Drive | [Upload folder chosen](https://doop.design/c/xH-4xV7kGK?frame=SI8XD_kYlr) | [Needs reconnecting](https://doop.design/c/xH-4xV7kGK?frame=GUWAmnw-em) | [Upload folder chosen](https://doop.design/c/xH-4xV7kGK?frame=LPADMRXj7w) |
| P9. PayMongo | [Connected in test mode](https://doop.design/c/xH-4xV7kGK?frame=Va7VX6GkeC) | [Webhook missing](https://doop.design/c/xH-4xV7kGK?frame=N-R2SL78ko) | [Connected in test mode](https://doop.design/c/xH-4xV7kGK?frame=vTwmQBsYiP) |
| P10. Airtable | [Table selected, test verified](https://doop.design/c/xH-4xV7kGK?frame=JBLdPPVJSJ) | [Token rejected](https://doop.design/c/xH-4xV7kGK?frame=lei9_dEMNs) | [Table selected](https://doop.design/c/xH-4xV7kGK?frame=I7-giCjiQX) |
| P11. Notion | [Database selected, test verified](https://doop.design/c/xH-4xV7kGK?frame=roKLz0IUYs) | [No database shared](https://doop.design/c/xH-4xV7kGK?frame=deLI9w6OXJ) | [Database selected](https://doop.design/c/xH-4xV7kGK?frame=l7c1hwhr5j) |
| P12. Trello | [List selected, test verified](https://doop.design/c/xH-4xV7kGK?frame=vS_Xp2kgrC) | [Not connected](https://doop.design/c/xH-4xV7kGK?frame=m5blCCs1mW) | [List selected](https://doop.design/c/xH-4xV7kGK?frame=P0JCbIZa-G) |
| P13. Consent return | [Success](https://doop.design/c/xH-4xV7kGK?frame=vwIIucyQvn) | [Declined](https://doop.design/c/xH-4xV7kGK?frame=EezHouuqa_), [Expired or unknown](https://doop.design/c/xH-4xV7kGK?frame=Z6JeRvSTZ-), [Shared Google sign-in](https://doop.design/c/xH-4xV7kGK?frame=fIJVR8vhlh) | [Success](https://doop.design/c/xH-4xV7kGK?frame=_hCHazxr4e) |
| P14. Verify Gmail sender | [Ready to confirm](https://doop.design/c/xH-4xV7kGK?frame=zdWYOBSgPH) | [Expired link](https://doop.design/c/xH-4xV7kGK?frame=yFbDcNcdNd), [Already used link](https://doop.design/c/xH-4xV7kGK?frame=wNczSIDdw4) | [Ready to confirm](https://doop.design/c/xH-4xV7kGK?frame=tGJM8B_A4L) |

These designs go beyond the current code in a few places. Plan them with the implementation:

- P14 adds a Confirm button. The current page claims the token when it loads, so a mail scanner can use the link first.
- P14 shows expired and already used links separately. The API returns one message for both today.
- Several panels show which automations use an app and when it was last checked. The connection data has `lastTestedAt` but no usage list.
- P13 lists the apps that share one Google sign-in. `conns.shared` holds app keys only.
- The P9 payment status card has no data behind it yet.
- Some error headings are new wording. The code shows the provider's `lastError` text.

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

**Approved Phase 5 designs, 20 November 2026.** Every frame below is Ready for dev in Doop. W1 uses option B on desktop and option A's phone sheet. The other workspace pages follow that shell: the dark rail with the account avatar marked, bordered cards with a pale header strip, and bottom sheets for confirmations on a phone.

| ID | Desktop | Phone |
| --- | --- | --- |
| W1. Team | [Grouped by role](https://doop.design/c/xH-4xV7kGK?frame=7bjgxavlHY) | [Remove a member](https://doop.design/c/xH-4xV7kGK?frame=yfzU8w8KVi) |
| W2. Business | [Profile, logo and inquiry form](https://doop.design/c/xH-4xV7kGK?frame=Ajx1bSldHe), [No brand yet, logo rejected](https://doop.design/c/xH-4xV7kGK?frame=KB6XZWGTMw) | [Profile and form link](https://doop.design/c/xH-4xV7kGK?frame=9vFOuEnkIH) |
| W3. Settings | [Owner view](https://doop.design/c/xH-4xV7kGK?frame=x3A-fJwMpM), [Operator view](https://doop.design/c/xH-4xV7kGK?frame=y8bjjzbxAu) | [Owner view](https://doop.design/c/xH-4xV7kGK?frame=I7ZfgM4eOZ) |
| W4. Account | [Change password](https://doop.design/c/xH-4xV7kGK?frame=lH4X9qcB2B), [Current password is wrong](https://doop.design/c/xH-4xV7kGK?frame=ZaQH-F9-EY), [Password changed](https://doop.design/c/xH-4xV7kGK?frame=5YxvC0dks3) | [Requester with back link](https://doop.design/c/xH-4xV7kGK?frame=b3byDaxpPC) |
| W5. Advanced | [Directory](https://doop.design/c/xH-4xV7kGK?frame=CWk0ay7YjH), [Non-owner fallback](https://doop.design/c/xH-4xV7kGK?frame=KYtxYUafud) | [Directory](https://doop.design/c/xH-4xV7kGK?frame=mpdXAQei3z) |
| W6. AI model | [Saved, test passed](https://doop.design/c/xH-4xV7kGK?frame=NTdSU6RZ9F), [Test failed](https://doop.design/c/xH-4xV7kGK?frame=RR5MWYK8iZ) | [Saved, test passed](https://doop.design/c/xH-4xV7kGK?frame=fkjpQgqdZF) |
| W7. Resources | [Active and archived](https://doop.design/c/xH-4xV7kGK?frame=28iDVdyywt), [Rename a resource](https://doop.design/c/xH-4xV7kGK?frame=ui_7f702WF) | [Active and archived](https://doop.design/c/xH-4xV7kGK?frame=USesnlw7T5) |
| W8. API tokens | [Token list](https://doop.design/c/xH-4xV7kGK?frame=AXLsWhe06b), [New token shown once](https://doop.design/c/xH-4xV7kGK?frame=b6jDd6WDhG) | [Token list](https://doop.design/c/xH-4xV7kGK?frame=QVb6CA2-cB) |
| W9. Secrets | [Secret list](https://doop.design/c/xH-4xV7kGK?frame=ba7D0fgHk-), [Replace a secret](https://doop.design/c/xH-4xV7kGK?frame=THcJmCHB9a), [Delete confirmation](https://doop.design/c/xH-4xV7kGK?frame=z-C5TXL2fk) | [Secret list](https://doop.design/c/xH-4xV7kGK?frame=EnTFjYkruA) |

**A0 update, 20 November 2026.** The desktop rail expands on hover into a 232px column with labels and the full menu from `Nav.tsx` (Work, Build, Workspace, then the account with Account and Sign out). It pushes the page to the right instead of covering it. [Approved frame](https://doop.design/c/xH-4xV7kGK?frame=gDOrJNUuQK). Open it on keyboard focus as well, close it on pointer leave or Escape, and add a short open delay so the page does not jump when the pointer only passes over the rail.

Beyond the current code: dialogs where the code uses `confirm()` or `prompt()` (resource rename, token revoke, secret delete), a Copy button for the new token, counts beside page titles, and the sample plan name and usage on W3.

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

**Approved Phase 6 designs, 20 November 2026.** Every frame below is Ready for dev in Doop. E1 uses option B, the split layout, and E2 to E5 follow it. Public pages (E7 to E10) carry the business brand kit: logo, accent and profile name, never the Daloy brand. Each public page also has a second sample brand and a no-brand version.

| ID | Desktop | Phone |
| --- | --- | --- |
| E1. Sign in | [Split, approval waiting, wrong password](https://doop.design/c/xH-4xV7kGK?frame=G1dk1dFL1u) | [Sign in](https://doop.design/c/xH-4xV7kGK?frame=2eXiWhUFMx) |
| E2. Registration | [Empty form](https://doop.design/c/xH-4xV7kGK?frame=D3VaFGGyyk), [Password too short](https://doop.design/c/xH-4xV7kGK?frame=GAkvveGkeR), [Email already registered](https://doop.design/c/xH-4xV7kGK?frame=m8XchRqOTo) | [Empty form](https://doop.design/c/xH-4xV7kGK?frame=OG-ZDKiIoQ) |
| E3. Forgot password | [Request form](https://doop.design/c/xH-4xV7kGK?frame=CbCsqvxYF3), [Link sent](https://doop.design/c/xH-4xV7kGK?frame=SJmJ8JyTVb) | [Request form](https://doop.design/c/xH-4xV7kGK?frame=a1Qx9j4kVm) |
| E4. Reset password | [Set a new password](https://doop.design/c/xH-4xV7kGK?frame=IqOVqxsswy), [Link expired or used](https://doop.design/c/xH-4xV7kGK?frame=lo-SW81rNR), [Password changed](https://doop.design/c/xH-4xV7kGK?frame=QtaBuvzWl_) | [Set a new password](https://doop.design/c/xH-4xV7kGK?frame=-iBg4S87aZ) |
| E5. Accept invitation | [New person](https://doop.design/c/xH-4xV7kGK?frame=YjGdnlhsRr), [Invalid or used link](https://doop.design/c/xH-4xV7kGK?frame=M-kgOgSIQJ), [Email already has an account](https://doop.design/c/xH-4xV7kGK?frame=xd6O4k405D) | [New person](https://doop.design/c/xH-4xV7kGK?frame=QL3NOkPIH3) |
| E6. My requests | [Requester list](https://doop.design/c/xH-4xV7kGK?frame=GgoY9QuYpL), [Approver variant](https://doop.design/c/xH-4xV7kGK?frame=fI0vKLwxWJ), [Empty](https://doop.design/c/xH-4xV7kGK?frame=LFW80dx56g) | [Requester list](https://doop.design/c/xH-4xV7kGK?frame=YXHsR0XKXq) |
| E7. Public form | [Form](https://doop.design/c/xH-4xV7kGK?frame=APOh0l4BzS), [Validation errors](https://doop.design/c/xH-4xV7kGK?frame=3VWc5SBBJb), [Receipt](https://doop.design/c/xH-4xV7kGK?frame=rVgq6-LV9G), [Paused](https://doop.design/c/xH-4xV7kGK?frame=n0lqJe7pIU), [Second brand](https://doop.design/c/xH-4xV7kGK?frame=z8k36ub6yW), [No brand set](https://doop.design/c/xH-4xV7kGK?frame=_jHuG5dOsG) | [Form](https://doop.design/c/xH-4xV7kGK?frame=67yIIct_g8) |
| E8. Embedded form | [In host page](https://doop.design/c/xH-4xV7kGK?frame=fA3nGcTh7N), [Confirmation](https://doop.design/c/xH-4xV7kGK?frame=qsRzqfXIir), [Second brand](https://doop.design/c/xH-4xV7kGK?frame=wppAnKwcXU), [No brand set](https://doop.design/c/xH-4xV7kGK?frame=yjWWkzlBMg) | [In host page](https://doop.design/c/xH-4xV7kGK?frame=7eP6v3Z9Ze) |
| E9. Booking form | [Choose resource and time](https://doop.design/c/xH-4xV7kGK?frame=oeCtvge9o9), [Time no longer available](https://doop.design/c/xH-4xV7kGK?frame=rtw6EaGxyf), [Second brand](https://doop.design/c/xH-4xV7kGK?frame=kGS_cUnn8Z), [No brand set](https://doop.design/c/xH-4xV7kGK?frame=wDApswQSpQ) | [Choose resource and time](https://doop.design/c/xH-4xV7kGK?frame=5HDeEuOYuO) |
| E10. Approval | [Decision](https://doop.design/c/xH-4xV7kGK?frame=IpTkhV7dCm), [Assigned to someone else](https://doop.design/c/xH-4xV7kGK?frame=J-XKSxE5Qh), [Link not valid](https://doop.design/c/xH-4xV7kGK?frame=r0lLub-pSN), [Sign in required](https://doop.design/c/xH-4xV7kGK?frame=jsVsnQboJI), [Answer recorded](https://doop.design/c/xH-4xV7kGK?frame=OOhvrW6YGN), [Branded decision](https://doop.design/c/xH-4xV7kGK?frame=T4vwqK9vnk), [Branded answer recorded](https://doop.design/c/xH-4xV7kGK?frame=roPgujk1Ls) | [Decision](https://doop.design/c/xH-4xV7kGK?frame=3_5sqLnXuX) |
| E11. Browser demo | [1 Ask](https://doop.design/c/xH-4xV7kGK?frame=oNFvzNFZUI), [2 Question](https://doop.design/c/xH-4xV7kGK?frame=B7Nc9PbVqs), [3 Check the draft](https://doop.design/c/xH-4xV7kGK?frame=dFvw6A5kac), [4 Test run waiting](https://doop.design/c/xH-4xV7kGK?frame=ESR_bHeKYr), [5 Finished](https://doop.design/c/xH-4xV7kGK?frame=5jkj4ULqqH) | [1 Ask](https://doop.design/c/xH-4xV7kGK?frame=LA1V0D9Hic) |

Beyond the current code: a rendered validation page for E7 (today the error is JSON), open-time choices and a slot-taken page for E9, the card layout on E10 and a branded E10 that needs `approvals.ts` to pass the workspace brand to `page()`, the approval-waiting note on E1, and friendly labels for the raw run states on E6. The E2 short-password message is assumed and needs checking against the server's validation text.

## Phase 7. Walkthrough and continuation

Q1 covers the integrated journey. Start at Automations, enter Build with AI, describe, review, resolve an app requirement, return, save, open Steps and inspect Activity. Exercise phone navigation, English and Tagalog, both themes and all four roles. Verify non-React public pages separately. Use the [previous offline walkthrough](console-review.html) for historical comparison. Record new screenshots and tests against the actual implementation commit before reporting this round complete. The owner reviews the walkthrough before Docker rollout.

**Checkpoint to copy into the next chat**

> Open `docs/design/doop-page-handoff.md` on `design/paper-redesign`. Read the latest checkpoint and work on its next row only. Verify live Doop approval for B1, B2, A1 and A7, then read the listed files and the current routing code. Follow AGENTS.md to plan, coordinate and verify the phase. Record the outcome below before handing off.

| Date | Status and evidence | Next row |
| --- | --- | --- |
| 2026-11-20 | Inventory checked at `14f457d`. Verified four Ready for dev frames: B1 and B2 on Build with AI, A1 on Automations, and A7 on Workflow editor. The two Website Inquiries explorations remain drafts. All implementation rows are open. No runtime tests were run for this planning handoff. | B1 |

| 2026-11-20 | B1 and B2 implemented. The table follows graph edges and labels branches. 31 focused unit checks and nine builder browser tests passed with fake providers. | A0 |

| 2026-11-20 | Doop design checkpoint. Phase 3 selections: O1 option A, O2 option A, O3 option A, O4 option B. Phase 4 Apps approved: P0 option A and 45 panel frames for P1 to P14, all Ready for dev. Design only. No code changed and no tests were run. | Phase 5, W1 Team |

| 2026-11-20 | Doop design checkpoint. Phases 5 and 6 approved: W1 to W9, E1 to E11 including the brand-kit frames, and the hover-expanding rail (A0 update). Design only. No code changed and no tests were run. | Phase 7, walkthrough |

After each row, append the date, row ID, design/implementation status, frame link, branch and commit, checks actually run, open issues and next row. A future session can resume from the last entry without this chat.

20 November 2026. A0 is implemented locally on `design/doop-a0` at `2bd7927`, based on `def5280`. See the [desktop rail](https://doop.design/c/xH-4xV7kGK?frame=gDOrJNUuQK) and [phone menu](https://doop.design/c/xH-4xV7kGK?frame=FTr3sdPWhr). Lint, typecheck and 15 Chromium cases passed across navigation, Build with AI, language and team. Docker Desktop's Linux engine was unavailable. CI and owner integration are pending. Next is A1. Its existing uncommitted edits are in the separate design worktree.

### Reproduce the Apps and Business walkthrough

Build the console with `pnpm --filter @daloy/web build`. Run `DALOY_REVIEW=apps pnpm --filter @daloy/api exec tsx --tsconfig ../../tsconfig.json ../../scripts/console-review/capture.mjs` from the repository root. The capture opens the built application with local fixtures, checks overflow at 390 and 1440 pixels in English and Tagalog, then reopens every image offline. The output is `test-results/console-review/console-review.html`.
