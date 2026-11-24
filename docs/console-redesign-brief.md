# Console redesign brief (phase N4)

Written on 16 November 2026 after a walk through the running console as the seeded demo account, at commit 3a5808e. This file is the instruction set for the session that builds N4a, N4b and N4c in PROJECT.md. Read it with CLAUDE.md and the N4 entry in PROJECT.md, then enter plan mode for the part you are building.

## Who the console is for

The owner of a small Filipino business or office, on a phone as often as on a laptop, who has never used an automation tool. They want to know three things: is it on, what came in, and did anything go wrong that needs them. Staff submit forms. Approvers answer approvals. Nobody outside the person who runs the installation needs the graph editor, webhooks, cron, tokens, JSON or step ids.

## What the walk-through found

Pages visited: Home, Try an example, Business and email, AI model, API tokens, Team, an office-request page, the Inquiry triage editor, its run history, one run, its versions, the Booking confirmation editor, the public form. Bookings and Resources could not be opened because the Docker image's web bundle predates those routes (the bundle has no `#/bookings` or `#/resources` string). Rebuild with `docker compose up -d --build` before testing them.

Home (`apps/web/src/App.tsx`)

- The page is titled Workflows and the header holds Team, API tokens, Business and email, AI model and Sign out. At phone width the header shows only Workflows, the email and Team; the rest is cut off (one `@media (max-width: 800px)` rule in `styles.css`).
- The three template cards at the top are the right idea and stay.
- New workflow and Build with AI sit above the owner's own automations.
- Your workflows is a flat list of name plus slug (`office-requests-7`, `qa-03-caf-promotion-approval`). No state, no last result, no form link, no activity link.
- Set up for my office creates a new workflow on every click. The demo account has seven abandoned drafts named Office requests, at wizard steps name, fields and review. The wizard must resume the existing draft or ask.
- `/runs?review=true` returns 50 runs on this database, which is the list cap. Home gives no sign that anything needs attention.
- A list load failure is shown only inside the owner's New workflow form; other roles see Loading forever (`App.tsx:135, 217`).

Office request page (`apps/web/src/OfficeRequests.tsx`, route `#/a/:id`)

- Good: Accepting requests badge, Copy form link, Open form, View activity, a Requests table with reference, subject, received, progress and deliveries.
- The form link paragraph says "This link works on this computer only", which is right locally and must change on a public host.
- Open advanced editor sits beside the owner actions; move it behind Advanced.
- At phone width the table scrolls sideways; it should become cards.
- The wizard's Next, Turn on and Save and finish later have no busy state (`OfficeRequests.tsx:166-182, 207`). A fast double click swallows a click, can regress saved answers and can publish two versions. This is the cause of the red e2e job on `76defb1`.
- The review step says mail goes through "the mail server in this installation's settings" with no warning that nobody receives it when that server is Mailpit.
- A failed load of the requests list renders "No requests yet" (`:415`).

Business and email (`apps/web/src/BusinessSetup.tsx`, `Connections.tsx`)

- One long page with six sections: business details, email sender, Connect Gmail, Google Sheets, Slack, Outlook, Teams, then website inquiries. Gmail is the third section down.
- Sheets asks for a service account key file (JSON), Slack for bot scopes and a Bot User OAuth Token, Teams for a Workflows link. These are IT tasks and belong under an "Optional extras" or "For your IT person" section, collapsed.
- Disconnect buttons act on one click with no confirmation (`Connections.tsx:147, 241, 355, 401`; `BusinessSetup.tsx:162`).
- Save Gmail sender has no busy state (`:250`).

AI model (`apps/web/src/Settings.tsx`)

- Provider presets, model names like `gemini-3.5-flash-lite`, an API key field. Developer page; move behind Advanced. The demo account has a saved Gemini key; a public demo seed must not carry keys.

API tokens, Team, Versions

- API tokens: "MCP clients connect to /mcp with Authorization: Bearer". Behind Advanced.
- Team: fine. Role descriptions are plain. Keep in the main menu.
- Versions: "v1 live", "Show drafts". Behind Advanced.

Editor (`apps/web/src/Editor.tsx`)

