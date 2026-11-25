# 0139: Chat as your customer falls back to a mocked run when the AI step fails (T8)

## Context

"Chat as your customer" (T8) runs each typed message as a real-AI test run. The plan said to fall back to a mocked run when no model is set. The console cannot tell that in advance: with no saved choice in AI model settings, the worker uses the operator's env model (`LLM_BASE_URL`, `LLM_MODEL`, default `llama3.2` on Ollama), which may or may not be running. A saved preset can also lack its key, and the workspace can be out of AI actions.

## Options

1. Check `GET /settings/ai` before each message and run mocked when nothing is saved. Wrong both ways: a workspace on the operator's shared model has nothing saved and works, and a saved preset can still fail.
2. Add an API route that tries the model before each message. One more model call per message, and it still races with the real run.
3. Start the real-AI run and watch it. When an AI step's attempt fails, cancel the run (so it stops retrying and claiming usage) and run the same message mocked, with the error shown under the bubble.

## Decision

Option 3, in the console only (`apps/web/src/ChatTest.tsx`, `aiFailure` in `apps/web/src/lib/chat-test.ts`). No API change.

## Consequences

- Any failure of an AI step falls back, including one the owner should fix (an unpublished knowledge sheet for an `answer` step). The note under the bubble names the error, so the owner still sees why.
- The cancel is best effort: a run that is mid-step at that moment cannot be cancelled and finishes its retries in the background as a test run. It sends nothing.
- The first failed attempt has already claimed its AI action, as any failed ai test run does.
