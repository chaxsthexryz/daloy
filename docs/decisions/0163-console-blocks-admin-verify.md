# 0163. Admin console ops shell, two-factor styling, and full restyle verification

## Status

Accepted

## Context

The admin console (`/admin`, phase A3, decision 0152) and its two-factor sign-in screens (phase A8, decision 0158) sit outside the workspace sidebar in their own standalone entry (`apps/web/admin.html`, `apps/web/src/Admin*.tsx`, `apps/web/src/admin.css`). Phase R5 brings `/admin` and its 2FA setup, verify, and recovery screens onto the Console Blocks restyle and completes full automated and responsive verification across R1 to R5.

## Options

- Leave `/admin` on the older Inter-typed rules while the rest of the console uses Geist and Console Blocks cards. That leaves the operator surface inconsistent with the workspace console and breaks uniform dark/light and 13 px minimum text standards.
- Restyle `admin.css`, `workspace-admin.css`, `Admin.tsx`, `AdminFeedback.tsx`, and `AdminTwoFactor.tsx` directly onto Console Blocks tokens (`--w-canvas`, `--w-bg`, `--w-line`, `--shadow-card`, `var(--font-sans)` Geist, `.pill` state badges, `.ad-seg` segmented filter bar, `.motion-page`) while preserving every existing label, role, accessible name, and API call.

## Decision

- **Ops shell and tiles (`admin.css`, `Admin.tsx`)**: switched `font-family` from Inter to `var(--font-sans)` (Geist), aligned `.ad-nav` (208 px sticky rail over `--w-canvas` with crisp surface-pill active links), `.ad-tile` 12 px Console Blocks KPI cards with visible focus outlines, structured `.ad-log` rows, `13px` (`var(--text-xs)`) minimum text sizes, and `prefers-reduced-motion: reduce` fallbacks.
- **State pills and feedback (`Admin.tsx`, `AdminFeedback.tsx`, `workspace-admin.css`)**: updated `RunsTab` and `AdminFeedbackTab` status pills to shared `.pill` classes (`ok`, `bad`, `warn`, `neutral`), added recessed `.ad-fb-reply` boxes and `.ad-seg` segmented filter controls matching the workspace Inbox and Automations style, and updated disabled button and file input tokens in `workspace-admin.css`.
- **Two-factor screens (`AdminTwoFactor.tsx`, `admin.css`)**: applied `.motion-page` to `.ad-gate-card`, styled `.ad-secret` and `.ad-codes` as bordered sunken monospace blocks at readable sizes, and kept every A8 form label, `autoComplete="one-time-code"` field, recovery code list, and sign-out action unchanged.
- **Full-suite integration fixes (`Home.tsx`, `Team.tsx`)**: rendered the duplicate card-head `Open Inbox` link on Home only when `needsYou.total > 0` so non-exact `"Inbox"` link selectors stay unambiguous on clean homes, and wrapped the bare member email in `<span>` beside `.wk-avatar` in `Team.tsx` so exact email text locators match cleanly.

## Verification

- `pnpm lint` and `pnpm typecheck`: passed cleanly.
- `pnpm test`: 277 test files, 3,429 unit, DB, worker, and API tests passed.
- `pnpm e2e`: all 152 Playwright end-to-end tests passed, including `e2e/admin.spec.ts`.
- Visual pass on the disposable stack (`1440x900`, `1280x800`, and `390x844` in Light, Dark, and `reducedMotion: "reduce"` across Home, Inbox, Automations, Business, Bookings, Settings, and Admin including 2FA setup/recovery/overview): verified Geist rendering, zero horizontal overflow, `#fafafa`/`#09090b` canvas themes, and `0s` reduced-motion transitions.

## Consequences

- The workspace console and `/admin` now share the same Geist typography, 13 px minimum text floor, Light/Dark contrast rules, and reduced-motion discipline with zero API or database modifications.
- Console Blocks restyle R1 to R5 is complete and ready for the post-R5 security review of the admin console, admin host, and 2FA before deployment.
