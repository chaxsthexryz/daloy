# 0111. Daylight Minimal tokens, Logo 28 and zero-dependency motion primitives

## Context

The console revamp (phases D1 to D5) moves the staff console from a collapsible dark hover rail to a fixed 228 px Daylight Minimal layout in Light and Dark themes. Before phase D2 (sidebar), D3 (Automations) and D4 (secondary pages and editor) edit individual views in parallel, every branch needs the same design tokens, brand icons and motion helpers.

## Options

1. Add a third-party React animation package (such as Framer Motion or Motion One) for count-up KPIs, sliding hover pills, staggered list entrances and spring sheets.
2. Keep zero new npm dependencies and implement CSS transitions and keyframes in `apps/web/src/motion.css` paired with small React hooks in `apps/web/src/lib/motion.ts`.

## Decision

Option 2.

- Brand marks in `apps/web/public/navigation.svg#mark` and `apps/web/public/logo.svg` use Logo 28 (Quarter Tiles, `viewBox="0 0 120 120"`) with `currentColor` so CSS sets the blue brand tint. The Settings icon in `apps/web/public/navigation.svg#settings` changes from a sun shape to a gear outline.
- `apps/web/src/styles.css` adds Daylight Minimal tokens (`--sidebar-bg`, `--daylight-bg`, `--subtle`, `--border-hairline`, `--border-strong`, `--fg`, `--fg-muted`, `--blue`, `--blue-deep`, `--blue-soft`, `--red`, `--red-soft`, `--green`, `--green-soft`, `--amber`, `--amber-soft`, `--sb-w: 228px`, `--ease-spring`, `--ease-snappy`) in both `:root` and `:root[data-theme="dark"]`, while keeping the existing `--bg`, `--surface`, `--muted`, `--ok`, `--danger`, `--warn` and `--accent` tokens intact so `run-flow.test.ts` contrast checks and current console views keep passing.
- `styles.css` also sets `line-height: 1.25` and `vertical-align: middle` on native `select` elements, improves `:disabled` button contrast, and imports `./motion.css`.
- `apps/web/src/motion.css` extends the existing motion classes with `.motion-pill`, `.motion-stagger-row`, `.motion-spark-bar`, `.motion-switch`, `.motion-toast` and `.motion-sheet`, with `@media (prefers-reduced-motion: reduce)` disabling all animations and transitions.
- `apps/web/src/lib/motion.ts` provides `usePrefersReducedMotion`, `useCountUp`, `useSlidingPill` and pure interpolation and measurement helpers.
- `signOut()` in `apps/web/src/App.tsx` resets `location.hash = "#/"` after `POST /auth/logout` so signing out from a deep route does not leave a stale hash on the sign-in screen.

## Consequences

- D2, D3 and D4 share one token vocabulary and motion layer with no new npm dependencies or bundle growth.
- `lib/run-flow.test.ts` continues to validate Light and Dark state colour contrast against `:root` and `:root[data-theme="dark"]`.
- Reduced motion users get instant KPI numbers and zero CSS transitions or keyframe animations.
