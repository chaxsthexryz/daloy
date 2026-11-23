# 0110. Test one step from its panel, and send one step for real

## Context

The editor's right-click "Test this step" ran the whole mocked preview and scrolled the result to that step's line. The owner had to read the run result to find what the step did, and nothing in the panel where they edit the step showed it. A mocked preview also cannot tell whether a step's app really accepts the message: the only way to check one Sheets row or one Telegram message was a live test run, which sends every step, emails included.

n8n has "Execute step" and Langflow has "Run component" for this. Both inspired the change; no code was taken from either.

## Options

1. Run only the chosen step, with the outputs of the steps before it taken from the last test. Every later template that reads an earlier output then depends on a run that may be out of date, and the worker would need a second way to start a run.
2. Keep running the whole preview, show the step's result in its own panel, and let the owner mark one step to call its app for real while every other step stays faked.

## Decision

Option 2.

- The step panel (and the phone sheet, which shows the same panel) has "Test this step" and a "Last test" block with that step's last attempt from the last preview, using the run result's own `StepAttempt`. A preview of an older draft is marked "From before your last change".
- "Try this step for real" is a test choice, `{live: true}`, in the same `choices` map as chosen labels, decisions and failures (decision 0028). It is stored in `runs.test_choices`, so no migration was needed.
- `choiceProblems` accepts it only in a `mock` preview, at most once, and only on a step that sends to an app (`canSendAlone`): not an approval, which has nothing to check on its own, and not a Shopify product step, since a real product is not a test. Payment steps are not outside steps, so they cannot be chosen either.
- The worker runs that one step with `mock: false` and no choice. It gets the send claim that real sends get, and real retry delays. Every other step stays faked.
- The owner confirms first, with the step's destination in the question. Run pages call such a run "Preview, one step sent for real".

## Consequences

- An owner can check that one app connection works without sending the rest of the workflow.
- The real step sends with the sample data and the faked outputs of the steps before it, so a template that reads an earlier faked output (an HTTP body, for example) sends that faked value.
- The step uses the app's real usage limits and caps, like any real send.
