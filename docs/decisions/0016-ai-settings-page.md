# 0016: AI model chosen in the console, from fixed providers

## Context

After decision 0015 the AI provider was set with env vars, so switching from a local model to the Gemini free tier meant editing `.env` and restarting the worker. The owner wants to switch in the console and check the result straight away.

## Options

1. Keep env vars and add a desktop script that edits `.env`. No code in the app, but no way to see whether the model works.
2. A settings page with a free-form base URL, model and key. Covers every server, but a user could make the API and worker call any address, including internal ones (SSRF).
3. A settings page with a fixed list: local (the operator's `LLM_BASE_URL`), Gemini API, OpenAI and OpenRouter, each hosted one with its URL in code, plus a live test button.

## Decision

Option 3. Settings are per user in `ai_settings` (migration `0004_ai_settings`), with the key encrypted by `encryptSecret()` and the provider in its associated data. `aiConnection()` is the one place that turns a user's choice, or the env vars when there is none, into a connection for `generate()`. The worker calls it on every AI step; the API calls it for the test.

The Gemini default model is `gemini-3.8-flash`, which Google's pricing page (read 2026-11-13) lists as "Free of charge" on the free tier, with the note that free-tier content is used to improve Google's products.

The test sends a fixed sample inquiry through the Inquiry triage classify config, so it checks what that workflow will run. It reports the status-based reason for a failure, never the provider's body.

## Consequences

Switching models is a console change that applies to the next AI step. A server that is not on the list (LM Studio, vLLM) is still possible, but only through the operator's env vars as the "local" choice. Adding a hosted provider is one entry in `PRESETS`. The hosted providers are tested against mocked replies; the first real call is the owner's own test with their key. All AI steps of one user share one model.
