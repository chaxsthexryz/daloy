# 0130: Variable picker in the step inspector

## Context

The step inspector listed earlier data as chips that only copied a reference to the clipboard, so an owner had to paste it into a field by hand. The chips showed no values, so the owner could not tell what `{{steps.read.output.amount}}` held. The T1 "Last test" block already stores each step's real output from the last test run.

## Options

1. Track each text field's cursor in React state and thread an insert callback through `SchemaForm` and every custom editor. Rejected: more props across files other phases are editing, and the controlled fields lose the caret on re-render.
2. Mark text fields with `data-variable-target`, remember the last focused one in the inspector, and write to it through the native value setter plus an `input` event so React's own `onChange` runs. The caret is set afterwards.
3. A dropdown inside each field. Rejected: it adds a control to every field and is harder to use on a phone.

## Decision

Option 2. `apps/web/src/VariablePicker.tsx` replaces the copy chips. It keeps the last focused marked field, so Tab to a chip and Enter inserts at that field's cursor, and a phone keyboard closing does not lose the target. With no field chosen it copies the reference, as the chips did.

- `upstreamIds(draft, id)` in `apps/web/src/lib/editor.ts` is the set of steps reachable backwards along edges. `insertables` uses it, so the picker never offers a sibling branch, a later step or the step itself.
- `outputPaths` in `apps/web/src/lib/variables.ts` lists the leaf paths of a sample output (`a.b.0.c`), only with keys the template engine accepts. It caps depth at 6 and the list at 40.
- Previews come from the last test run (`sampleRun`) and the sample trigger data. A step the test did not reach keeps the fields we know and says it has no sample yet. A preview from before the last edit is flagged as stale.
- Secrets: the API already stores `[secret]` for secret-looking keys. The picker repeats that check, so a key such as `api_key` shows `[secret]` and never a value. `{{secrets.name}}` is only mentioned as text and is never resolved or listed with a value.
- Only text inputs, textareas, the "compare with" box and header or map value boxes are targets. Number boxes, selects and the special editors (templates, browser actions) are not.

## Consequences

- No API or database change.
- A reference longer than a field's `maxLength` is inserted anyway and the existing validation reports it.
- Previews show whatever the last test produced, truncated to 40 characters. The picker makes no live call.