- The steps list shows ids (`acknowledge`, `classify`, `is_billing`, `to_billing`) and the trigger node shows the raw type `form`.
- Run panel: "Sample trigger data (JSON)", a checkbox "Make live calls (HTTP, email, AI, approval emails and connected apps). Off: they are mocked.", then Test run draft and Run live version side by side. Run live and Publish have no confirmation (`:182, :208`).
- Ask the AI panel at the top of the side column. Fine for Advanced users.
- The canvas cannot be used on a phone. Show "Use a computer to edit the diagram" under 800 px.

Run history and run page (`apps/web/src/Runs.tsx`)

- Columns: Started, State (`succeeded`), Kind ("test run, mocked calls"), Version (`v1`), Duration. Filters All, Live, Test.
- The run page shows trigger data and every step's input as JSON blocks, the branch as `is_billing → false`, and "Retry runs the step once more, with the same Idempotency-Key".
- The deliveries section renders nothing when the load fails (`:196-201`); `useRun` swallows errors and keeps "Loading…" (`:14, 176`); polling never stops on `needs_review` (`api.ts:66`).
- The review decision reads "may or may not have reached the receiver... Check with the receiver, then choose." An owner cannot act on that for a channel they do not use.

Public form (`/forms/:id`, served by the API)

- Page title is "Form". No business name, no heading, no explanation, bare labels, a Send button. The page text also shows a field labelled Website, which is the honeypot; check it is hidden from screen readers and autofill (`aria-hidden`, `tabindex=-1`, `autocomplete=off`), or real visitors will fill it and be dropped as spam.

## Target experience

Three roles, three home screens.

- Owner: Home is Automations. One card per automation with its name, a plain state (On, Off, Needs you, Problem), the last thing that happened ("Request REQ-V7E6FW received 2 hours ago"), and Copy form link, Activity, Pause. A Needs you strip at the top when any run or delivery waits for a decision. Below: "Add an automation" with the three templates. Nothing else on the page.
- Staff (requester): the form and My requests. Already exists as MyRequestsPage.
- Approver: the approvals waiting for them, then their history.

Advanced, a menu entry for the person who runs the installation: the graph editor, Build with AI, New workflow from a template or blank, API tokens, AI model, Versions, Resources, webhook and cron triggers, step ids, JSON panes.

Vocabulary, used everywhere including emails:

| Today | Owner-facing |
| --- | --- |
| Workflow | Automation |
| Run, run history | Activity |
| Trigger: form, webhook, schedule, manual | Starts when someone submits the form; when another system calls kymavo; on a schedule; when you press Run |
| succeeded | Done |
| failed | Problem |
| waiting | Waiting (until a time, or for an approval) |
| needs_review | Needs you |
| pending, running, queued | Working |
| Test run, mocked calls | Preview (nothing sent) |
| Live run | Real run |
| Retry, Send again, Mark as sent, It went through, Stop | Keep the actions, add one plain sentence each: "Send it once more", "I checked, it arrived", "Do not send, close this" |
| Deliveries | Where it was sent (sheet row, Slack note, email) |
| Version v3 | Hidden unless Advanced; show "changed 3 days ago" |

Rules:

- Every destructive or outward action asks once: Run real version, Publish, Disconnect, Send again, Pause, Delete.
- Every load has three states: loading, failed with Retry, empty with one sentence and one action. No blank space on failure.
- Anything still Working after 60 seconds says "Taking longer than usual" and names who to tell.
- When no real sender is connected, every page that sends mail shows "Emails go to the local test inbox. Nobody receives them." with a link to connect Gmail.
- Phone first: one column, header collapses to a menu, 44 px targets, tables become cards under 600 px, the canvas is desktop only.
- Honour `prefers-reduced-motion`.
- Keep the existing accessibility: labels, `role="alert"`, focus outlines, dark mode.
- Tagalog comes in N8; write strings so they can be moved into a table without rewording.

## References

- Zapier's editor: steps as sentences in one column. Pattern only.
- Activepieces (MIT, React, React Flow): a builder made for the same buyer. Read its flow builder and its "pieces" shape for the provider interface problem.
- Dify (Apache 2.0), Langflow (MIT), Flowise (Apache 2.0): node and edge status during a run.
- xyflow examples (MIT): animated edges, custom edges, node toolbar.
- driver.js (MIT): guided tours. The cheap form of "put your form link here".
- Impeccable and Hallmark skills: use `/impeccable` to critique a page before and after, `/hallmark` for the public demo page in N5.
- Do not copy from n8n (Sustainable Use License), Cal.com or Typebot (AGPL or FSL). Look only.

