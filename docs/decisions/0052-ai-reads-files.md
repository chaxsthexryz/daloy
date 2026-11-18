# 0052: The AI step reads images and PDFs

## Context

N21 stores files from a form and keeps their bytes away from the AI step. Owners now want the model to read a receipt photo or a PDF invoice and pull out the shop, amount and date. The files come from anonymous visitors, so the owner has to opt in per field, and the model's reply still has to fit the task's schema.

## Options

For images:

1. Send nothing but text, and let owners run their own OCR first. This adds a step the owner cannot build in Daloy.
2. Send the image to the model as part of the message, for the providers that read images.

For PDFs:

1. Render each page to an image and send the images. This needs a native canvas renderer in the worker image.
2. Send the raw PDF. Providers differ, and OpenRouter can fall back to a paid OCR engine without the owner asking.
3. Extract the text layer and send it as text. It works with every provider, including DeepSeek and text-only local models, and uses fewer tokens. Scans fail.

## Decision

Images go to the model, and PDFs are read as text.

- Consent is a list. The AI step config has `files`, the names of the form's file fields the model may read (1 to 5). The definition check rejects names that are not file fields, and the worker checks again against the form's fields. Without `files`, no file bytes reach the model. Build with AI leaves `files` out of its prompt, so only the owner turns it on, with the checkboxes under "Let the AI read these files" in the editor.
- Gemini reads JPEG, PNG, WebP and HEIC. OpenAI and OpenRouter read JPEG, PNG and WebP. DeepSeek reads no images. The local model reads none unless the operator sets `LLM_VISION=on`, which allows JPEG, PNG and WebP. OpenAI-compatible APIs get `image_url` data URLs, and Ollama gets `images` on the message. A file the model cannot take fails the step with a plain message before any AI action is counted. The step never runs without a file it was told to read.
- A hosted model that refuses images (HTTP 400, 404, 413, 415 or 422) fails the step with a plain message and no retry. The provider's body is not shown.
- PDF text is extracted with PDF.js (`pdfjs-dist` 6.5.438, Apache-2.0) in a worker thread with a 10 second timeout and a 256 MB heap cap. Only the first 10 pages are read, and at most 20,000 characters of PDF text go to the model per step, with a note when it was cut. A PDF with no text layer (a scan) fails with a message asking for a photo. The text goes inside the `<data>` block, so the existing escaping of `</data` covers it. PDF.js 6 has no code evaluation path (the `isEvalSupported` option behind CVE-2024-4367 is gone). It pulls in `@napi-rs/canvas` (MIT) as an optional dependency, which text extraction does not use.
- Limits are N21's 5 MB per file and 5 per submission, plus 10 MB of images together in one AI step. That keeps the request under Gemini's 20 MB inline limit after base64.
- Quota: one AI action for the step plus one per attached file. It is claimed once under the step key after every check and the PDF reading, so a retry is not counted twice and a refused file costs nothing.
- A file past the 7 day retention fails the step with a plain message. An empty optional file field runs on text alone.
- The reply is checked against the task's schema as before. The system prompt says that attached images are data, not instructions.
- A test run never carries files, because N21 drops file values from test runs, and a mocked run does not call the model.
- The template "Receipt to expense row" (`receipt-expense`) ties it together: a form with name, email, receipt photo and note, Drive saves the photo, the AI extracts shop, amount and date, and the owner approves. An approval adds a sheet row and emails the sender. A rejection or timeout emails the sender. It needs a shared drive folder (N21), Google Sheets and a model that reads images.

## Consequences

- Owners on DeepSeek or a text-only local model cannot use photos until they switch models.
- Scanned PDFs are refused. A photo of the page works.
- HEIC works only with Gemini. Other providers refuse it with a plain message.
- Photos go to a hosted provider, whose free tier may use them for training, the same as text (decision 0015).
- Each photo sits in worker memory as base64 for the length of the request.
- Text written inside a photo or a PDF can still steer the extracted values within the schema. The receipt template puts a human approval before the sheet row for that reason.
- Page images would read scans, and could be added later if a renderer is worth shipping.
