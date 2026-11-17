# Console navigation and the AI tab: plan

Status: approved by the owner on 17 November 2026, every part as written, with the Apps page added at the owner's request. Nothing here is built yet; the work is N4d, N4e and N4f in `PROJECT.md`, and the decision is [0036](decisions/0036-reference-n8n.md).

How this was made: a walkthrough of the running console on localhost:3000 as the seeded demo account (`demo@daloy.local`), at 1280 px and 375 px: sign in, find an automation, start one from a template, open a failed run, find where a request went. Nothing was saved. "Set up for my office" creates a draft on click, so an existing draft's setup was opened instead and Next was not pressed. n8n was studied from docs.n8n.io only.

## 1. Walkthrough findings, most blocking first

1. Creating an automation is hard to find. "Add an automation" sits below every card: 5,238 px down on a phone (six and a half screens) and below 24 cards on desktop. The blank workflow, three more templates and Build with AI exist only under Advanced. The demo workspace has six identical "Office requests" drafts and Home has no way to delete one. (Correction found while planning N4d: they date from 13 November, before N4a made "Set up" reopen the newest draft, so a second click no longer makes another.) ([home, desktop](screenshots/nav-plan/home-desktop.jpg), [home, phone](screenshots/nav-plan/home-phone.jpg), [Advanced](screenshots/nav-plan/advanced-desktop.jpg))
2. The Activity and Requests tables are broken on desktop. At 1280 px the column headings sit in one column and the rows in another. Cause: `.cards` (`apps/web/src/styles.css:205` and `:306`, the two-column card grid) also matches `table.cards`. A one-selector fix. It does not show at 375 px. ([Activity](screenshots/nav-plan/activity-table-desktop.jpg), [Requests](screenshots/nav-plan/requests-table-desktop.jpg))
3. "Where did my request go" has two homes. The request list is on the guided automation page (the card title), the runs are on Activity (a separate link), and there is no search by reference across automations. Automations built in the editor have no request list at all.
4. One thing, several names. The menu says Automations, the breadcrumb says Home; the card says Activity, the editor says Runs; Home says automation, Advanced says workflow. The editor's breadcrumb says Advanced even when opened from Automations, and the automation page has its own "Advanced" box next to the menu's Advanced. ([editor](screenshots/nav-plan/editor-desktop.jpg))
5. A failed run explains itself in technical words: "step acknowledge:", "with the same request key, so a receiver that checks it does not act twice", `{{trigger.email}}` in Path it took. The fix ("Connect Gmail in Settings, Business and email") is text with no link, and the menu has no "Settings". ([failed run](screenshots/nav-plan/failed-run-desktop.jpg))
6. The list cannot be narrowed. No search, no filter by state, no sort; a Problem card can sit 11th of 24. Every card has a disabled "Pause (coming)" button.
7. Phone menu: it pushes the page down instead of covering it, and stays open after the browser's back button. ([menu](screenshots/nav-plan/menu-phone.jpg), [editor, phone](screenshots/nav-plan/editor-phone.jpg))
8. Sign-in says "Build workflows from a trigger and a series of steps", which is developer wording.

What worked: the setup wizard (Step 1 of 4, Save and finish later), the run page's Retry and Path it took, and request cards on a phone.

## 2. What to take from n8n, and what not

Studied from its public docs only. n8n is under the Sustainable Use License, so no code, icons, feature names or assets are copied.

Borrow:

- One create button that is always visible, at the top of the menu and of the list.
- An all-executions list across workflows, filtered by status (failed, running, success, waiting) and time.
- On each workflow, a switch between the editor and that workflow's executions.
- Retry from a failed run.
- The AI builder pattern: describe in plain words, review the needed connections and settings, refine with follow-up messages. n8n charges one credit per message that creates or changes a workflow, does not charge failed requests, and has a monthly limit.

Leave out:

