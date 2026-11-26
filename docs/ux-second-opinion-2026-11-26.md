# UX second opinion (26 November 2026)

Independent review of product architecture, navigation and first-run path. Based on the code in `apps/web/src` at `main` and on the 25 November pilot audit. I did not run a new browser session, so pixel-level claims below come from the audit, and structural claims come from the code.

Note: F1 to F6 in `PROJECT.md` are already ticked. Section 2 is therefore a review of what was fixed and what was left at the root.

## 1. Hard truth

kymavo is two products sharing one sidebar. There is a guided setup wizard (`#/a/:id`, `OfficeRequests.tsx`) that a non-technical owner can finish, but it exists for exactly two templates (office request and purchase request). Every other path lands on the developer editor at `#/w/:id`: all of the roughly 40 Library templates (`NewAutomation.tsx:102`), the onboarding "Open my draft" button (`Onboarding.tsx:313`), and Build with AI. On desktop that editor opens in Diagram view by default (`Editor.tsx:203`). The owner-friendly checklist that already exists (`lib/guide.ts`: connect, check messages, explain, try, turn on) sits in a side panel next to the canvas instead of being the page. The cause is in the data: templates in `packages/engine/src/templates.ts` describe steps but not what the owner must answer or connect, so no wizard can be generated from them, and the editor became the setup screen by default. Most of the pilot audit's P0 list follows from this single decision.

## 2. Where I disagree with `docs/plans/pilot-ux-fixes.md`

F1 fixed the right bugs at the wrong layer. Readiness ("can this automation run?") is still computed in at least six places: `Editor.tsx`, `Guide.tsx`, `lib/guide.ts`, `packages/engine/src/flow-guide.ts`, `apps/api/src/explain.ts` and `apps/api/src/workflows.ts`. The pilot's false green check happened because these disagreed. F1 made them agree for SMS, Resources and PayMongo. The next app added will diverge again. The root fix is one server function, `readiness(workflowId)`, returning a list of blockers with a fix link each, read by the editor, the Turn on modal, the Library card, the wizard and Publish. Publish should refuse on the same list, so the UI can never claim more than the server allows.

F2 polished the graph for owners. Humanizing `eq`, durations and step ids in Diagram and List is good for technicians, but owners should not reach those screens during setup. Keep the work, and stop investing in owner copy inside the canvas.

F3 added links to hidden pages instead of removing the hidden pages. Linking `#/resources` from Bookings and `#/secrets` from Apps patches discoverability. Resources belong inside Bookings as a tab ("Rooms and slots"). Secrets should not be an owner concept: a Lalamove key is a connection, so Lalamove should be an app card in Apps that stores its key as a secret behind the scenes. "Ask about a request" got a picker, but it duplicates search on Activity. Merge it into Activity search.

F4 and F5 are correct polish and were cheap. No objection, except that several items (Library inline previews, editor toast overlap, 50% zoom clipping, mobile editor toolbar) vanish once owners stop landing in the editor and Library becomes a short picker.

F6 is the one that touched frozen onboarding files (`Onboarding.tsx`, migration `0059`) and it is ticked. Check that the owner signed off on that design, because the plan said F6 waits for sign-off. Onboarding also still ends by sending the owner to `#/w/:id`, which is the core flaw above.

What is missing from F1 to F6 entirely:

- Template "asks" metadata, so any template can run through the guided wizard.
- A single readiness source (above).
- A decision about who the editor is for. Right now it is for everyone, so it is optimized for no one.
- An end state for setup. The wizard turns into an automation status page after go-live (`#/a/:id`). The editor never does, so owners who started from a template have no calm "it is on, here is what happened today" page.

## 3. Proposed IA and navigation

Before (owner, desktop sidebar, `Nav.tsx`):

```
Work        Automations, Activity, Bookings, Conversations,
            Receipts to review, Knowledge
Build       Library, Build with AI
Workspace   Team, Apps, Business, Settings
Hidden      Resources, Secrets, Tokens, Advanced, Ask about a request,
            Settings > AI model
Help menu   Business setup guide, Ask about a request, Plan and usage,
            Connect apps
Top bar     New
```

That is 12 visible destinations, 6 hidden ones and 4 duplicated entry points.

After (owner):

