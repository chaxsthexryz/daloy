# Handoff: picture to text to sheet, and why it failed

Written 2026-11-20 for a session that ran out of usage. Read this first before touching the photo workflow.

## The automation

`Picture to text to Discord v2` (workflow `0bd7449c-448b-4a04-b0bb-51881ef71831`, live version 15), actually the photo to **sheet** flow now:

form (`picture`, file, required) → `has_picture` (exists) → `extract` (AI, reads the file) → `has_text` (exists) → `to_sheet` (Google Sheets) → `no_picture` / `no_text` emails.

## Chronology of the fixes

1. **DeepSeek returned HTTP 400.** The saved model was a dashboard label (`DeepSeek-V4.1-Flash-1017`), not an id. Fixed by storing `deepseek-flash`, adding a model picker fed by `GET /models`, refusing a name the provider does not serve, and naming the served ids in errors. Decision 0047. Committed.
2. **Build with AI became a chat.** New `POST /ai/chat`, one question or a full draft per message, six-question cap. Decision 0048. Committed.
3. **Auto-deploy was withdrawn.** A clean draft now waits for **Turn it on** (decision 0049, by Claude). Committed.
4. **The flow never reached the AI.** The trigger was a webhook with a URL field; a webhook cannot carry a file. Rebuilt as a form with a `file` field. Nothing to commit, it is data.
5. **DeepSeek was refused for images.** `IMAGE_TYPES` had only Gemini, OpenAI and OpenRouter, although `deepseek-flash` lists image input. Added `deepseek: ["jpeg","png","webp"]` after a live call proved it reads a generated PNG. Decision 0051. **Uncommitted.**
6. **A file step with no file blamed the photo.** The model was asked to read a picture it never received, answered `null`, and the run took the "no text in the picture" branch. The worker now fails at once with "This step reads a file, but none arrived". **Uncommitted.**
7. **A dense page was thrown away twice.** Answer budget was 1,024 tokens, so a schedule page was cut off mid-JSON ("not valid JSON"). Raised to 4,096. Then the reply was a good 2,909 characters but extract fields were capped at 2,000 ("does not match the schema"). Raised to 8,000. A truncated reply now says it was cut off. **Uncommitted.**
8. **The PDF reader's budget was too tight.** A CV reads in 1.2 to 2.4 seconds, but the 10 second cap fired while an image rebuild was using the CPU. Raised to 30 seconds. **Uncommitted.**

## Verified state at handoff

- `imageTypes` for this workspace: `["jpeg","png","webp"]`, model `deepseek / deepseek-flash`.
- The failing 141 KB schedule photo now transcribes to **2,836 characters** through the real step code.
- One Google Sheets delivery is **delivered**: tab `Sheet1`, row `["460b803c-…", time, "TIP\nTECHNOLOGICAL INSTITUTE…", …]`.
- Runs that fail with `has_picture: false` are submissions with an empty payload (Run button, preview, MCP). They are not form submissions and never write a row.

## Do these in this order

1. **Commit the six uncommitted fixes.** Another agent's checkout already wiped them once (the `Doop redesign` commits), which is exactly what put "does not read images" back. Nothing is safe until these are committed.
2. **Decide the row shape.** Today the transcription lands in one cell. For columns, change the AI step's fields to `course`, `day`, `time`, `room`, `amount` and give the sheets step matching headers. Then it is worth calling v3.
3. **Clean up.** Delete `picture-to-text-to-discord` (old URL-based AI step) and `picture-to-text-to-discord-2`; rotate the Discord webhook that was pasted in chat.
4. **Google Drive stays blocked** without Google Workspace (shared drives) or N24 (OAuth with the owner's own client). Sheets works today; Drive does not.

## Traps worth remembering

- A file field only reaches the AI through the step's `files` list, and only from a **form** trigger. A webhook cannot carry a file.
- Empty payload plus a "reads a file" step used to look like "your picture had no text". That is what the new guard is for.
- Truncated JSON and schema mismatches both used to surface as "not valid JSON". They now name the real cause.
