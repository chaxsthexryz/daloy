# 0142: If this step fails (T3)

## Context

T3 lets an owner choose what happens when a step fails: stop the run, skip the step and carry on, or take a "failed" path. The idea comes from n8n's error output. Nothing is copied from n8n, whose code is under its Sustainable Use License.

E4 (decision 0131) already added `onError: "stop" | "skip" | "failed_edge"` to every non-branching step, the `on: "failed"` edge, the worker routing and an editor select. Five things were missing. Any non-branching step could set the policy, including booking, payment and transform steps. A `failed_edge` step with no failed edge drawn gave no warning. Explain this flow said nothing about failure. The run page showed a skipped failure like any other skipped step. And the Ask panel named a step that took its failed path as the place the run stopped.

## Options

1. Rename the stored values to `continue | path` as first sketched for T3. Rejected: definitions saved since E4 carry `skip` and `failed_edge`. A rename needs a mapping in the schema for old versions and changes nothing the owner sees, since the select shows labels.
2. Keep E4's values and finish T3 around them: limit the policy to steps that reach outside kymavo, warn about a missing failed edge, and explain the policy wherever a run or a flow is explained.

## Decision

Option 2.

- `OUTSIDE_STEPS` in `packages/engine/src/definition.ts` is the one list of steps that reach outside kymavo. Mocked test runs fake exactly these steps, and their fail choices use the same list (`test-run.ts`). `definitionSchema` refuses `onError` on any other step. A booking, payment due, payment expiry, stay quote or transform fails on its own data. Skipping one would let the run carry on as if a booking or payment request existed. A condition or switch on the data is the honest way to handle those.
- Unset and `"stop"` keep today's behaviour: the run stops as failed. `"skip"` and `"failed_edge"` apply only once the step is out of attempts (a dead letter) or on a permanent failure.
- A step whose outcome is unknown (decision 0030: the send claim, or a worker that stopped while sending) never takes either policy. `decideRetry` returns `review` for it, and the worker moves the run to `needs_review` before it looks at `onError`. An uncertain send is never skipped past or replayed.
- The lint rule `failed_path_no_edge` warns when a `failed_edge` step has no failed edge. The definition stays valid because the owner sets the select before drawing the edge. Until the edge exists, a failure stops the run.
- The editor shows "If this step fails" (Stop the run, Skip it and carry on, Take the failed path) only on outside steps, with a line saying an uncertain send still waits for the owner.
- Explain this flow adds "If it fails, the automation skips it and carries on." or "...takes the failed path." to the step's line, and a failed edge reads "If the step before fails". The failure explainer (`apps/api/src/explain.ts`) leaves out a failure that took its failed path.
- The run page and the editor's last test show "This step failed, so the run skipped it and carried on." or "...took its failed path." next to the error.

## Consequences

- No migration. A saved version that set `onError` on a step inside kymavo, which E4 allowed, no longer parses. No template, seed or test set it.
- The worker code did not change. Its tests now drive the policies with mocked `{fail: "permanent"}`, `{fail: "retryable"}` and `{fail: "unknown"}` choices on outside steps instead of transform errors.
- A skipped step's output keeps `{ skipped: true, error, outcome? }`, so later steps can read `{{steps.<id>.output.error}}`.
