# 0099: Workflow library on the New automation page

## Context

U5 of the console UI plan asks for a gallery of ready-made workflows. Until now `#/new` showed three guided setups in a table, a select box with 16 templates inside the blank workflow form, and a link to Build with AI. A seller had to pick a template by name from a list, with no way to see what it does before a draft exists. The owner approved the plan and said to upgrade `#/new` instead of adding a page. Another phase renames the rail entry to "Library"; this phase does not touch `Nav.tsx`. Decision numbers 0096 to 0098 are taken on other branches, so this one is 0099.

## Options

- A new `#/library` page next to `#/new`, or the existing `#/new` page.
- Open a preview in a side panel, a modal, or a separate route.
- Draw the preview diagram with `RunFlow` from `FlowCanvas.tsx`, or write a smaller static diagram.
- Put the category on the template in the engine, or keep a lookup table in the web app.

## Decision

- `#/new` becomes the Library. The route, its links from Automations and the empty states, and the tests that open it stay as they are. The page title is "Library".
- Every template in `packages/engine/src/templates.ts` has a `category`, one of Inquiries, Bookings, Payments and receipts, Orders, Office (`TEMPLATE_CATEGORIES`). A test fails when a template has none or one that is not on the list. The category sits on the template so the library, a future template picker and the tests share one source. Nothing else about a template changes, so saved workflows and the AI draft path are not affected.
- Layout: a search field, a wording choice (workspace language or Taglish, as before), category chips (All plus the five) and a card grid, 3 columns at 1280 px, 2 on a tablet, 1 on a phone. Blank workflow and Build with AI are the first two cards and show only under All. The guided office setups (office request, purchase request) are cards in Office. The website inquiry setup is a card in Inquiries that opens Business setup, because its setup lives there. Search matches the name, the description and the category in the current language.
- Each template card shows its name, one line, how it starts, and the apps it needs as logos. The apps come from the step catalog (`stepEntry`, `triggerEntry`) and render with `AppMark`, so the logos and letter tiles match the editor. A card for a flow that only uses Daloy's own steps says so.
- Selecting a card, by click or Enter, opens a preview. It has a read-only diagram (`RunFlow` with no run, imported and not changed), the steps in plain words from `explainFlow`, a name box and Use this. On a desktop the preview is a panel above the grid. Under 800 px it is the shared `Sheet`, using the same `usePhone` breakpoint the editor uses. The whole card is one button over the card (a stretched title button), with Use this and Try the preview above it, so there are no nested interactive elements and the keyboard order is title, then actions.
- Use this creates the draft with the same two API calls as before: create the workflow, then save version 1 unpublished with the owner's address in place of `owner@example.com`. A card's Use this names the draft after the template. If that name is taken (409) the page says so and opens the preview, where the name box lets the owner choose another. The guided setups keep `startOfficeSetup` and `startPurchaseSetup` and their error text. A repeated click does nothing while one start is in flight.
- The blank workflow keeps its name box and "Create and open editor" button, inside its card.
- Preview diagram size: the diagram is 440 px high on a desktop and 340 px in the sheet, and fits the flow to the box. `RunFlow` is import-only in this phase, so its minimum zoom of 0.5 stands: a long template is small on a phone, and a flow with three branches side by side is a little wider than a 390 px sheet, so the outer nodes are cut at the edge. The steps in words below the diagram carry the detail, and the diagram can be dragged. The diagram is drawn one frame after the preview opens, because a dialog that is not yet open has no size to fit to.
- The side panel with a sample form link is gone. Its link, Try the preview, moves onto the office request card, because `#/try/office-request` is still the way to try that setup without sending anything.
- No dependency, no migration, no API change.

## Consequences

- Seven e2e specs that open `#/new` for a blank workflow keep working unchanged, because the blank card keeps its Name box and Create button. Three that used the Start from select or the Set up buttons now use the card buttons (`Use this: <name>`), and `e2e/library.spec.ts` covers search, categories, the preview, Use this and the phone layout.
- A new template needs a category; the test says so. A new category needs a chip, which is the list in the engine.
- The preview adds the diagram code (React Flow) to the New automation page. It was already part of the same bundle, because the editor and Runs import it.
- `docs/threat-model.md` does not change: no new input reaches the server and the draft is created through the same endpoints.