```
Home            today: needs you, problems, what ran (replaces Automations
                summary cards plus Activity feed)
Inbox           Conversations + Receipts to review + approvals, one queue
                of "things waiting for a person", filter by kind
Bookings        tabs: Calendar, Rooms and slots (was Resources)
Automations     list, each opens its status page; "New" button opens a
                short picker (Library + Build with AI merged)
Business        tabs: Details and branding, Knowledge, Apps, Team
Settings        Plan and usage, Appearance, Account, Advanced
                (Tokens, Secrets, AI model, raw editor access)
```

Six destinations. Operators see Home, Inbox, Bookings. Requesters see Home only. Activity stays as a tab on each automation and as the "what ran" section of Home, with search that also answers "ask about a request". Knowledge moves under Business because it is "what kymavo knows about my business", which is how an owner thinks of it, and the concierge error text already points there.

Primary journey:

```
Sign up
  -> Onboarding (3 screens, frozen: only change the last button target)
  -> Guided setup for the chosen template (#/a/:id, generated from "asks")
       1. Answer 2 to 4 questions (deposit %, who approves, reply wording)
       2. Connect what is required (one card per app, from readiness list)
       3. Send yourself a test (real form link or Messenger test)
       4. Turn on
  -> Automation status page (#/a/:id after go-live)
  -> Home shows it under "running"
Editor (#/w/:id) only from "Edit steps" on the status page or Settings > Advanced
```

## 4. Top 3 redesign bets

Bet 1: every template opens in the guided wizard. Add an `asks` field to each template (question, which step config it fills, type, default) and generate the `#/a/:id` wizard from it plus the readiness list. The two hand-built wizards become the first two generated ones. The editor becomes "Edit steps" on the status page, and opens in List view for everyone, with Diagram one click away. This removes the false-green class of bugs, canvas clipping, step-id leaks and the "where do I start" problem in one move. On 390x844 the wizard is a single column of numbered steps that already works on phones, while the editor's toolbar and canvas are the worst mobile screens in the app.

Bet 2: one readiness list, shown the same way everywhere. Server returns blockers such as `{ kind: "connect", app: "paymongo", fix: "#/apps/paymongo" }` or `{ kind: "operator", what: "sms", text: "SMS is not available on this plan" }`. The Library card shows "Needs: PayMongo, SMS (not on your plan)" from this list before the owner picks the template, so a template the owner cannot run says so up front instead of failing at Turn on. Turn on is disabled with the list as the reason. On mobile this list is the whole setup screen.

Bet 3: one Inbox for everything that waits on a person. Conversations, Receipts to review, approvals and "Needs you" runs are the same job: a person must look and decide. Today they are three sidebar items plus a Home card. One list with a kind filter, a badge count in the nav, and a detail drawer (full-screen sheet on 390x844) with the two or three actions for that kind. This cuts three nav items and gives operators a single page to live in. The empty state explains what will appear there and links to the automation that feeds it.

Smaller layout notes that follow from the bets: one primary button per screen (Turn on in the wizard, nothing primary on status pages), drawers for detail and full pages only for setup, and Dark mode tested on the six destinations above instead of every hidden page.

## 5. Revised build order

I would not keep extending F1 to F6. Replace the next work with:

1. G1. Readiness service. One server function and endpoint, used by Publish and by every UI that shows "ready" or "needs". Tests first: each template seeded in a fresh workspace returns the blockers a fresh workspace really has. This is the phase to start now. It is backend-only, does not touch onboarding, and every later phase reads from it.
2. G2. Template asks and generated wizard. Add `asks` to templates, generate `#/a/:id` for all templates, route Library, Build with AI and Automations to it. Editor opens in List view.
3. G3. Navigation collapse to six destinations. Resources into Bookings, Knowledge, Apps and Team into Business, Secrets and Tokens into Settings > Advanced, Library and Build with AI into the New picker. Keep old hashes as redirects.
4. G4. Inbox. Merge Conversations, Receipts and approvals.
5. G5. Home. Replace the Automations summary plus Activity with one "today" page.
6. Onboarding (flag, frozen). The only change needed is the final "Open my draft" target from `#/w/:id` to `#/a/:id`. It is one line in `Onboarding.tsx:313` and should wait for the owner's sign-off like any other onboarding change.

Each phase needs a decision record (asks schema, readiness shape, nav merge) and a Playwright test of the journey in section 3 on desktop and 390x844.
