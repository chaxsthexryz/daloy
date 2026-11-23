# 0114. Secondary console pages, auth and editor Daylight Minimal polish

## Context

After D1 (tokens and motion), D2 (fixed 228 px sidebar) and D3 (Automations dashboard), the secondary console views (Activity, Bookings, Receipts, Library, Build with AI, Apps, Team, Settings, Account, Business setup, Advanced, Sign in, and the Editor) still used mixed pre-revamp palettes, unstyled native file inputs, plain grey letter tiles for apps without third-party SVGs, and tight node header spacing in the visual Editor.

## Options

1. Leave secondary pages untouched and apply Daylight Minimal only to the sidebar and Automations table.
2. Harmonize the eight secondary stylesheets (`workspace.css`, `activity.css`, `auth.css`, `ai-workspace.css`, `apps-design.css`, `library.css`, `receipts.css`, `editor.css`) onto Daylight Minimal Light and Dark tokens while fixing file inputs, letter-tile tints, connected app header count, disabled buttons, and editor node header spacing.

## Decision

Option 2.

- `workspace.css`, `activity.css`, `ai-workspace.css`, `apps-design.css`, `library.css`, `receipts.css` and `editor.css` map their local tokens onto `--daylight-bg`, `--subtle`, `--border-hairline`, `--border-strong`, `--fg`, `--fg-muted`, `--blue`, `--blue-deep`, `--blue-soft`, `--green`, `--red` and `--amber` in both Light and Dark themes, while `auth.css` keeps the signed-out Light split layout with Daylight Minimal ink, surface and accent tokens.
- `Receipts.tsx` and `BusinessSetup.tsx` add `className="file-input"` to their native `<input type="file">` controls, styled via `::file-selector-button` in `receipts.css` and `apps-design.css` so Playwright `setInputFiles` and label selectors keep working unchanged.
- `apps-design.css` and `editor.css` add subtle Light and Dark brand tints on `.app-mark[data-kind="letter"][data-mark="..."]` for `unisms`, `paymongo`, `gcash`, `messenger` and `instagram`, keeping the 14 SVG files in `apps/web/public/logos/` unaltered (decision 0085).
- `Apps.tsx` computes `activeTotal` (`state(key) === "Connected"`) for the `{count} of {total} connected` header while keeping `total` aligned with the `Connected {count}` tab and directory group.
- `ai-workspace.css` dims `:disabled` buttons clearly, and `editor.css` aligns `.a7-node-row` with ellipsis and fixed `node-id` width so step labels and ids do not collide.
- `Onboarding.tsx`, `onboarding.css`, `lib/onboarding.ts` and `e2e/onboarding.spec.ts` remain untouched.

## Consequences

- Every console view shares consistent Light and Dark Daylight Minimal surfaces, borders, buttons and form controls.
- Native file uploads and all 14 third-party app SVG marks preserve their existing accessibility, test hooks and brand-permission rules.
