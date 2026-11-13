# 0018: Thinking models and one key per provider

## Context

Thinking models write hidden reasoning before the answer, and that reasoning counts against `max_tokens`. Daloy's budgets are small on purpose (256 tokens for the console test, 1,024 for an AI step). A local Qwen3.5-4B spent about 300 tokens thinking on a one-word classify and returned empty content, which failed as "not valid JSON". Google's docs say the same about Gemini: thinking tokens count toward the output limit and can leave the answer empty, and Gemini 3 and newer models cannot turn thinking off.

Separately, `ai_settings` held one key per user. Picking the local model erased a saved Gemini key, so switching back meant pasting the key again.

## Options

Thinking:

1. Raise every token budget. Works for every provider, but a runaway reply costs more everywhere, and local non-thinking models gain nothing.
2. Per provider: turn thinking off where the server allows it, otherwise ask for less thinking and add headroom for it.

Keys:

1. One key column, kept when switching to a provider without a key. Still loses the key when switching between two hosted providers.
2. A table with one encrypted key per user and provider.

## Decision

- Thinking option 2, in one function (`thinkingControl()` in `packages/db/src/ai-settings.ts`):
  - A local OpenAI-compatible server (llama.cpp, vLLM) gets `chat_template_kwargs: { enable_thinking: false }`.
  - The Gemini API gets `reasoning_effort: "low"` (accepted by every Gemini model in Google's thinking table) and `reasoningTokens: 2048`, which `generate()` adds to `max_tokens`.
  - Other hosted APIs get nothing extra, because they may reject unknown fields.
- `generate()` reports an empty reply cut off by the token limit as its own error, so the console can say what happened.
- Keys option 2: `ai_keys` with primary key `(user_id, preset)`. The migration copies existing keys before dropping the old columns. The associated data was already per provider, so moved keys still decrypt.

## Consequences

- A Gemini call can use up to 2,048 more output tokens than the caller's budget. On the free tier this counts toward the quota.
- `reasoning_effort: "low"` is not the lowest setting on every Gemini model (some accept `minimal`), but it is the lowest one they all accept.
- The Gemini change was checked against Google's docs and mocked replies, not a live Gemini call, because no Gemini key was available when it was written.
- A user can keep keys for several providers. There is no button to delete one yet; deleting the user removes them.
