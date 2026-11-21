# 0098: Build with AI builds file fields and an AI step that reads them

## Context

An owner asked Build with AI for "a form where I upload a photo of my semester schedule, AI turns it into text, and it goes into Sheets as a table". The assistant said a file upload field is not a field type it can build, offered a text link, and asked the same yes or no question again after a free-text answer. File fields exist since N21 (decision 0051) and AI steps can read form files since N22 (decision 0052). The prompt in `packages/engine/src/ai-draft.ts` simply never mentioned them, and the chat prompt in `ai-chat.ts` reuses it.

## Options

- Let the model write the `files` setting of an `ai` step. The draft would then read uploads without the owner choosing to.
- Keep `files` out of the model's schema, tell the model to add the file field and an `ai` step, and tell the owner which box to tick.

## Decision

The second option. Decision 0052 stands: reading a file is the owner's consent, given by ticking "Let the AI read these files" on the `ai` step.

- The prompt lists the `file` field type (photos and PDFs, up to 3 per field), says that reading an upload takes the file field plus an `ai` step with task `extract` or `summarize`, and tells the model to name the box to tick in the summary. `files` stays out of the `ai` schema.
- The `drive` step is back in the prompt (saving form files to Google Drive). The connected-apps line in the chat prompt decides whether to use it. `sms` stays out: another phase changes how SMS is configured.
- `lintDefinition()` adds a warning: `AI step "<id>" reads no file, but the form has a file field.` It shows in "Check before publishing", in the Turn on summary and in the draft review. It is advice, not an error. It is not a `LintRule`, because the run explainer (`apps/api/src/explain.ts`) keeps a line per rule and this warning is about setup, not about a stopped run.
- Chat rules: a typed answer counts as the answer and the model moves on instead of asking again. A sheets step adds one row per run, so for a grid (rows by time, columns by day) the model says so and offers one row per item.
- The size test for the draft prompt moves from 3,000 to 3,100 tokens (about 4 characters each). The file paragraph adds about 250 characters. Ollama's default context is 4,096 tokens, which still leaves about 1,000 for the reply.

## Consequences

- A request to read an upload now gives a draft with a file field and an AI step. The warning stays until the owner ticks the box, which is the point.
- The same warning fires for any form with a file field and an `ai` step that reads none, including a classify step that only reads text. The owner can ignore it.
- The model still cannot build a grid in Sheets. It offers one row per item.
