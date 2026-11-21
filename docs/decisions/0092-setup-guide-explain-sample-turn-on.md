# 0092: Setup guide, Explain this flow, sample test and Turn on summary

## Context

R2b of the seller pilot roadmap (section 3) asks for four things around a new draft: a guide that shows what is left to do, a dialog that says in plain words what the flow does, a sample test that separates configuration checks from simulated steps and live connection status, and a summary before the owner turns the flow on. Editing a tested draft must mark the old result out of date. The owner pre-approved the phase, so this record is the plan and the decision.

## Options

- Generate the explanation with an AI call, or from the draft and the step catalog.
- Add a server route for "check this draft", or run the checks in the browser from the same engine code.
- Add the guide as a new page, or as panels in the editor.

## Decision

- The explanation, the configuration checks and the payment mode are pure functions in `packages/engine/src/flow-guide.ts`, built on the R2a catalog (`entryLabel`, `destination`, `required`). They work in English and Tagalog from the saved draft, need no network and have unit tests. An AI never decides a check result.
- The checks need no new route. The browser runs them on the draft on screen, and the sample test posts to the existing `POST /workflows/:id/test-runs` in mock mode, so no real provider is called. There is no migration and no API change, so the threat model keeps its boundaries.
- The guide, the sample test and both dialogs live in the editor (`Guide.tsx`). The dialogs reuse the shared `Sheet`. The only new styles are a small block in `editor.css` that reuses the editor's tokens.
- The three result groups are separate on purpose: configuration checks (required fields and recipients from the catalog), simulated steps (the states of the mock run) and live connections (the apps the draft needs and whether each is connected).
- The failure example is the same check run on a copy of the draft with its first recipient emptied. It never touches the real draft.
- A sample result stores the draft as JSON when it ran. Any edit changes the JSON, so the result shows "Out of date" in the guide and in the Turn on summary.
- Turn on replaces the old Publish confirm with a summary sheet: apps and whether they are connected, who gets what, the payment mode (manual QR Ph, GCash checkout, pay later), the sample test state and a count of failing checks. The button that opens it is still labelled Publish. The owner chooses when to confirm, and the server still refuses a publish that fails its own validation.
- Explain this flow opens once by itself for a guided draft that is not live, then from a button in the editor header. "Read" is remembered per workflow in localStorage, and the dialog simply shows again when storage is blocked.

## Consequences

- The explanation is a numbered list built from catalog text ("2. After approved: Gmail, Send email. To: Customer email from the form"), not flowing prose. That is plainer than the roadmap's example sentence, and it cannot say something the draft does not do.
- Configuration checks cover required fields and recipients only. A wrong but non-empty value, such as a misspelled address, is found by the existing validator at save time or by the sample run.
- Eight e2e specs that clicked Publish now also click Turn on in the summary.
- The number 0092 may need renumbering at merge time if R5 or R6 also take it.
