# 0047: Model names are API ids, not display names

## Context

The AI model page took any text as the model name and saved it. A DeepSeek account saved `DeepSeek-V4.1-Flash-1017`, the label its dashboard shows next to the key. Every later call failed with HTTP 400, and the console said only "The provider answered with HTTP 400", which names neither the mistake nor the fix. DeepSeek's API serves two names: `deepseek-flash` (shown as "DeepSeek-V4.1-Flash") and `deepseek-v4-pro`. Another provider may answer 404 for the same mistake, and some answer 400 for other reasons, so the status alone is not enough to tell an operator what to do.

## Options

1. Keep the field free text and improve only the error message. The bad name stays in the row and every run keeps failing until someone edits it.
2. Map display names to ids on save. That needs a table of every provider's labels, which goes stale and is wrong for models added later.
3. Ask the provider which ids it serves (`GET /models`, already read by `listModels()`) and use that list twice: to fill the picker on the page, and to refuse a name that is not on it.

## Decision

Option 3, in `apps/api/src/settings.ts` and `apps/web/src/Settings.tsx`.

- `POST /settings/ai/models { preset, apiKey? }` answers with the ids the provider serves. The key is the one typed on the page, or the saved one (`presetConnection()` in `packages/db/src/ai-settings.ts`), encrypted like every other key and never returned. Session, owner only, 10 requests a minute.
- The page fills the model picker from that answer instead of the fixed suggestions, so the ids are the ones the provider will accept. A typed key is read on blur, so the list appears before saving. "Other model..." stays for a name the list does not show.
- `PUT /settings/ai` checks a hosted model name against that list and answers 400 with the ids it serves. The name is refused before it is saved, so a wrong one cannot reach an AI step.
- The test route does the same check on failure: a 400 or 404 from the provider is explained with the ids it serves, not just the status.
- The list is kept for five minutes under a hash of the key and the base URL, so saving twice asks once. Only the hash is stored, and a failed lookup is not remembered.
- A provider that cannot be reached does not block a save. The check only refuses a name it knows is wrong; an outage, a timeout after three seconds, or a rejected key leaves the save alone, and the test says what it always said.

## Consequences

- The console can offer a model the provider serves but this repository has not heard of, such as a new DeepSeek model, without a code change.
- Switching a provider needs one request to its `/models`. On a slow or blocked network the picker keeps the fixed suggestions and the save goes through unchecked.
- Names are matched exactly. A provider that serves ids differing only in case would need its own entry.
- A local model keeps a free text name, because its server may be off while the page is open, and the page already lists what it has.
- `docs/how-it-works.md` and `docs/threat-model.md` record the extra request and what it sends.
