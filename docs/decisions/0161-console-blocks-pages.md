# 0161. Console Blocks layout for Home, Inbox, and Automations

## Status

Accepted

## Context

Phase R1 (`0159-console-blocks-tokens.md`) introduced the Geist typeface, Console Blocks surface and status tokens, and shared block primitives while enforcing a 13 px (`var(--text-xs)`) minimum text size across the web console. Phase R3 applies the Console Blocks structure from `docs/design/console-blocks-preview.html` to the three primary staff operational pages (`Home`, `Inbox`, and `Automations`) without modifying API endpoints, database schemas, or existing E2E contracts.

## Options

- Replace all markup and selectors across `Home`, `Inbox`, and `Automations` with the preview HTML directly, including static demo charts and new selector names. That would invent unsupported `/home` time-series data, break existing `e2e/automations.spec.ts`, `e2e/navigation.spec.ts`, `e2e/ux-journey-g1-g5.spec.ts`, and `e2e/visual-dark-mobile.spec.ts` assertions, and reintroduce text smaller than 13 px.
- Restyle all three pages as Console Blocks using only real API payloads (`HomePayload`, `/inbox`, `/workflows`, `/workflows/overview`, `/runs`, `/usage`) while keeping existing accessible names, headings, and E2E selectors intact, and setting `13px` (`var(--text-xs)`) as the floor everywhere.

## Decision

- **Home (`apps/web/src/Home.tsx`, `apps/web/src/home.css`, `apps/web/src/Home.test.tsx`)**: Keep `<PageHead>` (`Today`), owner header actions (`New automation`, `Build with AI`, `Automations`), and `OnboardingPrompt`. Replace `.hm-top` with a 4-card `.hm-kpi-grid` powered strictly by `data.needsYou`, `data.problems`, `data.running`, and `data.recentRuns`, where each card is a whole-card stretched link (`.hm-kpi-card { position: relative }`, `.hm-kpi-foot::after { content: ""; position: absolute; inset: 0 }`) with `:has(.hm-kpi-foot:focus-visible)` outline rings. Render `.hm-bento` block cards (`Needs you` and `Problems` as `<h2>` sections) above the `What ran` block card containing live workflow chips, `Recent activity` search, inline `AskRequest`, and `.act-table`. Style the non-staff fallback as a Console Block card.
- **Inbox (`apps/web/src/Inbox.tsx`, `apps/web/src/inbox.css`)**: Convert `.ib-filters` into the Console Blocks `.p-seg` segmented bar keeping exact filter labels and counts (`All`, `Conversations`, `Receipts`, `Approvals`, `Needs check`). Restyle `.ib-list` into separated rounded `.ib-queue-list` / `.queue-btn` cards with soft selection tint, `.active-dot`, and `.pill` kind badges. Restyle `.ib-drawer` as a Console Block card featuring recessed `.ib-facts`, a calm `.takeover-bar` banner for conversations (`Take over` / `Hand back to bot` / `Open full thread`), and existing receipt, approval, check, and phone `<Sheet>` flows.
- **Automations (`apps/web/src/Automations.tsx`, `apps/web/src/automations-ops.css`)**: Add the 3-card `.quick-grid` strip (`Templates`, `Build with AI`, `Connected apps`) for owners above the KPI band while preserving the `No automations yet.` empty state. Restyle `.ops-kpi-band`, `.ops-card`, `.ops-toolbar`, `.ops-seg`, `.ops-table`, `.ops-badge`, `.bars`, and `.ops-panel` into Console Blocks while preserving `main.ops` dark background (`#09090b`), `.ops-kpi-cell.needs` and `.ops-kpi-cell.problems` `.ok` zero-state colors and `"all healthy"` / `"maayos lahat"` copy, `.dot.problem`, `.panel-status` text, and desktop/mobile panel behavior. Replace remaining `"Inter"` references with `var(--font-sans)` and keep all text at `13px` or larger.
- **Locale and motion (`apps/web/src/lib/locale-ops.ts`)**: Add Taglish translations for all new literals in `locale-ops.ts`, avoid `--ease-snappy`, and provide `prefers-reduced-motion: reduce` fallbacks on all transitions and animations.

## Consequences

- `Home`, `Inbox`, and `Automations` share a unified Console Blocks surface hierarchy, 13 px text floor, keyboard focus rings, and dark-mode contrast without inventing fake data or breaking existing E2E hooks.
- `apps/web/src/Home.test.tsx` verifies whole-card stretched-link markup, focus-ring CSS rules, real `/home` payload rendering, zero states, and non-staff fallback rendering.
