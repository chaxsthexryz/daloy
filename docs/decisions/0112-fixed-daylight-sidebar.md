# 0112. Fixed 228 px Daylight Minimal sidebar and Quick Jump palette

## Context

The earlier desktop navigation used a 64 px dark rail that widened to 232 px on hover after a 250 ms delay and hid labels, the AI meter text and Sign out until expanded. Moving across the rail could feel abrupt, and discovering pages meant reading every group or using browser bookmarks.

## Options

1. Keep the collapsible hover rail and add a manual collapse toggle.
2. Replace the desktop rail (`>= 800 px`) with a permanently fixed 228 px Daylight Minimal sidebar, a sliding hover pill behind hovered items, always-visible AI usage and Sign out controls, and a `Cmd/Ctrl+K` Quick Jump modal scoped to the signed-in role.

## Decision

Option 2.

- `apps/web/src/Nav.tsx` and `apps/web/src/console-shell.css` remove `OPEN_DELAY`, `CLOSE_DELAY`, hover/focus expand timers and `data-expanded`. On screens at least 800 px wide, `.sidebar` stays fixed at `228 px` (`var(--sb-w)`) using `--sidebar-bg` and `--border-hairline` in both Light and Dark themes.
- `useSlidingPill()` from `apps/web/src/lib/motion.ts` drives `.rail-hover-pill` behind hovered or focused sidebar links, with transitions disabled under `prefers-reduced-motion: reduce`.
- `apps/web/src/CommandPalette.tsx` provides a modal Quick Jump dialog triggered by `Cmd+K` / `Ctrl+K` or the sidebar `Ctrl K` button, filtering `quickJumpItems(role, t)` by label or group and navigating on `Enter` or click.
- Mobile viewports under 800 px keep the existing bottom bar and full-screen sheet menu behaviour.

## Consequences

- Every desktop navigation label, the AI usage meter and Sign out remain readable without hovering or toggling a rail.
- `e2e/rail.spec.ts` and `e2e/navigation.spec.ts` now assert the fixed 228 px sidebar and `Cmd/Ctrl+K` Quick Jump instead of hover expansion from 64 px.
- Onboarding (`Onboarding.tsx`, `onboarding.css`) stays outside `<Shell>` and is untouched.
