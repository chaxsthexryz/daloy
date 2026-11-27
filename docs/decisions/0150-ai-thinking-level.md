# 0150. Thinking level per workspace

## Status

Accepted

## Context

Each host's thinking control was fixed in code (decision 0018): thinking off on a local llama.cpp or vLLM server and on DeepSeek, "low" on the Gemini API, nothing sent to OpenAI or OpenRouter. Off suits kymavo's usual AI jobs (labels, summaries, short replies), but an owner with a hard step, or with a reasoning model on OpenRouter, could not ask for more.

## Decision

`ai_settings.thinking` holds `off`, `low`, `medium` or `high` (default `off`), set on the AI model page next to the model name. `thinkingControl(provider, baseUrl, level)` in `packages/db/src/ai-settings.ts` turns it into each host's own fields:

| Host | off | low / medium / high |
|---|---|---|
| Gemini API | `reasoning_effort: "low"` (Gemini 3 and newer cannot turn thinking off) | `reasoning_effort` = level |
| DeepSeek | `thinking: { type: "disabled" }` | `thinking: { type: "enabled" }` with `reasoning_effort` low, high or max (DeepSeek has no "medium") |
| OpenRouter | nothing | `reasoning: { effort: level }` |
| OpenAI | nothing | `reasoning_effort` = level |
| Local server on this machine | `enable_thinking: false` | `enable_thinking: true` |
| Any other host, or an Ollama server | nothing | nothing |

Each level also sets `reasoningTokens` (2,048, 4,096, 8,192; Gemini's "off" keeps 2,048), which `generate()` adds to `max_tokens`, so thinking does not use up the answer's budget. OpenRouter documents that `reasoning.effort` and `reasoning.max_tokens` must not be sent together; only `max_tokens` for the whole reply is sent, which it allows.

The level applies to a saved choice only, including the Local model preset. A workspace that saved nothing runs the env connection at "off". A save without a level keeps the saved one.

## Consequences

- "Off" sends exactly what was sent before, so upgrading changes nothing.
- On OpenAI a non-reasoning model answers HTTP 400 to `reasoning_effort`. The page says so when OpenAI and a level above Off are picked, and Save and test shows the error.
- The shared model set by the platform admin (phase A2) will reuse the same mapping.
