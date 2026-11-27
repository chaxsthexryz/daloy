# 0151. Shared AI model set by the platform admin

## Status

Accepted

## Context

The shared model, the one a workspace uses when it saved no AI model of its own or chose "Local model", came only from the `LLM_*` env vars. Changing it meant editing `.env` and restarting. The platform admin console (phase A3) needs to change it from the page, with a key, a model and a thinking level, and to raise or lower thinking for one workspace.

## Options

- Keep the env vars and add a restart-free reload. It would still leave the key in a file on the server.
- A single `platform_ai` row, edited through `/admin/ai`, with the env vars as the fallback.
- One row per workspace. That is `ai_settings`, which already exists.

## Decision

A single-row table `platform_ai` (the primary key is pinned to 1 by a CHECK) holds the preset, the model, the thinking level and an optional key. The key is encrypted with the secrets key like `ai_keys`, with the fixed owner `platform` and the name `platform_ai_key`, so it never decrypts as a workspace's key. The last four characters are stored in `key_last4` so the page can say which key is saved without decrypting it. A key belongs to one preset: saving a different provider without a new key is refused, and a save without a key for the same provider keeps the old one.

`users.ai_thinking` (null, or off, low, medium, high) is the admin's thinking level for one workspace on the shared model. It wins over `platform_ai.thinking`; null follows the platform level.

`sharedConnection()` in `packages/db/src/ai-settings.ts` is the shared path of `aiConnection()`. With a `platform_ai` row it returns that preset's fixed base URL, its image types, its model and its decrypted key, with `thinkingControl("openai", baseUrl, override ?? platformLevel)`. A "local" preset in the row means the env server with the saved model name. With no row it is the env connection as before.

Where the shared key goes: only to a workspace whose plan is set and is not `preview`, and only with `SHARED_LLM_KEY=open`. This is the same gate as the env key (decision 0035), now covering the saved key too. A saved key is the admin's consent to have a key stored, not to spend it on every sign-up, so the operator's switch stays in force. Without the key a workspace still gets the shared model name and URL, and the provider answers 401 as it would for the env connection. `GET /admin/ai` reports `keyShared` so the page can say that the key is held back.

A workspace with its own hosted key keeps its own provider, model and thinking level. A workspace that chose "Local model" while a shared model is saved gets the shared model and the admin's thinking level, because "Local model" has always meant the shared server. Its own `ai_settings.thinking` and model name are ignored in that case. The admin override applies to the env connection when no `platform_ai` row exists, so an override never silently does nothing.

Routes, all behind `AdminGuard` (404 for non-admins, own-origin check on changes): `GET /admin/ai`, `PUT /admin/ai`, `POST /admin/ai/test` and `PUT /admin/workspaces/:id/ai-thinking`. The test makes the same sample classify call as `/settings/ai/test`, as a workspace on a plan would, so it shows what workspaces get. It does not count against any workspace's AI usage. Each save writes an `admin_actions` row (`ai` or `ai_thinking`) with the values before and after. The row says whether the key changed (`keyChanged`) and never holds the key.

## Consequences

- The model, key and thinking level change without a restart. The worker reads the row on every AI step.
- The `admin_actions.action` CHECK gained `ai` and `ai_thinking` (migration `0061_platform_ai`).
- The PUT does not check the model name against the provider's list the way a workspace save does. The Test button reports a wrong name.
- A deleted `platform_ai` row (by SQL only, there is no route) returns the installation to the env vars.
- The open question of every plan using its own key is not decided here.
