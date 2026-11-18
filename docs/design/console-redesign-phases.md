# Daloy console redesign handoff

Work in C:/dev/balitos-portfolio/daloy-homepage on branch `ui/automation-home`. Read PROJECT.md, AGENTS.md and the Automations homepage section of DESIGN.md before editing. The approved reference is `c92ddc7`. Current main through `9e03c03` has been integrated on the design branch. The target is the signed-in console, including its role-specific views. Preserve routes, permissions, localization, keyboard access and working actions. Use real state for metrics.

## Phase ledger

| Phase | Scope and file ownership | Acceptance |
| --- | --- | --- |
| 1. Shared shell | Nav.tsx, shared shell styles and theme scoping. Carry the approved logo, inset charcoal current tab, grouped navigation, light workspace and responsive menu across signed-in staff pages. | Current location and role-appropriate navigation work at desktop and phone widths. Existing Secrets and Bookings routes survive. |
| 2. Operations | Runs.tsx, Bookings.tsx, Resources.tsx and a dedicated operations stylesheet. Apply the approved type, spacing, surfaces and status treatments to activity, run details, booking and resource management. | Filters, review and recovery, details, no-show, booking changes and resource actions remain accessible. Long lists and empty states work on a phone. |
| 3. Creation and editor | NewAutomation, BuildWithAi, Editor, Versions and their child panels. | Guided and custom creation, AI draft review, canvas/list editing, testing, save and publish remain usable. |
| 4. Workspace administration | Apps, Connections, BusinessSetup, Settings, AI, Team, Account, Advanced, Secrets and Tokens. | Owner/operator restrictions, connection states, billing and usage notices, language selection and secret handling are preserved. |
| 5. Requests and sign-in | Guided office/purchase requests, requester and approver views, invitations, sign-in and recovery. | A requester can submit and track a request, an approver can decide, and authentication and recovery paths stay usable. |
| 6. Console QA and close-out | Route inventory, English and Tagalog, roles, accessibility, desktop and mobile regression checks, design notes and final handoff. | Record executed checks and blockers per route, and give the owner the review branch and preview. |

## Resume in a fresh chat

Open one chat per phase. State the phase number, worktree and latest commit. Phases 1 and 2 may run together with the ownership above. For concurrent work, stage only files owned by that phase. Coordinate edits to shared CSS, translations and documentation with Astra. Use isolated fixtures and fake providers; the running Docker account holds user data.

At handoff, record the phase status, commit, checks actually run, anything unverified and the next phase here. Claude can resume from the first unfinished row after checking Git status and log. The owner reviews and merges the branch.

## Final review before Docker

The owner requested a full walkthrough or sample HTML after all six phases, before putting the finished redesign into Docker. Deliver a local browser preview with a walkthrough. The owner must be able to inspect the final design with Docker stopped.

Use clearly labelled synthetic data. Cover the homepage, activity and run details, bookings and resources, creation and editor, workspace settings, and requester/approver and sign-in flows. Include desktop and phone layouts, role differences and an empty or error state. Explain how to open the preview, what to click, which interactions are simulated, and which checks actually ran. Link the preview and walkthrough here and in the final handoff. The owner reviews them before authorizing a final Docker rollout. Until then, verify new work outside the running Docker stack.

## Progress

- Phase 1 committed at `9e0ea63`. Shared navigation passed 23 focused tests. Astra verified the combined web build, full TypeScript check, and five routes at desktop and phone widths with synthetic data.
- Phase 2 in final verification. Phases 3 and 4 approved and running in separate parallel chats. Phases 5 and 6 queued.
