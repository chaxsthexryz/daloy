# 0096: Editor panel and canvas (U2)

## Context

The owner asked for the Steps page to follow the Paper file "daloy", page "Workflow tab", and to fix the canvas faults seen in their screenshots of 21 November 2026: the black "+ Add step" button, a plus on a connection that sat 44px right of the branch pill and covered the next pill, a 10px invisible hit area around each plus, and an add menu that opened as a centred modal with a list that scrolled sideways. They also asked for connection dots, drop to connect and a right-click menu like Lucid. The plan is `docs/plans/console-ui-paper.md`, asks 2 and 3; the owner approved its defaults.

## Options

- Actions: keep Test run, Explain, Save and Publish in the header, or move them into the side panel.
- Adding a step: keep the R4 "Add a step" select in the panel, or add only from the canvas (plus, dot, right click) and the list.
- Connecting by drag: React Flow's `onConnect` (fires only when the pointer ends on a handle), or `onConnectEnd` with a hit test, so a drop anywhere on a step's card counts.
- Copy and paste: an in-memory copy only, or the system clipboard as well.
- Single-step test: a new API that runs one step with sample inputs for the steps before it, or the existing mocked test of the whole draft, scrolled to that step.

## Decision

- The four actions sit in a sticky row at the top of the side panel, in both panel states. Folding the panel (a 32px toggle on its left edge, kept per viewer in `localStorage` under `daloy.editor.panel`) leaves a 44px strip and moves the actions back into the header, so they are never hidden. Below 1000px, where the panel sits under the canvas, the actions sit above the canvas or list.
- With nothing selected the panel shows the setup guide, "Check before publishing", the sample test, Ask the AI, and "Test settings" folded in a `<details>`. A selected step or trigger shows its settings as before, with a Close button; Escape and a click on empty canvas also close it.
- The R4 select and the black button are removed. Steps are added from the plus on a connection, by dragging from a selected step's dot, from the right-click menu ("Add a step after this one", "Add step here"), from "Add a step after this one" in the step's panel (the keyboard route on a wide screen), and from "+ Add a step at the end" under the list (and on a phone, and in an empty flow).
- The plus on a branch's connection goes on the last vertical run, halfway between the pill and the next step. Rows are 170px apart instead of 130px so it fits. The hit area matches the button (44px only on coarse pointers). On a wide screen the add menu is a `Popover` (in `Sheet.tsx`) anchored to what opened it; a phone keeps the bottom sheet. Descriptions wrap to two lines.
- `nodesConnectable` is on. Source dots start a drag; the top dot only receives. `connectOnClick` is off and React Flow fires `onConnectEnd` only after the pointer moved, so a click on a dot does nothing. The drop target is the step under the pointer (`toNode`, or `elementFromPoint` on the card), passed to `connectSteps`, whose refusals show in the canvas note. A drop on empty canvas opens the add menu there, after the source on the dragged branch. The trigger's dot stays inert, because the trigger always leads to the first step.
- `duplicateStep` (in `lib/graph.ts`) copies a step under `<id>_copy`, `<id>_copy_2` and so on, right after the original, and refuses a branching step with a reason. Copy writes `{type, config}` to memory and to the system clipboard; paste reads the clipboard (a paste event for Ctrl+V, `readText` from the menu) and falls back to the memory copy. `readCopiedStep` accepts only an addable type whose config has that step's shape and drops unknown keys. Configs hold `{{secrets.name}}` references, never values, so nothing secret is copied.
- "Test this step" runs the mocked test of the whole draft and scrolls to that step's line in the result. No API change.
- Added beyond the plan: "Add a step after this one" in a step's right-click menu, because Shift+F10 opened the add menu in R4 and the keyboard path should keep reaching it.

## Consequences

- Seven e2e specs that used the R4 select or the sample data field now go through `e2e/editor-steps.ts` (`addStep`, `openTestSettings`).
- Disable (U3) adds one item to the node menu and a greyed node; both files are ready for it.
- A step cannot be pasted into another browser profile's clipboard if the browser refuses clipboard access; the in-memory copy still works within the page.
- The diagram is taller for the same flow because of the wider row spacing.
- Found during the 390 px check: the shared `Sheet` takes its background from `--w-bg`, which only `.wk` pages define, so sheets in the editor (step settings, Explain, Turn on) drew with no background since R4. `editor.css` now maps the `--w-*` tokens onto the editor's own.
