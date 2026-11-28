# 0162. Console Blocks Secondary Surfaces

Status: Accepted

## Context

Phase R1 established the Console Blocks design system in `styles.css` and `motion.css` with Geist (`--font-sans`), light and dark theme tokens (`--bg`, `--surface`, `--border-soft`, `--accent`), a 13px minimum text size floor (`--text-xs`), and reduced-motion-safe transitions (`--ease`, `--ease-spring`). Secondary pages and components still referenced `"Inter"` fallbacks, legacy light-only palette hexes, sub-13px labels, and older card or list styling.

## Decision

Align all secondary Console pages and components with the Console Blocks visual language and token contract while preserving every existing route, accessible role/label hook, and contrast invariant:

1. **Font and base tokens**: Remove `"Inter"` font overrides across `activity.css`, `workspace.css`, `apps-design.css`, `editor.css`, `auth.css`, `creation.css`, `ai-workspace.css`, and `operations.css` so secondary pages inherit `--font-sans` (Geist). Replace hardcoded light-only background overrides in `creation.css` and `operations.css` with shared light and dark tokens.
2. **Text size floor and motion**: Raise sub-13px typography across owned stylesheets to `var(--text-xs, 13px)`. Keep `.a7-node-kicker` wrapping safely (`white-space: normal; overflow-wrap: anywhere`) so 13px kickers do not clip at 50% Fit zoom. Use `--ease` and `--ease-spring` transitions without overshoot and include `@media (prefers-reduced-motion: reduce)` fallbacks.
3. **Activity, Workspace, Bookings, and Support surfaces**: Update `.act-*` and `.wk-*` cards to 12px surfaces over the `--bg` canvas. Convert the Bookings agenda list to separated queue cards with status pills and an active dot instead of a solid blue highlight box. Render notification preferences as accessible native checkbox switches (`.wk-switch-*`), team member rows with avatar initials (`.wk-avatar`), and feedback history items with `.pill` status badges. Update `MyRequestsPage` (`.mr-*` in `auth.css`) to match Console Blocks cards and tables.
4. **Creation, Apps, Business, and Editor surfaces**: Style template cards (`.lib-card`), Build with AI chat/composer panels, `#ai-logs-drawer` (opaque with `z-index > 30`), Apps 3-column directory cards, and Business tabs cleanly on Console Blocks surfaces while keeping dark-mode logo softening and WCAG AA disabled button contrast (`opacity: 1`). Keep `.a7-editor` and `:root[data-theme="dark"] .a7-editor` hex definitions (`--a7-bar`, `--a7-bar-off`) intact at line start for automated contrast verification.

## Consequences

Secondary routes now share a consistent Geist typographic hierarchy, light/dark surface contrast, 13px legibility floor, and responsive 390px mobile layout without modifying API endpoints, database schemas, or E2E test selectors.
