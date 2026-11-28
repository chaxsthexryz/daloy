# Console Blocks restyle (R1 to R5)

Status: plan ready for a Neon orchestrator session. Written 28 November 2026, after A1 to A8 landed on main.

The target look is the clickable mock `docs/design/console-blocks-preview.html`. Open it with any static server, for example `npx http-server -p 4173` from the repo root, then go to `/docs/design/console-blocks-preview.html`. Use **View as** in its top bar to see the Owner, Operator, Approver and Platform admin views.

The mock is a design reference, not code to paste. It is one HTML file with fake data. The real app (`apps/web`) already has every feature the mock shows: A1 thinking level, A2 shared AI model, A3 admin console, A4 feedback, A5 display name, A6 live bell and toasts, A7 own key by plan, A8 admin host and 2FA. This restyle changes how the app looks and is laid out, never what it does.

It builds on the Daylight Minimal revamp (D1 to D5, decisions 0111 to 0115, already merged). Most token names are the same, so the change is mostly layout, components and the font.

## Scope and boundaries

In scope:
- Tokens and type: switch `--font-sans` to Geist (`apps/web/public/fonts/geist.woff2` is already there; add its OFL licence file next to the others). Bring the mock's colour values and easing tokens into `apps/web/src/styles.css` where they differ.
- Shell: the mock's sidebar (section tree, account block with the display name and the role beside it, email as the title), the bell placement from A6, the phone hamburger drawer and bottom bar, and the Quick Jump palette look.
- Blocks: Home, Inbox and Automations as the mock's block cards. The KPI blocks are whole-card links (the mock's `.kpi-foot::after { inset: 0 }` stretched link).
- Secondary pages: New (templates plus Build with AI), Editor, Apps, Business, Bookings, Settings (including the AI model page with Thinking, and Notifications), Account, Support/Feedback, and the approver/requester requests page.
- The admin console (`admin.html` entry, `Admin.tsx`, `AdminAi.tsx`, `AdminFeedback.tsx`, `AdminTwoFactor.tsx`, `admin.css`) as the mock's ops shell, including the 2FA screens from A8, which the mock does not show; style them to match.

Out of scope:
- API, database and migrations. Every phase is web only. If a phase seems to need an API change, stop and write it down for the owner instead.
- The mock's **View as** bar and its font switcher: these are design tools, not features.
- The mock's fake data, and its 10 to 12 px text. Keep the app's type scale (`--text-xs` is 13 px and is the floor).
- The marketing site (`site/`), and the third-party logos in `apps/web/public/logos/` (decision 0085: shown unaltered).
- Onboarding (`Onboarding.tsx`, `onboarding.css`), unless the owner says it is ready.

Owner taste (from earlier rounds): no AI-default display fonts such as Cormorant, and no scramble or springy hover effects. Hovers use `--ease` or `--ease-spring`, never the overshooting `--ease-snappy`. Every motion has a `prefers-reduced-motion: reduce` fallback.

## Orchestration protocol (Neon)

Follow `../CLAUDE.md` and `AGENTS.md` for every phase:

