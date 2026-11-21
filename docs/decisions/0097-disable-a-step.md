# 0097: Disable a step (U3)

## Context

The owner asked for a way to turn a step off without deleting it, like n8n's deactivate, so a flow can be tried without one send and turned back on later (ask 3 of `docs/plans/console-ui-paper.md`, approved with its defaults). U2 left a place for it in the step's right-click menu.

## Options

- Where the flag lives: in the step definition, or in a per-workflow setting outside the versioned definition.
- What the worker does: drop the step from the graph before the run starts, or record it as skipped when the run reaches it.
- Branching steps: allow turning them off and pick a default branch, or refuse it.

## Decision

- A step may carry `disabled: true` in the definition. Only `true` is accepted, so an enabled step has no key. It is saved, undone and published like any other edit.
- When the run reaches a turned-off step, `advance.ts` inserts a step row in state `skipped` (already a step state, so no migration) with `output.skipped` saying why, then queues the run again. The next pass treats a skipped row like a succeeded one and follows the step's one unlabelled edge. No attempt, claim or retry is created.
- The definition check refuses `disabled` on a step that branches. A default branch would be a hidden choice the owner never made. The editor leaves Disable out of a branching step's menu.
- The diagram gets a `skipped` node state ("Skipped", symbol `»`), and the line out of a skipped step counts as taken.

## Consequences

- The worker and engine must ship together: a worker from before this change parses the definition, drops nothing it does not know (the flag is stripped by its older schema) and would run the step.
- A later step that reads a turned-off step's output gets nothing, like a step on a branch not taken. The definition check does not warn about it.
- A turned-off step that another step points at (a `paymongo_link` read by `payment_status`, a `payment_due` read by `payment_expire`) is accepted; the dependent step fails at run time with its usual message.
