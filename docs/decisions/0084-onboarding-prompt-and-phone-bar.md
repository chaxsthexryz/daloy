# 0084. A setup card instead of a forced redirect, and an action bar that follows the keyboard

## Context

A new owner should find onboarding without being trapped in it, and on a phone the primary action must stay reachable while the keyboard is open.

## Options

1. Redirect every new account to `#/onboarding` after sign-up. Every existing end-to-end test and every other open phase registers an account and expects Automations.
2. Show a card at the top of Automations: "Start setup" for a new owner, "Resume setup" after "Save and close", with "Not now" to hide it.
3. For the keyboard: rely on `position: sticky`, which stays behind the keyboard on Android Chrome (the layout viewport does not shrink), or read the visual viewport and lift the bar.

## Decision

Option 2 and the visual viewport. The card shows only for an owner whose onboarding status is `not_started` or `in_progress`. "Not now" calls `POST /onboarding/dismiss`, which keeps the answers; `#/onboarding` still resumes them.

On phones the action bar (Back, Next) is fixed to the bottom edge. `Onboarding.tsx` sets `--ob-kb` from `window.visualViewport` (the height the keyboard covers), and the bar sits at `bottom: var(--ob-kb)`. Enter in the name field submits the form, as the keyboard's Go key does. The console's quick menu is hidden on this page, because it would sit under the bar; "Save and close" is the way out.

## Consequences

- A new owner can ignore the card. The roadmap's acceptance test (a new seller reaches a draft in three screens) holds for anyone who taps Start setup.
- The e2e test shrinks the viewport to stand in for the keyboard. It proves the bar stays inside the viewport, not that a real keyboard behaves the same. The owner should check once on a real phone.
- A later phase can turn the card into a redirect by changing one line in `App.tsx`, once the other specs expect it.
