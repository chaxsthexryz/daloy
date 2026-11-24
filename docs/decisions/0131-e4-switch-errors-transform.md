# 0131: Multi-way switch, per-step error policy, deterministic transform, and batched Sheets appends (E4)

## Context

Workflows that sort AI labels or order types had to chain multiple two-way `condition` steps. A non-critical step failing (such as a bad phone number or a transient third-party refusal) always failed the entire run, with no way to skip and continue or branch into a fallback path (`T3`). Simple formatting (timezone dates, Philippine pesos, PH mobile normalization, text splitting/case, and building small objects) forced owners to call an AI step or an external webhook. Finally, logging multi-item orders or split lists into Google Sheets required one delivery per item instead of one batched write (`N30`).

## Options

1. Add a sandboxed JavaScript expression evaluator for transforms and loops. Rejected: violates the engine's no-`eval`/no-`Function` rule and adds a security surface for untrusted trigger payloads.
2. Add a general-purpose loop node that re-enters earlier steps. Rejected: breaks the acyclic DAG invariant in `definitionSchema`, Kahn's cycle check, and the single-attempt `step_runs` uniqueness model.
3. Add a bounded multi-way `switch` step, an optional per-step `onError` policy on non-branching action steps, a closed-set deterministic `transform` step, and bounded batched `rows` appends on the `sheets` step.

## Decision

Option 3, with zero database migrations.

- **`switch` step**: compares one resolved `value` against 1 to 10 literal `cases` (`{ label, equals }`, where `label` matches `^[a-z][a-z0-9_]{0,31}$`, is unique, and cannot be `"default"`) using `switchBranch` (loose numeric equality matching `condition`'s `eq`), falling back to `"default"`. `stepBranches(step)` resolves dynamic branch labels across `definition.ts`, `graph.ts`, `lint.ts` (including `classify_dead_end` and `test_switch`), `apps/web/src/lib/graph.ts`, `apps/web/src/lib/editor.ts`, `FlowCanvas.tsx`, and `Editor.tsx` (with `SwitchCases.tsx`). Like other branching steps, `switch` cannot be disabled or carry `onError`.
- **Per-step error policy (`T3`)**: optional `onError: "stop" | "skip" | "failed_edge"` on non-branching action steps. `definitionSchema` rejects `onError` on branching steps and rejects `on: "failed"` edges unless `from.onError === "failed_edge"`. `transitions.json` adds `running -> skipped` for step runs. After retries are exhausted (`dead_letter`) or on non-retryable failures (`fail`):
  - `"stop"` (or unset) keeps existing behaviour and fails the run.
  - `"skip"` marks the step run `"skipped"`, stores `{ skipped: true, error, outcome? }` on step output (exposed to downstream `{{steps.<id>.output.*}}`), and follows the default edge.
  - `"failed_edge"` marks the step run `"failed"` with `branch: "failed"` and `{ failed: true, error, outcome? }` on output, routing along the optional `on: "failed"` edge (or failing the run if no `"failed"` edge is wired).
  - Ambiguous outcomes on unsafe sends (`decision.kind === "review"`) still park in `needs_review` so a human decides before anything else runs.
- **Deterministic `transform` step**: pure functions in `packages/engine/src/transform.ts` with zero `eval`/`Function`. Operations: `format_date` (IANA timezone via `Intl.DateTimeFormat` and `formatZoned`, supporting `readable`, `iso`, `date`, `time`, `datetime`), `format_peso` (grouping and two decimals as ASCII-safe `PHP 1,234.50`, plain string `"1234.50"`, and numeric `amount`, staying compatible with GSM-7 SMS and WIN1252/UTF-8 Postgres), `normalize_phone` (reusing `normalizePhMobile`), `split` (capped at 200 items), `trim`, `lowercase`, `uppercase`, and `pick` (1 to 30 template fields preserving resolved types). Runs deterministically in both live and mocked test runs.
- **Batched Google Sheets appends (`for_each` / `N30`)**: `sheetsConfigSchema` keeps `{ columns }` single-row mode unchanged and adds optional `rows` (either a list template such as `{{trigger.line_items}}` mapped per item via `columns` using `{{item.*}}` / `{{index}}`, or a literal 2D template array) capped at 100 rows x 20 columns, plus an optional `header` row (up to 20 columns). `appendRowsOnce` in `packages/db/src/providers.ts` checks row `1:1` when `header` is provided and prepends the header only when the tab is empty, writing `[header?, ...rows]` and the delivery's existing developer metadata marker in one atomic `spreadsheets.batchUpdate`. Retries after ambiguous timeouts reconcile against the marker without duplicating either the header or the rows.

## Consequences

- Zero database migrations; `step_runs` already has `skipped`, `branch`, `output`, and `error`, and `deliveries` already stores `payload` as `jsonb` with `sheet_meta_id` / `sheet_meta_value`.
- `ExpressionContext` accepts optional `item` and `index` segments during `sheets` `for_each` resolution while preserving own-property lookup and prototype guards.
- Local AI draft prompts omit `switch`, `transform`, and `sheets` `rows`/`header` via `HOSTED_ONLY` / `LOCAL_LEFT_OUT` so Ollama context budgets remain under limit, while hosted models receive the full schemas and rules.
