# 0086. One step catalog in the engine package

## Context

Step names lived in four places: `TYPE_NAMES` in the canvas, a second map in the AI plan table, raw type names (`email`) in screen reader text, and a hand-written trigger menu. A new step type got a name in some of them and not others. The seller pilot roadmap (R2a) asks for one entry per trigger and action with a label, an app mark, a plain description, required fields, input, output and outcomes.

## Options

1. A map in the web app, with Tagalog in the locale files.
2. A map in `packages/engine/src/catalog.ts` with both languages inline.

## Decision

Option 2. The entry carries English and Tagalog text next to each other, so one test (`catalog.test.ts`) can check both languages without the web locale, and the API or the worker can use the same labels later. The type is `Record<Step["type"], CatalogEntry>`, so the compiler rejects a new step type with no entry. The test also reads the types from the definition schema at run time, and fails on a missing entry, an empty text in either language, an entry for a type the schema does not have, and a required field that is not a config field of the step.

The label is "App, action" ("Gmail, Send email"). A built-in action has no app, so its label is the action. `destination()` builds the line under a node ("To: Customer email from the form") from the step's own config.

## Consequences

- The picker, the canvas nodes, the phone list, the step inspector, the run path and the screen reader names all call `stepLabel` and `triggerLabel`.
- The catalog's `provider` field names the connection a step needs. `NEEDS` in `lib/editor.ts` still exists for the setup banner and its counts, and `BuildWithAi.tsx` keeps its own plan table. Merging them is a later cleanup.
- Text in a catalog entry is not run through `translate()`, so it does not appear in the locale files.
