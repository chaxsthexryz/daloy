# 0039: Plain-language explanations of failed runs

## Context

N10a asks Daloy to explain a failed or parked run to a small-office owner, from run records, provider error kinds and lint rules, with fixed rules first and a model only for the wording. Before this, the run page showed the error text without the `step <id>: ` prefix and a link guessed from that text (`fixFor`). Two gaps: the provider error kind (decision 0021) was used to decide a delivery's next state and then thrown away, so only `last_error` text was left; and `lintDefinition` returned messages only. Error text can hold a sheet id, a service account address, a host with a query string, or a provider's own message, so it cannot go to a model.

## Options

- What the model sees: the error text with a redaction pass, or only closed-set fields built from the records.
- Where the kind comes from: parse it back out of `last_error`, or store it.
- When the model is called: on every failed run, or when the owner asks.
- Which model: a fixed DeepSeek model through OpenRouter, or the workspace's AI model setting.

## Decision

- The model sees only `{ facts, fixed }`. `facts` (`failureFacts` in `apps/api/src/explain.ts`) holds the run state, whether it was a preview, the failed step's type, outcome (decision 0030), attempt count, dead-letter flag, an HTTP status code read only from the fixed `HTTP <code> from` prefix, a reason from a fixed regex table (`mail_sender`, `ai_model`, `quota`, `booking_changed`, `worker_stopped`, `preview_choice`), each failed or parked delivery's app, state, error kind and attempt count, and lint rule ids with counts. `fixed` is Daloy's own text built from those facts. No error text, step id, label, URL, host, address, form value or booking field leaves `failureFacts`. A redaction pass over free text was rejected: it fails open on the next format nobody thought of.
- `deliveries.error_kind` stores the kind next to `last_error` (migration 0021): the seven provider kinds plus `not_connected`, `reconnect`, `no_destination`, `destination_changed`, `queued_before_pin` and `booking_changed`. It is cleared with `last_error`. Rows from before the migration have none and get the generic line. Parsing the kind back out of text was rejected for the same reason as redaction.
- `lintFindings` in `packages/engine/src/lint.ts` returns `{ rule, message }` with five rule ids; `lintDefinition` maps it to messages, so its callers did not change.
- The fixed explanation (`explainFailure`) always shows, needs no model and costs nothing. It uses the console's words (automation, Activity, Apps, Needs you, Retry, Post again, Mark as posted) and links to the page that fixes the problem, for owners.
- The model is called only when an owner presses "Explain in simpler words". One press is one AI action under decision 0038, claimed before the call, so a call that then fails still counts, as with Build with AI. The reply is plain text, at most 600 characters, refused if it holds a link, shown as text under a label that says the model wrote it, and never stored.
- The model is the workspace's AI model setting (decision 0017), as for Build with AI. The recommended setup for N10a is the OpenRouter preset with a DeepSeek model; nothing is hard-coded, so a workspace on a local model works the same way.
- A reply cannot change anything: the reword route writes no run, step or delivery row, and no button acts on the text.

## Consequences

- An explanation works with no model, with the allowance used up and with the model down; the page says which.
- A new error message that matches no regex falls back to the generic line, never to a wrong fix. The tests pin each pattern to the real message.
- Wording quality of the model is not measured yet. N10b measures it on twenty real failures in English and Tagalog before anything turns on by default.
- Step failures keep no stored kind; outcome and reason cover them. If N10b needs more, a kind column on `step_runs` is the next step.
