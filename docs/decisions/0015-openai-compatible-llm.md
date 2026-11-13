# 0015: One OpenAI-compatible mode next to Ollama

## Context

The AI step only spoke Ollama's `/api/chat` and sent no API key. The owner wants to start with the Gemini API free tier and later switch to a local model, without code changes. CLAUDE.md requires that the app still runs locally without any free tier.

## Options

1. A client per vendor (Gemini's own API, OpenAI, Anthropic). Most accurate per vendor, but each one is code to write, test and keep current.
2. One more mode for the OpenAI chat completions format, which the Gemini API, OpenRouter, LM Studio, llama.cpp and vLLM all accept, plus an optional bearer key.

## Decision

Option 2. `LLM_PROVIDER=openai` posts to `<LLM_BASE_URL>/chat/completions` with `model`, `messages`, `temperature`, `max_tokens` and, when the step has an output schema, `response_format: { type: "json_schema", json_schema: { name: "output", schema } }`. The key in `LLM_API_KEY` goes in `Authorization: Bearer`. `LLM_PROVIDER=ollama` stays the default, so a fresh install sends nothing off the machine.

Gemini's OpenAI compatibility page (read 2026-11-13) documents the base URL `https://generativelanguage.googleapis.com/v1beta/openai/`, the bearer key, and structured output through the OpenAI SDK's `zodResponseFormat`, which sends the `json_schema` shape above. It does not list `max_tokens` or the `usage` fields, so a reply without usage records 0 tokens.

## Consequences

Switching provider is three env vars. The mode is tested with mocked replies only; a live call to the Gemini API has not been made, because that needs the owner's key. Prompts and trigger data go to whichever provider is configured, which the threat model and `.env.example` point out. Vendor features outside the common format (Gemini safety settings, Anthropic's API) are not available.
