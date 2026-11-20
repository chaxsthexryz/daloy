# 0073. Advanced pages: choices where the frames and the code differ

## Context

Rows W5 to W9 rebuild Advanced, AI model, Resources, API tokens and Secrets from approved Doop frames. Three places needed a decision because the frame and the working code did not match.

## Options and decision

1. The new token frame shows the value with its middle hidden (`dly_••••a91f`) next to a Copy button. A hidden value cannot be read or copied by a person who has no clipboard access (plain http, or a blocked permission). Decision: show the full value once, in a monospace box that selects on click, with the Copy button. The value is only in page memory, the list route never returns it, and a reload removes it.
2. The Replace secret frame shows the form filled in place on a desktop, while the old page also filled the form. Decision: keep that behaviour on a desktop (name filled, value focused, row highlighted, a line saying the old value stops working) and open the same form in a bottom sheet on a phone, where the form is not on the page. Delete uses a confirm dialog.
3. The Advanced frame has a "Menu" link above the title, and the page had no back link. Decision: Menu links to Settings (`#/settings`), the owner's workspace hub. On a phone the bottom Menu tab does the same job.

## Consequences

- The token value stays visible on screen until the owner reloads or creates another token, so the panel says to copy it now.
- Two forms (create token, save secret) render once, in the page on a desktop and in a sheet on a phone, so label lookups in tests stay unambiguous (same rule as decision 0072).
- `ConfirmSheet` in `Sheet.tsx` is the shared yes or no dialog for revoke and delete. `prompt()` and `confirm()` are gone from these pages.