1. At the start of the session, read `../CLAUDE.md`, `AGENTS.md`, `PROJECT.md`, this file and `docs/how-it-works.md`.
2. One phase per branch and worktree: `git worktree add ../daloy-<phase> -b neon/<branch> main`, then `pnpm install --frozen-lockfile` in it. Never edit the main checkout for phase code.
3. Claim the phase's line in `PROJECT.md` (`(claimed: neon, branch neon/<branch>)`) in a one-line commit on main. Stage `PROJECT.md` only, never `git add -A`, and add no AI co-author trailer.
4. Tests first for non-trivial logic (the sidebar tree state, stretched-link focus, the palette filter). Keep every `getByRole` and `getByLabel` name that the e2e specs use; change a spec only when the text or role really changes, and say so in the commit.
5. Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and the phase's Playwright specs in the worktree. Only one Playwright run at a time (fixed ports 3100 and 2526 to 2528).
6. Never touch the owner's Docker stack on localhost:3000, never reset its database, and never run `docker compose down -v`. Never source `.env` into the test shell.
7. Use the decision numbers below. Update `docs/how-it-works.md` where the layout changes, tick the phase in `PROJECT.md`, and report in five lines or fewer.
8. Merge each finished phase into main and push it, after rebasing on main and running the checks again (the owner's standing rule for daloy phases). Never force-push.

## Phases

R1 lands first. R2, R3 and R4 can then run in parallel (their files do not overlap). R5 comes last.

| Phase | Branch and decision | Files owned | Summary |
|---|---|---|---|
| R1. Geist, tokens, base components | `neon/r1-blocks-tokens`, decision 0159 | `apps/web/src/styles.css`, `apps/web/src/motion.css`, `apps/web/public/fonts/OFL-geist.txt`, `apps/web/index.html`, `apps/web/admin.html` | `@font-face` for Geist, `--font-sans` to Geist. Bring over the mock's Light and Dark colours where they differ, plus its easing tokens, keeping the `:root` and `:root[data-theme="dark"]` block shape that `lib/run-flow.test.ts` parses for WCAG AA contrast. Base button, input, select, card, tag and pill styles from the mock. |
| R2. Shell, sidebar, bell, palette | `neon/r2-blocks-shell`, decision 0160 | `apps/web/src/Nav.tsx`, `apps/web/src/Nav.test.tsx`, `apps/web/src/console-shell.css`, `apps/web/src/CommandPalette.tsx`, `apps/web/src/LiveEvents.tsx`, `apps/web/src/live-events.css`, `apps/web/src/toast.css`, `apps/web/src/lib/locale-workspace.ts`, `e2e/rail.spec.ts`, `e2e/navigation.spec.ts` | The mock's sidebar with its section tree, the account block (display name, role beside it, email as the title, Account and Sign out), the bell and toasts in the mock's place, the phone drawer and bottom bar, and the palette look. Keep the six destinations from G3, role scoping, `aria-current` and the inbox badge. |
| R3. Home, Inbox, Automations blocks | `neon/r3-blocks-pages`, decision 0161 | `apps/web/src/Home.tsx`, `apps/web/src/home.css`, `apps/web/src/Inbox.tsx`, `apps/web/src/inbox.css`, `apps/web/src/Automations.tsx`, `apps/web/src/automations-ops.css`, `apps/web/src/lib/locale-ops.ts`, `e2e/automations.spec.ts`, `e2e/home.spec.ts` (if present) | Block cards as in the mock's `renderHome`, `renderInbox` and `renderAutomations`. KPI blocks are whole-card links with a visible focus ring. Keep the G4 and G5 behaviour (counts shared with Inbox, Problems links, What ran). |
| R4. Secondary pages and requests view | `neon/r4-blocks-secondary`, decision 0162 | `apps/web/src/NewAutomation.tsx`, `apps/web/src/BuildWithAi.tsx`, `apps/web/src/creation.css`, `apps/web/src/ai-workspace.css`, `apps/web/src/Editor.tsx`, `apps/web/src/editor.css`, `apps/web/src/Apps.tsx`, `apps/web/src/apps-design.css`, `apps/web/src/BusinessPage.tsx`, `apps/web/src/Bookings.tsx`, `apps/web/src/Settings.tsx`, `apps/web/src/AppSettings.tsx`, `apps/web/src/NotificationSettings.tsx`, `apps/web/src/Account.tsx`, `apps/web/src/Team.tsx`, `apps/web/src/Feedback.tsx`, `apps/web/src/workspace.css`, `apps/web/src/activity.css`, `apps/web/src/library.css`, `apps/web/src/guided-pages.css`, the approver/requester requests page and its CSS | Match the mock's `renderCreate`, `renderAiComposer`, `renderEditor`, `renderApps`, `renderBusiness`, `renderBookings`, `renderSettings`, `renderSupport` and `renderMyRequests`. The AI model page keeps A1's Thinking and A7's read-only view for lower plans. |
| R5. Admin console and full check | `neon/r5-blocks-admin-verify`, decision 0163 | `apps/web/src/Admin.tsx`, `apps/web/src/Admin.test.tsx`, `apps/web/src/AdminAi.tsx`, `apps/web/src/AdminFeedback.tsx`, `apps/web/src/AdminTwoFactor.tsx`, `apps/web/src/admin-main.tsx`, `apps/web/src/admin.css`, `apps/web/src/workspace-admin.css`, `e2e/admin.spec.ts`, `docs/how-it-works.md`, `PROJECT.md` | The mock's `renderAdmin` ops shell with its tabs, plus 2FA setup, the code prompt and the recovery codes in the same style. Then the full check: `pnpm lint`, `pnpm typecheck`, `pnpm test`, the full `pnpm e2e`, and a visual pass at 1440 px, 1280 px and 390 px in Light, Dark and reduced motion on a disposable stack. |

## Risks and guardrails

- `apps/web/src/lib/run-flow.test.ts` parses the two `:root` blocks in `styles.css` with strict regexes and checks WCAG AA contrast. Keep their shape and run the test before committing R1.
- `apps/web/src/lib/locale-coverage.test.ts` fails on any new English `t(...)` text without a Taglish entry. Add the Taglish in the phase's own locale file.
- `e2e/navigation.spec.ts` checks exact computed background colours and the 228 px sidebar. R2 updates those assertions on purpose, and R1 must not change them by accident.
- A worktree path contains `.claude` or a dot folder; Express `send` refuses those paths, so serve files with `sendFile(name, { root })`. This only matters if a phase touches the API, which it should not.
- No new npm packages. Every animation uses CSS plus the small hooks in `src/lib/motion.ts`.
- After R5, Claude runs the security review of the admin console, admin host and 2FA on the restyled code (the owner's order: restyle first, then the review, then deploy).
