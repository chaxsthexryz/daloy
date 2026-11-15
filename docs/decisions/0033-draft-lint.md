# 0033: Draft lint warnings

## Context

The eight-workflow report (fec03cc) showed that Build with AI drafts pass `definitionSchema` and still do the wrong thing for a business. The QA-01 v1 draft had a `dry_run` switch whose branch sent the urgent email for real. Approvals ended the run in silence on rejection or timeout, a classify label could land on a branch with no edge, and a number gate on a webhook value failed the run on bad data. The schema checks structure, not intent.

## Options

1. Make these schema errors. A hand-built or older workflow that is fine for its owner would stop saving, and the 47 development versions would need a migration of their own.
2. Advisory warnings from a separate function, returned with a draft, used in the repair round and shown in the editor.
3. Ask the model to review its own draft in a second call. Costs a call every time and is not repeatable in a test.

## Decision

Option 2. `lintDefinition(def)` in `packages/engine/src/lint.ts` takes a parsed definition and returns plain sentences.

- Approval without a `rejected` or `timeout` edge.
- A classify label that, followed through the conditions testing `{{steps.<id>.output.label}}`, lands on a branch with no edge.
- A trigger field or condition named like a test switch (`dry_run`, `test`, `test_mode`, `is_test`, `sandbox`, `simulate`, `debug`). Test runs already mock outside calls (decision 0028).
- A `gt`, `gte`, `lt` or `lte` condition with no `invalid` edge, unless both sides are certain numbers: a number literal, or a required number field of a form or a webhook with fields (checked at every entry point since decision 0027).
- A step only reachable through an `invalid` edge that cannot be taken (a condition that is not a number comparison, or whose sides are certain numbers).

Messages carry only step ids, field names and labels, which use a fixed charset, so sending them back to the model adds no free text.

`POST /ai/draft` lints a valid reply. With warnings it asks once more, listing them and saying to keep them if the request asks for exactly that. It returns the second draft, or the first valid one when the second fails or the model cannot be reached, always with a `warnings` list. At most two model calls, as before. The editor lints the current draft in the browser and lists the results under "Check before publishing". Save and Publish never wait for them.

## Consequences

- Warnings can be wrong. A form field really called `test` is flagged, and the walk for classify labels only follows conditions on the label itself. A false warning costs one line of text.
- Only Build with AI repairs on them. MCP and the save API accept the same drafts without a list.
- The saved QA-06 and QA-07 fixtures lint with two warnings each (their approval has no rejected or timeout edge). They stay as saved so the harness shows the lint finding real drafts.
- No migration and no dependency.
