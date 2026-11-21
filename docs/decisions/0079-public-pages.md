# 0079. Public pages: server-rendered cards, one stylesheet, a browser gets the form back with its errors

## Context

The approved E7 to E10 frames show the public form, receipt, paused page and approval as cards that carry the business brand (logo, accent, name). The old pages were bare HTML with a few brand rules. A refused submission came back as JSON, which a visitor saw as raw text. The pages run under the helmet policy (`script-src 'self'`, inline styles allowed) and the embed route is framed by other sites.

## Options

1. Build the public pages in React inside the console bundle.
2. Keep server-rendered HTML and put the look in one inline stylesheet (`public-pages.ts`).
3. Link a shared stylesheet from the console build.

## Decision

Option 2. The pages stay plain HTML with no script, so they load fast on a phone, work without the console bundle and need no change to the policy. The stylesheet is inline so an embedded form needs one request. Inter loads from `/fonts/inter-variable.woff2` on the same origin and falls back to the system font.

A refused submission returns the form again with the visitor's answers (never files), the reasons beside each field and an alert, but only when the request prefers HTML (`Accept`, as a browser sends it). A caller that asks for JSON or sends `*/*` still gets the JSON 400 or 429, so existing API clients and tests are unchanged. Brand colours are re-checked as `#rrggbb` when written into the stylesheet, whatever the database holds.

## Consequences

- Two or more short fields (number, email) sit side by side on a wide page; on a phone every field is full width.
- The receipt shows the reference in a card and a "Received" label. Tests read the reference from `.ref`.
- The upload, over-quota and bad-field cases all use the same alert.
- A form behind a stale submission key still returns JSON for API callers and the alert for browsers.

## Approval page (E10)

The approval card is built by `approvalShell`. It carries the brand of the approval's own workspace (read with `pageBrand(workspaceId)` from the approval row) on the decision, sign-in, not-yours and answer-recorded pages. An unknown, used or expired link has no workspace, so it gets the plain Daloy page and nothing about any business. The pages still say nothing about the request except on the decision page for an allowed visitor. Expiry, single use and the named-approver check are unchanged: they live in `findPendingApproval` and `recordDecision`.
