# Console UI from the Paper file (U1 to U7)

Status: plan only, waiting for the owner's "go". Base: `main` at 8c2dd54 (R1 to R6 done).

Sources: the owner's eight asks and screenshots of 21 November 2026, and the Paper file `daloy`, pages "Workflow tab" (artboards "1 Improved current": diagram, list, paused test run) and "Automations tab" (artboard "2 Ops table").

## Values taken from the Paper file

Workflow tab (1440 x 900):

- Header: padding 20px 28px 0, bottom border 1px #E3E6EC. Crumb, title 24px with a Draft chip, tabs (Steps, Runs, Versions, Settings) with a 2px blue underline. Actions (Test run, Save, Publish) sit at the right of the header, gap 8px, 20px above the border.
- Canvas: flex 1, padding 20px 24px, background #F5F6F8 with an 18px dot grid (1px #CDD2DC dots). Zoom bar bottom left (left 24px, bottom 20px, padding 4px, radius 9px, border #D5D9E1).
- Node: 260px wide, padding 10px 12px, radius 10px, gap 3px, border 1px. Selected: 2px #1B45C9 border plus a 4px #E8EEFF ring. Needs setup: border #E5A93B. Connectors 2px, 26px between nodes; branch pills on the split line.
- Right panel: 380px, padding 22px 24px, gap 20px, white, left border 1px #E3E6EC. "Change this with AI" box at the bottom: padding 12px, radius 10px, #F5F6F8, border #E3E6EC.
- List view (Paper "Map" and "List" toggle): table rows with Last test column and a dashed "+ Add a step at the end" button. The phone list from R4 already follows this.

Automations tab ("2 Ops table"): table area padding 22px 28px, gap 18px; stat strip in one 10px-radius bordered box; toolbar gap 8px; detail panel 380px, padding 22px 24px, gap 20px, background #F5F6F8. `main` already ships this layout (Doop A1, decision 0068), so ask 8 is a behaviour change, not a restyle.

The Paper workflow frames show the panel with a selected step only. The owner's ask 2 adds the empty state: with nothing selected the panel holds the actions and the AI box. That state is not drawn in Paper; U2 builds it from the same panel values.

## What changes, by ask

