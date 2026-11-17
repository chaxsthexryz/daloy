# 0041: Ask about a request in Build with AI

## Context

N10b asks the Build with AI tab (N4f) to answer "what happened to request X" and point the owner at the setup that fixes it, without a suggestion ever approving a run. N10a (decision 0039) already explains a failed run from closed-set facts with fixed rules, and rewords that with the model on request. What was missing is a way in by request reference, answers for a run that did not fail, and a switch that keeps it off until the wording is measured on twenty real failures in English and Tagalog. Live AI is not set up and Tagalog strings (N8) do not exist yet.

## Options

- How the owner asks: open chat about a run, or a reference plus a few fixed questions.
- Where the switch lives: a per-workspace setting the owner turns on, or an installation setting.
- What the model sees: the N10a facts, or more of the run.

## Decision

- The owner types a reference or taps one of the latest Problem requests, then taps one of three fixed questions: What happened?, Why did it stop?, What do I do now? There is no free text, so nothing the owner types reaches the model either.
- `GET /runs/ask?reference=R` (owners and operators, in their own workspace) returns all three answers at once from fixed rules in `apps/api/src/explain.ts`: `happened` from the plain state and the step timeline, `why` from N10a's `explainFailure` (null when nothing stopped), `next` from the fix, the lint lines and a pointer to the run page. No model, no AI action.
- `POST /runs/ask/reword` (owners) rewords one answer, in English or Tagalog, with the workspace's AI model. It is N10a's reword with the same helper: connection first, one AI action claimed before the call (decision 0038), at most 600 characters, refused when it holds a link, never stored. The model sees `{ question, language, facts, fixed }`: N10a's facts plus the plain state and a timeline of step type, state, outcome and attempts. Never the reference, ids, names, labels, payloads, error text, dates, secrets or URLs.
- The switch is the installation's `AI_ASK=on` env var, off when absent. The measurement is about the product's wording, not one office's, so a workspace owner cannot turn it on early. Off, both routes are 404 and the card is hidden.
- The card has links only: the fix link from N10a and "Open this request". Retry, Send again, Mark as posted and the approval buttons stay on the run page and the approval page, so nothing in an answer acts on a run.

## Consequences

- It stays off until the checklist in [ai-ask-measurement.md](../ai-ask-measurement.md) passes; turning it on by default is a separate change that updates this record.
- Fixed answers are English only until N8. The Tagalog choice only affects the model's rewording, which is what the measurement checks.
- Like N10a, a step failure with an unknown message gets the generic line, never a guessed fix.
