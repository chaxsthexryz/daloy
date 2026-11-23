# 0106. Hosted models get the full Build with AI prompt

## Context

Build with AI (chat and the one-shot draft) describes workflows to the model with one shared spec. To fit Ollama's default context of 4,096 tokens, that spec left out twelve step types (sms, meta_reply, discord, google_docs, the Shopify and payment steps, Airtable, Notion, Trello) and the meta_dm, payment, shopify_order and email triggers.

The AI stress test (`pnpm --filter @daloy/api ai:stress`, 61 seller requests on deepseek-flash) showed what that cost on a hosted model. Only 30 of 61 cases built what was asked:

- "Text them", "reply to my page messages" and "when a customer pays" became http, telegram or webhook steps, because the model had never heard of the right ones.
- Three replies were thrown away because the model closed the JSON object once too often (`...]}}}`).
- The chat asked a question in 93% of cases, including complete requests.
- A request to make Shopify products from a form looped on the same question until it failed, because lint refuses form values in a Shopify step and the model was not told why.

## Options

1. Send every model the full spec. A small local model would then overflow its context and fail outright.
2. Keep the short spec and add a second "app picker" call. That doubles the wait and the cost of every message.
3. Send the full spec only to hosted models, and keep the short one for local ones.

## Decision

Option 3. `isLocalModel` in `packages/db/src/ai-settings.ts` treats Ollama and any server on this machine as local. Both AI routes pass `full: !isLocalModel(connection)` to the prompt builders.

The full prompt adds:

- The left-out steps and triggers, with their payload fields.
- Rules for picking the step the person names (SMS means sms, page messages mean meta_dm and meta_reply).
- Where an order with no named source comes from.
- What to do when Shopify steps are asked to take form values.
- Saying plainly when an app such as TikTok or Viber has no step.
- Drafting complete requests without questions.

`extractJson` now also tries ending at the earlier `}` characters when the outermost object does not parse.

## Consequences

- On deepseek-flash, the last two full runs passed 61 and 60 of 61 cases. The chat asked a question in 41% and 52% of cases (`docs/ai-stress-2026-11-23.md`).
- A hosted prompt is about 5,700 input tokens per call, up from about 3,300. On deepseek-flash a whole conversation still costs well under one peso.
- Local models keep the short prompt, and its size tests still hold it under the 4,096-token context. They still cannot draft SMS, Messenger or Shopify workflows.
- Prompt changes should be checked with the stress test, since unit tests cannot measure what a model does with the words.
