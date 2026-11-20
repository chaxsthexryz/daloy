# 0072. Team confirmations use one native dialog that becomes a bottom sheet on a phone

## Context

The Team page confirmed removal with `confirm()` and changed roles with a select in the table. The approved W1 frames show a bottom sheet on a phone ("Remove a member") and a Change role button on desktop. The handoff asks for dialogs where the code used `confirm()`.

## Options

1. Keep `confirm()` and the inline select, and only restyle the page.
2. Add a dialog library.
3. Write a small `Sheet` on the native `<dialog>` element.

## Decision

Option 3. `Sheet` calls `showModal()`, so the browser traps focus, closes on Escape and returns focus to the button that opened it. CSS makes it a centered card at 800px and wider and a bottom sheet below that, using the shared motion variables and no animation under `prefers-reduced-motion`. Change role, Remove and the phone Invite form use it. Which layout shows (the role button label, the Remove button, the Invite button) follows the same 800px breakpoint through `usePhone`, because both layouts would otherwise put two copies of the invite form in the page and break label lookups.

## Consequences

- No new dependency. Playwright finds the dialog by role and name.
- Later rows that replace `confirm()` or `prompt()` (resource rename, token revoke, secret delete in W7 to W9) can reuse `Sheet`.
- The role change is Save and Cancel, not instant, so a mis-click on a radio does not change access.
- The phone list hides the per-row Remove button. Remove is reached through the role sheet, as the phone frame shows no Remove button on the rows.