## Build order

N4a, quick fixes. Files: `OfficeRequests.tsx`, `Runs.tsx`, `api.ts`, `App.tsx`, `Editor.tsx`, `Connections.tsx`, `BusinessSetup.tsx`, `styles.css`, `e2e/connections.spec.ts`, `e2e/office-request.spec.ts`.

1. Busy state on the wizard: one `busy` flag disables Next, Back, Turn on and Save and finish later while a save or publish is in flight. The e2e test waits for each step heading instead of clicking twice blind.
2. Resume the existing draft: Set up for my office opens the newest unfinished Office requests draft if one exists.
3. Load failures: `RunDeliveries`, `LivePage`, `useRun` and the Home list show "Couldn't load. Retry." Polling stops on finished states including `needs_review` and continues only while Working.
4. "Taking longer than usual" after 60 seconds in the Requests list and on a run.
5. Mail banner when no real sender is connected, on the wizard review step and the office request page. Use the same sender status the Business and email page reads.
6. Confirmations on Run live version, Publish, Disconnect (all providers and Gmail) and the run-level Send again.
7. Honeypot check on the public form.

Acceptance: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` green; CI green; a Playwright test double-clicks Next against a delayed save and lands on the next step once.

N4b, navigation. Files: `App.tsx` (new Automations home, Advanced menu), a new `Automations.tsx`, `OfficeRequests.tsx` (cards under 600 px), `Runs.tsx` (plain states, details block), `styles.css` (header menu, targets, cards), `BusinessSetup.tsx` (Gmail first, extras collapsed), the API if the list needs a last-event field (`apps/api/src/workflows.ts`).

1. Automations home with state, last event, Copy form link, Activity, Pause. Pause needs a per-workflow flag; if it is not built yet (PROJECT.md N11 lists it), show Pause disabled with "coming" rather than hiding it.
2. Needs you strip from `/runs?review=true`, with the count and a link.
3. Advanced menu holding everything developer-facing.
4. Plain-language states and a "Details for a technician" block on run pages.
5. Business and email: Gmail first as three numbered steps with a status pill; Sheets, Slack, Outlook, Teams under "Optional extras".
6. Phone pass.

Acceptance: a person not coached sets up office requests and finds one request's receipt on a phone in under five minutes; Playwright covers the new Home at desktop and phone width; `/impeccable critique` on Home and the office request page lists no blocking item.

N4c, run animation. Files: `Editor.tsx`, `lib/graph.ts`, `Runs.tsx`, `styles.css`.

- Map each step's state to a node class: Working pulses, Done green, Problem red, Waiting amber, not reached grey.
- The edge into the Working step is animated with a green stroke; edges between Done steps are solid green; the branch not taken stays grey.
- Flow comes from the existing one-second run polling; no new endpoint.
- A custom edge with an SVG circle on `animateMotion` gives a flowing dot; React Flow's built-in `animated` edge is the fallback. Both off under `prefers-reduced-motion`.
- The run page reuses the same canvas, read only, so an owner sees the path a request took.

Acceptance: one Playwright test starts a preview run and asserts the trigger node and the first edge gain the Done class before the last step does.

## Out of scope for N4

Tagalog (N8), SMS (N7), the AI helper (N10), per-workflow pause in the engine (N11, the button can appear disabled), new providers, any change to the engine or worker.

## How to work

- Run the stack with `docker compose up -d --build` or, for hot reload, the API and worker with `pnpm --filter @daloy/api start` and `pnpm --filter @daloy/worker start`, then `pnpm --filter @daloy/web dev` on port 5173.
- Demo login is in the README. The demo database on this machine has seven abandoned Office requests drafts and 50 runs needing review, which is useful test data for N4a and N4b.
- Before each part: plan mode, list files, wait for go. After each part: five-line report, commit, tick PROJECT.md, update docs/how-it-works.md for anything that changed behaviour.
- Write tests first for the busy lock, the resume logic, the state mapping and the animation class assignment.