- Credentials, projects, variables and the node palette as menu items. Daloy shows connections as Apps.
- Expressions, pinned data, code steps and custom execution data.
- Canvas-first editing. n8n's docs say nothing about phones; Daloy owners work on phones, so the phone shows a step list and the diagram stays a desktop view.
- Sending real data values to the model (n8n's builder needs that setting on).

## 3. Proposed menu and pages

Desktop, left menu (owner):

```
[ + New automation ]
Automations
Activity
Build with AI
Bookings
---------------
Apps
Business
Team
Advanced
Settings
---------------
demo@daloy.local
Sign out
```

Phone: a bottom bar with four places, and the create button in the top bar.

```
| Daloy                 [+ New] |
|                                |
|          page content          |
|                                |
| Automations  Activity  AI  More|
```

More opens a sheet with Bookings, Apps, Business, Team, Advanced and Sign out. Operators see Automations, Activity and Bookings; approvers and requesters keep My requests.

Pages:

- Automations: New automation button, search box, filter chips (All, Needs you, Problem, Waiting, Off, Drafts). Needs you and Problem sort first. Drafts fold into one "Drafts (n)" group with Delete (`DELETE /workflows/:id` exists). "Pause (coming)" is removed until pause exists (N11).
- New automation (`#/new`): one page with every template (the three guided ones and the three builder templates), "Describe it to the AI" (goes to Build with AI) and "Blank, for a technician".
- Automation page: one page for guided and editor-built automations, with tabs Overview (state, form link, requests), Activity and Steps (diagram on desktop, list on phone). Versions and technician details sit under More. The breadcrumb is always Automations.
- Activity (`#/activity`): every run across automations, filter by state, search by request reference or automation name. `GET /runs` already lists across the workspace; reference search needs one query parameter.
- Apps (`#/apps`, replaces Business and email; added at the owner's request on 17 November 2026): All and Connected tabs with counts, a search box, a Connected section on top and a More section below, two cards per row on desktop and one on a phone. Each card has the app's logo, its name, one plain line on what Daloy does with it, and Connect (or, once connected, its state and Manage). The cards are only the apps Daloy supports today: Gmail, Outlook, Google Sheets, Slack and Microsoft Teams. Planned ones (SMS, email-in) appear only when they work. Connect opens the existing setup for that app (the Gmail app password steps, Outlook consent, the Sheets key, the Slack token, the Teams link) in a panel, so no setup logic changes. The Outlook consent callback (`#/settings/business/outlook-<outcome>`) keeps working through a redirect to Apps. As built in N4e, each card shows a letter tile and the app's name: Microsoft, Slack and Google allow their names in text but their logos only with written permission, and [app-logo-permissions.md](app-logo-permissions.md) lists how to ask each of them. The layout pattern is common to app directories; nothing is copied from any one product.
- Business (`#/settings/business`): "Your business" (name, website, inquiry inbox) moves here from Business and email. As built in N4e, "Reply to website inquiries" stays on Business next to the details it needs, and New automation links to it.
- Run page: the error in plain words with a button to the page that fixes it (for example "Connect Gmail" to Apps). Step ids, keys and templates stay under Details for a technician.
- Words: automation everywhere in the console, Activity for runs, Automations in every breadcrumb. Sign-in line: "Automate the routine work of your office."

## 4. The AI tab (Build with AI)

Where: a main menu item for owners, the "Describe it to the AI" choice on New automation, and the existing "Ask the AI" panel in the editor for changes. The Build with AI box under Advanced moves here.

Flow:

1. "What should happen?" One text box with three example chips.
2. Up to four questions, one at a time, each answered by tapping a choice or "Other":
   - What starts it? Someone fills a form / A booking is made / Another system sends a web request / On a schedule.
   - Who should know or decide? Me / A team member (picked from Team) / The person who filled the form / No one.
   - Where should it go? Email / Google Sheet / Slack / Outlook or Teams (only connected ones are offered) / Only Daloy's request list.
   - Should anyone approve it first? No / Yes, the person named above.

   The questions are fixed and shown by the page, so asking them costs no model call and works without a model.
3. The page joins the description and answers into the `request` text and calls the existing `POST /ai/draft` (prompt, one lint repair round and `warnings` already exist in `apps/api/src/ai-draft.ts`). "Change something" uses its existing `current` field.
4. Review: the draft as plain sentences ("When someone fills the form, Daloy will: 1. email you ... 2. ..."), the lint warnings as "Check before turning on", and the connections it needs. Buttons: Save as draft, Change something, Start over.

What the owner approves before anything saves: nothing is written until Save as draft. Today `AiDraft.tsx` creates the workflow as soon as the draft comes back; the tab keeps the draft in the page until Save. Save makes an unpublished version. Turning it on stays a separate step on the automation page, after a Mock test run that sends nothing (P3).

What never goes to the model: form submissions, request text, run history, booking details, customer names or addresses, secrets and connection credentials, the business profile, and team members' email addresses. The model gets the owner's description, the tapped answers, the step types and which providers are connected. People are sent as labels ("the owner", "approver 1") and the page puts the real addresses into the draft before review. An API test asserts this on the fake model's recorded request.

No model configured, or the draft call fails: the questions still work, and the last screen says the AI is not set up and offers the closest template from the answers (form plus notify the office: Track an office request; approval: Purchase request; website reply: Reply to a website inquiry). Owners get a link to the AI model page; operators get "Ask the owner". No new endpoint is needed. Tests use the fake model already in `apps/api/src/ai-draft.test.ts`; Playwright stubs the draft route.

## 5. Cost before quotas (N6)

Since N3, an account without its own AI settings cannot use the operator's `LLM_API_KEY` unless `SHARED_LLM_KEY=open` (decision 0035). Before N6 the tab spends only the workspace's own model (its own key or a local Ollama), never the operator's money. The questions make no model calls; a draft is at most two calls (the draft and one repair); `RateLimit(10)` per user per minute stays.

Recommendation: build the tab now and show it to owners; keep `SHARED_LLM_KEY` closed on every public or pilot installation until N6 adds a per-workspace AI quota. N6 has since added it: with `open`, the key is used only for a workspace that has a plan (decision 0038). On the locked demo (N5) the tab runs the questions and shows the template suggestion only. The alternative, hiding the tab until N6, delays the feature without saving money, since no operator key is used.

## 6. Proposed PROJECT.md entries

Under N4, the reference line "Reference the Zapier linear editor and the Activepieces builder (MIT), not n8n" becomes "Navigation follows n8n's layout (studied only, decision 0036)", and three phases are added:

- [ ] N4d. Navigation fixes from the walkthrough: the table layout bug, New automation in the menu and at the top of Automations, one New automation page with every template, Drafts group with Delete, search and state filter, Needs you and Problem first, "Pause (coming)" removed, one set of words, run errors that link to the fix. Exit: Playwright starts an automation from the top button and filters to Problem; the earlier N4 exit check passes on a phone.
- [ ] N4e. Structure: Activity across all automations with state filter and reference search, one automation page with Overview, Activity and Steps tabs, phone bottom bar, Apps page with logo cards replacing Business and email. Exit: from Home, a person not coached finds where request REQ-x went in three taps on a phone; Playwright covers it.
- [ ] N4f. Build with AI tab as in section 4. Exit: Playwright with a stubbed model answers the questions, sees the plain review and warnings, and finds nothing saved until Save as draft; with no model the template suggestion appears; an API test shows the model request holds no form text, run data or member address.

Order: N4d first (it fixes a visible bug, and W's screenshots show the console), then N4e, then N4f, all before N5 so the demo shows the new console. W can run alongside. N6 is unchanged. N10b becomes "extend the Build with AI tab to answer what happened to request X", still after N6.

## 7. Decision record draft: 0036 Reference n8n for console navigation

Context: N4 named Zapier and Activepieces as references. After N4 and V2 the owner still finds the console hard to navigate and asked for n8n's feel.

Options: keep Zapier and Activepieces; follow n8n's layout; design without a reference.

Decision: follow n8n's navigation layout (a create button always visible, one list across all runs, a per-automation switch between steps and activity, an AI builder whose draft is reviewed before saving). n8n is under the Sustainable Use License, so its public docs and screens are studied only and no code, icons, text or assets are copied. Daloy keeps its own words, a phone-first layout and its own components.

Consequences: N4d to N4f replace the Zapier and Activepieces reference. Canvas-first editing, credentials and projects are not adopted. The AI tab follows Daloy's data rules, which are stricter than n8n's builder.
