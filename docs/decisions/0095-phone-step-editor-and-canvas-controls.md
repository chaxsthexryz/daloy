# 0095: Phone step editor and canvas controls

## Context

R4 of the seller pilot roadmap (section 7) asks for a step editor a seller can use on a phone: add, reorder and edit a step, and undo. Canvas controls come after that: a searchable add menu, insert on a connection, connect without dragging, and undo from the keyboard. The owner pre-approved the phase, so this record is the plan and the decision. Decision numbers 0093 and 0094 are taken on other branches, so this one is 0095; renumber at merge if it collides.

## Options

- Keep the edit history on the server (a draft table) or in the editor's memory.
- Reorder with drag and drop, or with move up and move down buttons.
- Let a move rewire any step, or only steps on a straight stretch of the flow.
- Add a graph library for editing, or keep the React Flow setup the editor already has.

## Decision

- Every edit is already a pure function from one draft to the next (`lib/graph.ts`). Two more join them: `moveStep` (swap a step with its neighbour on a straight stretch) and `connectSteps` (point a step's outgoing path at another step, or refuse with a reason).
- Undo and redo keep whole drafts in memory (`lib/history.ts`). Nothing is saved or published by an edit. Edits to one step's fields coalesce into one undo step, so typing a sentence is one undo, not one per key. Undo and redo are buttons, and Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y outside text fields. The history is dropped on reload, which is acceptable because Save and Publish stay explicit.
- Reorder uses move up and move down buttons on each row of the phone list, 44 px high. Nothing is drag-only. A step moves only when it and its neighbour have one outgoing path and no branch, and the neighbour has one way in. A condition, approval or other branching step stays put, because swapping it would need a rule for where each branch goes. After a move the steps are numbered in flow order. The result is checked by the same tests as `addStep` and `removeStep`: one entry step, no cycle, no edge to a missing step.
- On a phone, selecting a step in the list opens its settings in the shared `Sheet`. On a wider screen the settings stay in the side panel.
- One searchable add menu (a sheet with a search field and a list of step types) opens from the plus on a connection, from a right click or Shift+F10 on a step, and from the step list. The existing "Add a step" select stays, so current flows and tests keep working. Adding through the plus on a connection reuses `addStep`, which already inserts between two steps.
- Connect to is a field in the step settings: pick the step this one leads to, per branch. It refuses a self link, a loop, and a change that would leave a step with no way in, and says which. Drag handles are not added: the same rules would apply, and the field already works on touch and keyboard.
- Publishing is unchanged. Publish still opens the Turn on summary (0092) and only its confirm button saves a live version. An edit marks the sample test out of date, as before.
- No new dependency, no migration, no API change.

## Consequences

- A seller can build and reorder a flow on a 390 px screen with taps only.
- Reordering is limited to simple stretches. Moving a step across a branch is done by deleting it and adding it where it should go, or with Connect to.
- Undo is lost on reload. A saved version is the durable undo, and Versions already lists them.
