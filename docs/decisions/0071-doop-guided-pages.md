# 0071. Guided pages follow the Doop frames, with five recorded deviations

## Context

Rows A2 to A6 of the Doop round (New automation, the office request preview, the office and purchase setups, the live overview) were rebuilt from five frames on the Doop canvas. The frames show some things the code or the other open branches do not have.

## Options

1. Follow each frame exactly and add the missing data, steps and tabs.
2. Build the frame's layout and keep the existing behaviour and data where the frame asks for something that does not exist yet.

## Decision

Option 2. The pages reuse the A1 classes in `automations-ops.css` (tokens, buttons, KPI strip, table, side panel) and add `guided-pages.css`. Deviations:

1. The blank workflow button reads "Create and open editor", not "Open editor". It sits next to the Name field and the Start from list, which the frame leaves out. Nine e2e specs create workflows through this form and find the button by "Create".
2. The purchase setup keeps its four steps (Name, Who decides, Where approved requests go, Review). The frame has a fifth, "Purchase form", that nothing in the engine backs. The purchasing inbox stays on the destinations step, so saved drafts resume on the same step.
3. The live overview keeps the tabs Overview, Activity and Steps. The frame shows Versions instead of Steps, and `AutomationTabs` lives in `Nav.tsx`, which another session owns.
4. Request rows show reference, subject and time. The frame also shows the requester's name, which `GET /workflows/:id/requests` does not return.
5. The frame's sample values (REQ-0042, Nina Santos) are not used. The preview shows the engine's sample request and the setup shows the saved answers.

## Consequences

The pages match the frames in layout and wording, and no route, API or engine change was needed. Item 3 needs a one-line change in `Nav.tsx` once the Versions page (A9) lands. Item 4 needs the requests endpoint to return the submitter's name.
