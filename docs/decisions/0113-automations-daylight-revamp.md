# 0113. Automations dashboard Daylight Minimal revamp and status sync fixes

## Context

The live console audit of the Automations page found three layout and state issues alongside the visual gap from the Daylight Minimal prototype:

1. A live workflow whose newest run failed showed a red `Problem` dot in the table row while the inspector panel header showed green `On`, because `Panel` read `statusOf(w)` without checking `stateKey(w)` or open reviews.
2. Long two-line titles overlapped neighbouring text when the inspector opened, because `.ops-row td, .ops-row th` used a fixed `height: 58px` with `display: flex` directly on `<th>` and kept the `Last run` column visible beside the inspector.
3. Paused toggles lived only inside the inspector panel with no inline quick switch or undo path.

## Options

1. Patch only the CSS heights and panel status text while keeping the old filter row and inspector layout.
2. Unify row and panel status derivation in `displayStatus(w, reviewCount)`, fix table cell height and `Last run` hiding when the inspector is open, and apply the Daylight Minimal layout with `useCountUp`, segmented status tabs, inline `role="switch"` pause/resume with an undo toast, staggered row entrances, and rising sparkline bars.

## Decision

Option 2.

- `apps/web/src/lib/automations.ts` exports `displayStatus(w, reviewCount)`, used by both `Row` and `Panel` in `Automations.tsx` so `Needs you` and `Problem` match across the table dot and inspector header.
- `Automations.tsx` wraps `.c-name` inside `.ops-name-cell`, removes any unlabeled row buttons, keeps the accessible `Status:` and `Trigger:` controls synchronized with the gliding `.ops-seg` segmented tabs, animates numeric KPI counts with `useCountUp`, adds an inline `role="switch"` pause/resume column (`.c-toggle`) with a 6-second bottom-right undo toast (`.ops-toast`), and applies `.motion-stagger-row`, `.motion-spark-bar`, and `.motion-sheet`.
- `apps/web/src/automations-ops.css` maps `.ops` to Daylight Minimal Light and Dark tokens while keeping `main.ops` dark background `#131a30`, sets `height: auto; min-height: 58px` on table cells, and hides `.c-last` on desktop while the inspector is open.

## Consequences

- Row status dots and inspector badges always agree on `Needs you`, `Problem`, `Paused`, `Draft`, `Off`, and `On`.
- Two-line automation titles expand their row cleanly without overlapping the subtitle or neighbouring rows.
- Owners can pause or resume a live automation directly from the table and revert accidental clicks from the undo toast.
