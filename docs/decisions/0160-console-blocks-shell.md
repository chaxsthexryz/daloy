# 0160. Console Blocks shell, sidebar tree, bell, palette, and toasts

## Status

Accepted

## Context

Phase R2 of the Console Blocks restyle updates the shared application frame (`Nav.tsx`, `CommandPalette.tsx`, `LiveEvents.tsx`, and their CSS) to match the layout and visual hierarchy of `docs/design/console-blocks-preview.html` while keeping all role scoping, Taglish translations, minimum 13 px typography, reduced motion fallbacks, and Playwright E2E compatibility intact.

## Options

- Replace the six primary links in `#main-menu` with button-based collapsible parents as in the static mock. That would break `#main-menu > a` count checks (`6` for owners, `4` for operators, `2` for approvers/requesters) and primary link assertions across the E2E suite.
- Keep the six primary `<a>` links as direct children of `#main-menu` and place `.rail-group` containers with accessible expand/collapse toggle buttons and `.rail-children-wrap` sub-links alongside them.

## Decision

- **Sidebar structure and tree state** (`apps/web/src/Nav.tsx`, `apps/web/src/Nav.test.tsx`, `apps/web/src/console-shell.css`):
  - Keep `#main-menu > a` strictly at the six primary destinations for owners (Home, Inbox, Bookings, Automations, Business, Settings), four for operators, and two for approver/requester.
  - Add `.rail-search` above `#main-menu` (`Search` with `⌘K` badge) to open `CommandPalette`, and `Work` / `Workspace` group labels inside `#main-menu`.
  - Add owner-only `.rail-group` sub-trees for `Bookings` (Calendar, Rooms and slots), `Automations` (Build with AI, Templates), and `Business` (Details and branding, Knowledge, Apps, Team). Each group has an accessible toggle button (`aria-expanded`, `aria-controls`, `aria-label`) that opens automatically when its section is active (`initialTreeState`, `syncTreeForHash`) and can be toggled by users (`toggleTreeGroup`). Sub-links mark active state with `data-active="true"`, never `aria-current="page"`, and collapsed sub-trees are marked `inert` and `aria-hidden="true"`.
  - Keep the desktop sidebar fixed at `228px` with `var(--bg)` surface (`#fafafa` light, `#09090b` dark) and hairline border.
- **Usage card and account footer** (`apps/web/src/Nav.tsx`, `apps/web/src/console-shell.css`):
  - Restyle `.rail-usage` as a card with the plan name, progress bar (`role="progressbar"`), usage count, and `Manage plan` button.
  - Restyle `.rail-account` with the `.rail-avatar`, display name (`title={user.email}`), inline role label, `Account` and `Sign out` actions, and the `?` `Help and support` menu button.
- **Mobile drawer, Quick Jump, Bell, and Toasts** (`apps/web/src/console-shell.css`, `apps/web/src/CommandPalette.tsx`, `apps/web/src/live-events.css`, `apps/web/src/toast.css`, `apps/web/src/lib/locale-workspace.ts`, `e2e/navigation.spec.ts`):
  - Restyle the mobile drawer above `.bottom-bar` with matching 13 px typography, 44 px minimum touch targets, zero horizontal overflow, and a header Quick jump button when the drawer is closed.
  - Align `CommandPalette`, `NotificationBell`, and `.rare-toast` to Console Blocks surface, border, `var(--shadow-overlay)`, Geist typography, `>= 13px` (`var(--text-xs)`) text floor, and `prefers-reduced-motion: reduce` fallbacks without overshooting easing.
  - Add Taglish translations in `locale-workspace.ts` and update `e2e/navigation.spec.ts` to account for the keyboard-accessible Automations sub-tree toggle button.

## Consequences

- Desktop and mobile navigation now share the Console Blocks visual language while preserving every existing role boundary, `aria-current="page"` contract, Taglish coverage test, and E2E selector.
