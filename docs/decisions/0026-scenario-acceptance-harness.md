# 0026: Scenario acceptance harness with pinned gaps

## Context

The eight-workflow QA report (fec03cc) rated every scenario partial or failing. The next phases add engine capabilities to close those gaps, and the scenarios are their acceptance tests. Many cases cannot pass until a later phase lands, but CI has to stay green, and a case that fails for an unrelated reason (a fixture that does not load, a typo in a step id) must never be read as evidence of a missing capability.

## Options

1. Skip or `todo` the cases that cannot pass yet. They prove nothing and nobody notices when they start passing.
2. `it.fails` on the wanted outcome. Vitest passes it on any error, so a broken fixture looks the same as a real gap.
3. Assert today's exact outcome for each gap, next to the wanted one, and require the two to differ.

## Decision

Option 3. Each fixture case states the wanted outcome. A case with a known gap also states the phase that fixes it and today's outcome, and the runner asserts today's outcome. Fixtures are checked against today's schema in their own passing test before any case runs. Capabilities the schema cannot express yet (a datetime field, a booking step) are checked through the save error, matched on the field path that is refused.

## Consequences

- A gap test passes only while that wrong behaviour is observed. When a phase changes it, the test fails and the phase flips the case to the wanted outcome.
- The test names carry `[gap <phase>: <reason>]`, so the open gaps per phase can be counted from the test output.
- Fixtures are hand-written copies of the QA-01 to QA-08 drafts. They can drift from the saved workflows in the development database, which the tests never read.
