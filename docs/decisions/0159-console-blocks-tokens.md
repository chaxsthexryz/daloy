# 0159. Geist font, tokens, and base components for Console Blocks

## Status

Accepted

## Context

The Console Blocks restyle (`docs/plans/console-blocks-restyle.md`, preview at `docs/design/console-blocks-preview.html`) moves the web console from Inter to Geist and introduces shared block primitives (pills, card icons, card action links, card shadows, and status tint tokens) across light and dark modes. Later phases (`R2` to `R5`) restructure the shell, Home, Inbox, Automations, secondary pages, and admin console on top of these shared tokens.

## Options

- Replace `styles.css` tokens and rules with the mock preview stylesheet directly. That would copy 10 to 12 px text sizes below the app floor (`13px`), break the `:root` and `:root[data-theme="dark"]` regex extraction in `apps/web/src/lib/run-flow.test.ts`, and alter sidebar or shell layout before `R2`.
- Keep existing token names, the two `:root` block structures, `--text-xs: 0.8125rem` (`13px`), and layout rules intact while switching `@font-face` and `--font-sans` to Geist, adding the mock colour/shadow/easing tokens and shared block primitives (`.card-ico`, `.card-link`, `.pill`, `.tnum`, `.mono`, `.live-pulse`), and removing overshooting `--ease-snappy`.

## Decision

- **Typography and preload** (`apps/web/index.html`, `apps/web/admin.html`, `apps/web/public/fonts/OFL-geist.txt`, `apps/web/src/styles.css`): copy `OFL-geist.txt` alongside the other font licences, preload `/fonts/geist.woff2`, register the Geist `@font-face` (`font-weight: 100 900`), and set `--font-sans` to Geist. Apply antialiasing and `font-synthesis: none` on `html, body`, keep `--text-xs: 0.8125rem` as the floor, and bump `.app-mark` and `.node-id` from `12px` to `var(--text-xs)`.
- **Tokens and base primitives** (`apps/web/src/styles.css`): add `--ok-bg`, `--warn-bg`, `--warn-dot`, `--bad`, `--bad-bg`, `--radius-card`, and `--shadow-card`, and align `--shadow-overlay` with the mock inside both `:root` and `:root[data-theme="dark"]` while preserving every token tested by `run-flow.test.ts` and `e2e/navigation.spec.ts`. Add `.card-ico`, `.card-link`, `.pill` variants, `.tnum`, `.mono`, and `.live-pulse`, and refine base `input`, `select`, `textarea`, `button`, `.card`, and `.tag, .state` controls without hover overshoot.
- **Motion** (`apps/web/src/motion.css`): remove `--ease-snappy`, replace it on `.motion-switch` with `--ease-spring`, align transition timings and offsets with the mock, add `@keyframes line-draw` and `@keyframes pulse-ring`, and include `.live-pulse` in the `prefers-reduced-motion: reduce` rule.

## Consequences

- Every console route now renders in Geist with consistent 13 px minimum text, focus rings, and block primitives ready for `R2` to `R4` in parallel.
- Existing `e2e/navigation.spec.ts` assertions and `run-flow.test.ts` WCAG AA contrast checks continue to pass without touching API, database, or route components in `R1`.
