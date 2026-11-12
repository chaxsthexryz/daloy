# 0008: Store each step's resolved input

## Context

Phase 6 asks for a run history page with the input, output and timing of each step, with secrets masked. Until now `step_runs` stored only the output. A step's config is a template such as `{{trigger.email}}`, and the values it resolves to depend on the trigger data and on earlier steps.

## Options

1. Show the config template from the run's version. Nothing new is stored, but the page shows `{{trigger.email}}` and not the address the email went to.
2. Rebuild the input when the page is opened, by resolving the template again against the stored trigger data and earlier outputs. That reruns the resolver on every view, and it can't show a secret-free version without decrypting the owner's secrets to find what to redact.
3. Store the resolved input when the attempt runs, after the worker's secret redaction, in a new `step_runs.input` jsonb column.

## Decision

Option 3. The executor resolves a step's input once (`resolveInput()` in `apps/worker/src/steps/index.ts`), runs the step with it, and returns it redacted with the same `redact()` that already cleans outputs and error text. A failed attempt carries its input on `StepError.input`, so failures keep their input too, which is when it is needed most.

The API masks again on the way out (`apps/api/src/mask.ts`): any value under a key that looks like a secret (`password`, `token`, `authorization`, `api_key`, `cookie` and similar) becomes `[secret]`. This also covers trigger payloads, which come from outside and are never redacted by value.

## Consequences

- Migration `0003_step_input` adds a nullable column. Rows written before it have no input, and the console shows none for them.
- Each attempt stores its input in full, up to the expression output limit, so `step_runs` grows faster. That is acceptable for version 1.
- Key-name masking can mask too much (an HTTP response field called `max_tokens` shows as `[secret]`) and can miss a secret stored under an innocent key in trigger data. The owner is the only reader of their run history, and both limits are listed in the README.
