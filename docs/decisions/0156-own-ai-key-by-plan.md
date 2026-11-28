# 0156. Own AI key only on Business plans and up

## Status

Accepted

## Context

Any workspace could save its own key for Gemini, OpenAI, OpenRouter or DeepSeek. The owner decided that bringing your own key is a feature of the higher plans. Preview, Pilot and workspaces without a plan use the shared AI model that the platform admin sets (decision 0151), or the `LLM_*` env vars when none is set. Some workspaces already saved a hosted choice before this rule.

## Options

- Delete the saved hosted rows and keys of workspaces on lower plans. It is simple, but an upgrade or a plan mistake would lose keys the owner pasted, and deleting is not reversible.
- Leave existing choices working until the owner changes them. The rule would then depend on when a workspace signed up.
- Check the plan when a choice is saved and again when it is used, and leave the rows alone.

## Decision

`canUseOwnAiKey(plan)` in `packages/db/src/ai-settings.ts` is true for `business`, `business_plus` and `concierge`, and false for `preview`, `pilot` and no plan (null).

Saving: `saveAiSettings()` throws `OwnKeyNotAllowedError` for any preset other than `local` when the workspace's plan does not qualify. `PUT /settings/ai` and `POST /settings/ai/models` answer 403 with the same message, checked before any provider is contacted, so the models route cannot be used to test a key either. The `local` preset stays allowed for everyone, because it means the shared or env connection.

Using: `aiConnection()` returns `sharedConnection()` for a workspace on a lower plan, whatever it saved. That covers a hosted choice made before this change, a downgrade, and a saved `local` choice (its model name and thinking level are ignored, as the admin sets the model and the A2 per-workspace override sets thinking). No row is deleted or changed, and the keys stay encrypted in `ai_keys`, so upgrading to Business restores the saved choice with its keys.

Reading: `GET /settings/ai` adds `ownKeyAllowed`. For a lower plan `current` is the shared model in use and the saved rows are not sent. The AI model page then shows only that model, read-only, with one line about the Business plan. The provider choices, key field, Thinking setting and Save are hidden.

## Consequences

- A pilot workspace that chose Gemini or a different local model name now runs on the shared model. The admin can see which workspaces this affects with a read-only query on `ai_settings` joined to `users.plan`.
- A downgraded workspace keeps its keys at rest. Anyone with the secrets key and database access could still decrypt them, as before.
- The worker needs no change. It already calls `aiConnection()` for every AI step.
- The admin sets thinking for a lower plan through the A2 override on `/admin`, since the owner can no longer set it.
- The Test button is hidden for lower plans because the page offers no choice to test. The admin tests the shared model from `/admin/ai`.
