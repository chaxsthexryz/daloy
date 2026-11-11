# 0002: Own path resolver for expressions, no JSONata

## Context

Step configs reference earlier data with `{{trigger.<path>}}` and `{{steps.<id>.output.<path>}}`. Workflow authors write these templates, and trigger data comes from the public internet, so evaluating them must not run code. PROJECT.md requires limits on time and output size and forbids `eval` and `Function`.

## Options

1. JSONata. It has a full query language (functions, filters, arithmetic). Its run time depends on the expression, so a time limit needs a watchdog around each evaluation, and the attack surface is the whole language.
2. A small resolver of our own that only does property lookups, with branch conditions written as structured data (`{ left, op, right }`) instead of expression strings.

## Decision

Option 2. A placeholder must be a dot path that starts with `trigger` or `steps.<id>.output`. Each segment matches `[A-Za-z0-9_-]+`, and `__proto__`, `prototype` and `constructor` are rejected. Lookups read own properties only. Conditions support `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains` and `exists`.

## Consequences

- No code can run from a template. The time limit comes from the input limits: templates are capped at 10,000 characters, 50 placeholders and 32 path segments, and the work is linear in that size.
- Output is capped at 100,000 characters.
- Authors cannot transform data in a template (no string functions, no arithmetic). If real workflows need that, add named functions one at a time with tests, or revisit JSONata.
