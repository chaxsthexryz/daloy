# 0027: Field limits at every entry point and the condition invalid branch

## Context

The eight-workflow report (fec03cc) found negative budgets, an 80% discount and a -10 refund reaching workflows. Three causes:

- Number fields had no range, and an unknown key such as `min` was silently dropped on save.
- Builder test runs, the console Run button and webhooks passed any JSON to the run; only the hosted form checked fields.
- `gt`, `gte`, `lt` and `lte` on a missing or non-number value returned false, so "45,000" went down the "under the limit" branch.

## Options

1. Leave checks to condition steps in each workflow. That is what the drafts tried; it needs two guards per number and still misroutes text.
2. Field limits checked wherever a payload comes in, and a comparison that cannot compare made visible.
3. A general validation step type. More to learn, and it would still run after bad data started a run.

## Decision

Option 2.

- A number field can set `min`, `max` and `integer`. Save refuses `min` above `max` and number options on other field types.
- One function, `parsePayload`, checks the hosted form, webhooks that list `fields`, test runs, the console Run button and MCP tools. Number text must be plain decimal. Empty text and null count as not given. A refusal is a 400 with one message per field, such as `amount: must be at least 0.01`.
- For webhooks, test runs and console runs, declared fields are stored parsed and other keys pass through, since events carry more than the fields name. The hosted form keeps only its fields, as before.
- A condition's branches are `true`, `false` and an optional `invalid`. A numeric comparison with a missing or non-finite side takes `invalid`. Without an `invalid` edge the step fails without retrying, and the run error names the values.

## Consequences

- Compatibility: definitions saved before this load unchanged; none of the 47 versions in the development database had the new keys. Form submissions that used to pass and now fail: number text such as "0x10" or "0b101", which was read as 16 or 5 before. Test runs and console runs of form workflows now need the required fields.
- Behaviour change: a saved workflow whose numeric condition receives bad data now fails the run (or takes `invalid`) instead of taking `false`. The development database has 19 such conditions across its versions.
- A webhook without `fields`, and manual or scheduled runs, still accept any JSON; their `invalid` branches are the remaining guard.
- The builder shows the `invalid` handle on every condition, and Build with AI is told about limits and the branch.