1. Navigation calmer, Inter everywhere (U1)
   - The rail opens on hover after 150ms and widens over `--dur-base` (200ms), labels fade in over 100ms. Change: a hover-intent delay of 250ms, a close delay of 200ms so passing the mouse over the rail does not flicker it, width over 280ms and labels over 180ms after a 120ms delay, all with the existing `--ease` (no overshoot). Reduced motion keeps no transition. The phone sheet keeps its keyframes at 280ms.
   - Inter is already `--font-sans`. Mono still appears: every `textarea` (styles.css), `.wk-mono`, template references, run refs and times in Activity. Change: `--font-mono` stays defined, but textareas, inputs, references and IDs use Inter with `font-variant-numeric: tabular-nums`. Mono is kept only for the raw JSON payload box and code blocks, if the owner agrees (question 1). The `site/` and demo pages are out of scope (Codex's branch carries Geist there).
2. Workflow page like Paper (U2)
   - Header: crumb, title, chip, tabs. The actions move out of the header into the panel.
   - Panel, nothing selected: a sticky top row with Test run, Explain, Save and Publish (Publish blue, as now). Below: setup guide (only while setup is unfinished), "Check before publishing", the sample test result, "Change this with AI" (the existing `AskAi`), and "Test settings" folded in a `<details>` (payload, mocked or live, test choices, Run live version). The "Add a step" select from R4 is removed from the panel.
   - Panel, a step or the trigger selected: the same action row, then the step settings exactly as today (kicker with Delete, name, lead, fields, files, insert data, Connect to, What happens next). A Close button (and Escape, and a click on the empty canvas) returns to the empty state.
   - Collapse: a 32px toggle on the panel's left edge. Collapsed, the panel is a 44px strip and the four actions show in the header instead, so they are never hidden. The choice is kept per viewer in `localStorage` (`daloy.editor.panel`), read inside try/catch. Selecting a node opens a collapsed panel.
   - Phone (under 800px): unchanged R4 behaviour. List first, step settings in the bottom `Sheet`; the action row sits above the list.
3. Nodes and canvas (U2, then U3 for Disable)
   - Remove the black "+ Add step" button. Adding is by the plus on a connection, by drag from a connection dot, by right click, and in the list view by "+ Add a step at the end" (as in the Paper list frame). The phone list keeps its add button.
   - Connection dots: React Flow handles are kept but hidden; a selected node shows them (8px dots, 2px white ring, blue). `nodesConnectable` turns on. Dragging from a dot draws a dashed line with a dashed 260 x 60 drop target at the pointer, like the Lucid example. Dropping on another node calls `connectSteps` (its rules: no self link, no loop, no orphan; a refusal shows its reason in the canvas note). Dropping on empty canvas opens the Add menu as a popover at the drop point and adds the step after the source, on the dragged branch. The keyboard path stays: Connect to in the panel and Shift+F10.
   - The plus on a connection: three faults seen in screenshots 2 and 3. The plus is pushed 44px right of the branch pill and overlaps the next pill ("rejected" behind it), its 10px invisible hit area overlaps neighbours, and the menu opens as a centred modal whose list scrolls sideways and cuts its first row. Fix: place the plus on the edge's vertical run below the pill, no overlapping hit area (44px only on coarse pointers), and open the Add menu as a popover anchored to the plus on a wide screen (still the `Sheet` on a phone). Descriptions wrap to two lines with no horizontal scroll. U2 first adds a failing e2e test that clicks the plus on each branch of a condition and an approval and asserts which step gets added where, then fixes it.
   - Click: selects and opens the panel. Double click: opens the panel and focuses the first field. Right click on a node: a context menu (Lucid style, 220px, 13px items with shortcuts on the right): Test this step, Duplicate (Ctrl+D), Copy (Ctrl+C), Connect to (enters connect mode: the next node clicked becomes the target), Disable (U3), Delete (Del). Right click on empty canvas: Paste step (Ctrl+V, when a step was copied), Add step here, Fit view. Shift+F10 and the Menu key open the same menu for the focused node. The menu is a `role="menu"` list with arrow keys, Escape and focus return.
   - Duplicate: new pure `duplicateStep(draft, id)` in `lib/graph.ts`: same type and config, a new id (`<id>_copy`, `_copy_2`), inserted after the original on a straight stretch, refused on a branching step with a reason. Copy and paste: the step's `{type, config}` in memory and in the system clipboard as JSON; paste validates against the step schema before `addStep`. Only steps, never secrets (configs hold `{{secrets.name}}` references, not values).
   - Test this step: runs the mocked test of the whole draft (no API change), then scrolls the panel to that step's result. A real single-step run would need a new API endpoint and sample inputs for earlier steps (question 4).
4. Build with AI and files (U4)
   - Cause: the builder prompt in `packages/engine/src/ai-draft.ts` lists field types "text, email, number, textarea, datetime, resource" and leaves out `file`, and it strips `files` from the AI step schema on purpose (decision 0052: reading a file is the owner's consent). It also leaves out the `drive`, `sms`, `airtable`, `notion`, `trello`, `payment_*` and `meta_reply` steps to fit a small model.
   - Fix: add `file` to the field types with one line on what it does (up to the file limit, photos and PDFs). Tell the model that an AI step reads a form file only after the owner ticks it, so it should add the file field and an `ai` step (task extract or summarise) and say in its summary which box to tick. Keep `files` out of the schema, so consent stays with the owner. The review screen and the Turn on summary already list unchecked file reads as a check; U4 adds a warning "AI step read_schedule reads no file, but the form has a file field" to the definition checks so the gap is visible before publishing.
   - Add `drive` back to the prompt (it is the other half of the file story) and the connected-apps line already sent by `ai-chat.ts` decides whether it may be used.
   - Other gaps found, fixed in U4 when small, else listed as follow-ups: (a) the chat asks the same yes or no question again after the owner already answered in free text (screenshot 8); the prompt gets a rule to accept a free-text answer and move on. (b) "Put my schedule in a sheet with time as rows and days as columns": a sheets step appends one row per run; the AI should say so and offer one row per class instead. (c) The builder never proposes `sms` even when the operator has UniSMS configured; after U6 the prompt includes `sms` only when the server reports it. (d) Tests: `ai-draft.test.ts` and `ai-chat.test.ts` assert the field list and the new rules; a fake-model e2e in `build-with-ai.spec.ts` builds "upload my schedule photo, AI reads it, add to Sheets" and lands on a review with a file field and an AI step.
5. Workflow library (U5)
   - Recommendation: upgrade `#/new` into the library instead of a new page. It already lists the 16 templates, but in a select box. The rail entry "New automation" becomes "Library" (same route, so links keep working).
   - Layout: search, category chips (Inquiries, Bookings, Payments and receipts, Orders, Office), and a card grid (3 columns at 1280px, 1 at 390px). Each card: name, one line, trigger, the apps it needs with logos, and "Use this". Selecting a card shows a read-only diagram (`RunFlow`, already used by run detail) and the steps in words beside it, then "Use this" creates the draft as today. Blank workflow and Build with AI stay as two cards at the top.
   - Data: a `category` field on each template in `packages/engine/src/templates.ts`, with a test that every template has one. No API change: templates are bundled in the web app already.
6. UniSMS by the operator (U6)
   - Today a workspace can paste its own UniSMS key in Apps, and the operator's shared key (`SHARED_UNISMS_KEY=open` with `UNISMS_SECRET_KEY` and `UNISMS_SENDER_ID`) is a fallback for paid plans only.
   - Change: the server's env is the only source. Remove the UniSMS card from Apps and from `Connections.tsx`, remove `PUT /settings/connections/unisms` and its test route, stop reading workspace `unisms` rows in the worker, and treat UniSMS as configured when the two env values are set (`SHARED_UNISMS_KEY` is dropped). A private install (plan null) may send; preview stays at 0 SMS by the existing quota. The catalog tells the web app whether SMS is available; when it is not, the SMS step is hidden from Add step and Build with AI, and an existing SMS step shows "SMS is not set up on this server" instead of "Connect UniSMS in Apps".
   - Existing workspace keys: `unisms` is already in `RETIRED_CONNECTION_PROVIDERS`, so a one-time retire on deploy moves any stored key into `retired_secrets` for the existing purge. No migration: the CHECK constraints keep `unisms` because deliveries still use it.
   - Docs: decision 0074 gets a superseded note, `.env.example`, `docs/live-unisms-check.md` and the threat model (one fewer customer secret) change.
7. AI usage in the rail (U1)
   - Under "Build with AI", a small meter for owners: "AI 120 of 500 this month" with a 4px bar, from the existing `GET /usage` (no API change). Hidden when the plan has no AI limit. Collapsed rail: the bar only, with the text as its accessible name. Fetched on load and after a Build with AI or Ask AI reply (a `daloy:usage` window event), not on every page change.
8. Automations list (U7)
   - Double click on a row opens the workflow (`#/w/<id>`). Single click selects it and opens the side panel. Enter on the focused name opens the panel, Shift+Enter or the panel's "Open steps" opens the workflow, so the keyboard path matches.
   - No row is selected on load, so the panel is closed and the table uses the full width (today the first row is picked automatically). The panel gets a Close button and Escape; it opens again on the next row click. Phone keeps the bottom sheet.

## Phases

Each phase claims its line in `PROJECT.md`, works in its own worktree from `main`, and keeps to its files. Strings go into the phase's existing locale file so no two phases edit the same one. Decision numbers are fixed now so they do not collide.

| Phase | Asks | Files | Model |
|---|---|---|---|
| U1 Rail, fonts, AI meter | 1, 7 | `Nav.tsx`, `Nav.test.tsx`, `console-shell.css`, `styles.css`, `workspace.css`, `activity.css`, `motion.css`, `lib/usage.ts` (+ test), `lib/locale-workspace.ts`, `e2e/navigation.spec.ts` or the existing nav e2e | Sonnet 5.5, medium |
| U2 Editor panel and canvas | 2, 3 | `Editor.tsx`, `FlowCanvas.tsx`, `editor.css`, `Sheet.tsx` (a `Popover` beside `Sheet`), `lib/graph.ts` (+ `duplicateStep`, paste check) and `lib/graph.test.ts`, `lib/locale-editor.ts`, `e2e/editor.spec.ts`, `e2e/phone-editor.spec.ts`, decision 0096 | Opus 5.5, high |
| U3 Disable a step | 3 | `packages/engine/src/definition.ts` (`disabled?: true` on a step, refused on a branching step), `apps/worker/src/advance.ts` (a disabled step is recorded as skipped and the run follows its one edge), engine and worker tests, then the Disable item in `Editor.tsx` and a greyed node in `FlowCanvas.tsx`, decision 0097 | Opus 5.5, high. Runs after U2 merges (it touches U2's files at the end) |
| U4 AI builder | 4 | `packages/engine/src/ai-draft.ts`, `ai-chat.ts`, their tests, the definition check for an unread file field (`definition.ts` warning list only, coordinated with U3: U4 goes first or rebases), `e2e/build-with-ai.spec.ts`, `test/fake-providers.ts` only if the fake model needs a canned reply, decision 0098 | Sonnet 5.5, high |
| U5 Library | 5 | `NewAutomation.tsx`, `guided-pages.css` (or a new `library.css`), `packages/engine/src/templates.ts` (`category`) and `templates.test.ts`, `lib/locale-guided.ts`, `e2e/templates` spec or `main-flow.spec.ts` where it opens `#/new`, decision 0099 | Sonnet 5.5, medium |
| U6 UniSMS by the operator | 6 | `Apps.tsx`, `Connections.tsx`, `lib/editor.ts`, `BuildWithAi.tsx` (app label map only), `packages/db/src/connections.ts`, `apps/api/src/connections.ts`, `apps/api/src/workflows.ts` (checked providers, catalog flag), `apps/worker/src/steps/index.ts`, their tests, `.env.example`, `docker-compose.yml` env, `docs/live-unisms-check.md`, decision 0100 | Sonnet 5.5, high (credential path) |
| U7 Automations list | 8 | `Automations.tsx`, `automations-ops.css`, `lib/locale-ops.ts`, `e2e/automations.spec.ts` | Sonnet 5.5, medium |

U1, U2, U4, U5, U6 and U7 can run at the same time. U3 follows U2. Shared docs (`PROJECT.md`, `docs/how-it-works.md`, `docs/threat-model.md`) are edited by every phase in its own section; the coordinator resolves those at merge. The Nav label "New automation" to "Library" is in U1, not U5. U4 needs U6's catalog flag for the `sms` rule (c); U4 ships (c) only if U6 has merged, else it is a follow-up.

## Tests and browser checks per phase

Every phase: `pnpm lint`, `pnpm typecheck`, `pnpm test`, its e2e specs, then the full `pnpm e2e` once before merge (one run at a time, ports 3100 and 2526 to 2528). Browser check at 390 px and 1280 px wide on a disposable stack, never the owner's localhost:3000 data.

- U1: unit test for the usage line text and the hidden case. Browser: hover the rail slowly and quickly (no flicker), reduced motion, meter at both widths, computed `font-family` is Inter on a textarea in the editor, Activity refs and the Advanced pages.
- U2: unit tests first for `duplicateStep` and the paste check (ids, refusal on a branching step, the graph stays valid). e2e: the plus on each branch of a condition and an approval adds the right step; drag from a dot to empty canvas adds a step; drag onto another node connects or shows the refusal; right click menu items by mouse and by Shift+F10; panel empty state shows the four actions and AI box; collapse and reopen; the selected node shows dots. Browser: 1280 px both panel states and collapsed, 390 px list, sheet and action row.
- U3: engine tests first (disabled on a branching step is refused; a disabled step is skipped and its next step runs; a test run shows it as skipped). Browser: a disabled node is greyed, the run view shows Skipped.
- U4: prompt tests (file is a listed field type, `files` still absent, the free-text-answer rule present), the new definition warning, and the fake-model e2e. Browser: Build with AI at both widths with the schedule photo request.
- U5: every template has a category; e2e search, filter, preview and "Use this" create a draft. Browser: grid at 1280 px (3 columns) and 390 px (1 column), preview diagram readable.
- U6: tests first for the credential resolution (env only, private install allowed, preview refused, a stored workspace key is ignored and retired), the API returns 404 for the removed routes, the catalog flag. e2e: Apps has no UniSMS card; an SMS step without env shows the server message; with the fake UniSMS env a test SMS delivery is queued. Browser: Apps at both widths.
- U7: e2e double click opens the editor, single click opens the panel, no panel on load, Close and Escape. Browser: table full width at 1280 px with the panel closed and open, phone sheet at 390 px.

## API and migration changes

- No migration in any phase.
- U6: removes `PUT /settings/connections/unisms` and `POST /settings/connections/unisms/test`; adds an `sms` availability flag to the step catalog response.
- U3: a step may carry `disabled: true`. Older workers would run a disabled step, so U3 ships the worker and engine together.
- All other phases are web only, or engine prompt text.

## Risks

- Codex's Doop phase 2 on `design/paper-redesign` (worktree in `~/.t3/worktrees/daloy/`) has uncommitted changes to `Automations.tsx`, `apps/api/src/workflows.ts`, `api.ts` and `e2e/automations.spec.ts`. Its branch starts from 0d6474a, before Doop A1 put the same ops table on `main`, and its phase 1 was already copied to `main` as 014d206. Merging it now would conflict with `main` and with U6 and U7. Proposal: the owner tells Codex that `main` already has the ops table and asks it to stop phase 2 or redo it on today's `main` after U7. U7 does not start while that claim is open. U6 touches `workflows.ts` only in the catalog and checked-provider lines.
- Turning on `nodesConnectable` changes how React Flow handles pointer events on nodes; selection by click and the phone list must keep working. U2's e2e covers both. React Flow 12.12.1 docs for `onConnectEnd` are read from the installed package, not guessed.
- Removing the R4 "Add a step" select changes `e2e/editor.spec.ts` and `phone-editor.spec.ts`, which use `#add-step-type`. U2 rewrites those steps to the menu.
- Copy writes to the system clipboard, which needs a user gesture and may be refused; paste falls back to the in-memory copy.
- U6 removes a feature some workspace may use. If a workspace has its own UniSMS key on the live server, its SMS stop until the operator env is set. The owner checks this before U6 deploys (question 6).
- Moving the actions into the panel changes muscle memory for current users; the collapsed state puts them back in the header.

## Questions for the owner

1. Inter everywhere: may the raw JSON payload box and code samples keep the mono font, or Inter there too?
2. Panel actions: when a step is selected, keep the four actions on top of the panel (my plan), or show them only with nothing selected?
3. Library: rename the rail entry "New automation" to "Library"? Are the five categories right?
4. "Test this step": is running the whole mocked test and jumping to that step enough, or do you want a true single-step run (new API, sample data for earlier steps)?
5. Disable: needed in the first round (U3), or later?
6. UniSMS: does any workspace on your server use its own UniSMS key today? Should SMS be open to every plan on a private install, or follow the existing plan quotas only?
7. AI meter: under "Build with AI" in the rail, or by the account at the bottom of the rail?
