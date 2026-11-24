# kymavo design

This file fixes the look of the kymavo console and its public landing page (phase V1). Phase V2 applies it to the console and phase W builds the landing page. Both should be able to work from this file and the mockups in `docs/design/` without making design decisions.

## Automations homepage

The owner approved this signed-in homepage on 18 November 2026. Use commit `c92ddc7` on `ui/automation-home` as the visual reference for `#/`. This section takes precedence over the earlier console mockup and palette for this page.

### Recreate the layout

1. Place the kymavo logo and wordmark at the top of the desktop sidebar. Group Automations, Activity and Bookings under **Work**. Group New automation and Build with AI under **Build**. Put Team, Apps, Business, Advanced and Settings under **Workspace**, with account controls at the bottom. Preserve the existing owner and operator permissions. [Navigation](apps/web/src/Nav.tsx) · [Logo](apps/web/public/logo.svg)
2. Put **Automations** at the top of the page. For owners, place the Build with AI link beside the New automation button. Use Inter, with a medium-weight title and compact labels.
3. Below the title, show **Automation status**, **Work queue** and **Recent activity**. Size the status bar segments from the actual On, Paused, Off and Draft counts. Queue counts filter the workflow list. Recent activity links to up to three runs, using the latest run per automation and sorting newest first.
4. Place search and state filters immediately above the workflow cards. Keep each workflow’s name, state, last event and applicable actions together. Group unfinished guided setups under Drafts. Use the existing workspace data, translations and permissions. [Homepage component](apps/web/src/Automations.tsx)

### Match the selected tab and page colours

| Element | Approved treatment |
| --- | --- |
| Desktop surround and sidebar | Pale blue surround `#AED5F0`, warm black sidebar `#1A120F`, 14 px sidebar padding on each side |
| Selected Automations tab | Soft charcoal fill `#353332`, light text `#F5F3F2`, 8 px corners, no shadow. Keep the full 14 px gap between the tab and the page. Use `aria-current="page"` and retain the keyboard focus indicator. |
| Main surface and cards | Warm light gray page `#F1F1EF`, white cards `#FFFFFF`, main text `#201916`, secondary text `#635C58`. The homepage uses light mode even when the browser prefers dark mode. |
| Spacing and shape | 22 px desktop page corners, 20 px overview panel corners, 17 px workflow card corners, 18 px card padding and 12 px gaps between cards |
| Mobile selected tab | Light gray `#F3F3F3` with dark text `#1A120F` in the bottom navigation |

### Check a future redesign

- At 1180 px wide, check the three overview panels and the charcoal sidebar selection. Hover and keyboard-focus Automations. Its label should remain readable and the sidebar gap should stay visible.
- At 1100 px and below, Recent activity spans the row beneath the first two panels. Below 800 px, use the bottom navigation and Menu button. At 650 px and below, stack the panels. Check at 390 px for horizontal overflow.
- Switch the browser to dark mode and confirm the cards still render white. With sample workspace data, select Problem, narrow the results by name and open a recent run. Check the empty-workspace view as well.

Keep homepage cards and filters scoped to `.automation-home` in [automation-home.css](apps/web/src/automation-home.css). Shared navigation, the inset charcoal current tab and the responsive shell live in [console-shell.css](apps/web/src/console-shell.css). Operations, creation and administration each have a scoped stylesheet. Compare desktop and phone layouts in the [offline design walkthrough](docs/design/console-review.html).

## Direction

The owner picked direction B, "Karatula" (a painted shop sign), over a quieter paper-and-ink direction, then adjusted it in review: the fonts and scroll animation of lettrim.com, thinner borders, blue as the main colour, softer state colours, and the scroll animation in the console as well as on the landing page.

- Blue is the main colour. Primary buttons are solid blue. Default buttons, links, the On tag and the current menu item are blue on white. The page background and the soft borders are tinted blue. Text is a dark navy.
- Blue also means "your move": the Needs you strip and the Needs you state are the only solid colour blocks on a page.
- Green, amber and red are quiet. Done, Waiting and Problem are pale fills with darker text of the same hue. A 6 px line on the left edge of each automation card repeats the state in a mid tone.
- Flat and lightly bordered. Borders are 1 px, corners 8 px. Nothing has a drop shadow except things that float over the page.
- One sans-serif, Inter, at weights 400, 500 and 600 (owner decision, 2026-11-21: the approved Doop frames use Inter). Large headings are weight 500 with tight tracking. IBM Plex Mono is for code, JSON and raw state badges.
- Words carry every state. Colour, the card edge and motion repeat what the label already says.

The rejected direction's mockup is not kept in the repo.

## Files

| File | What it is |
| --- | --- |
| `docs/design/tokens.css` | The tokens below as CSS custom properties, plus the `@font-face` rules. Every mockup links it. |
| `docs/design/console.css` | Component styles for the three console mockups. Its selectors are the class names `apps/web/src/styles.css` already uses, so V2 can port it rule by rule. The last block, marked "Mockup only", is not for porting. |
| `docs/design/reveal.js` | The scroll reveal, about 30 lines, used by the landing page and the console mockups. |
| `docs/design/automations.html` | Automations home. Markup copied from `Automations.tsx` and `Nav.tsx`. |
| `docs/design/editor.html` | The editor with a preview run in flight. Markup copied from `Editor.tsx` and `FlowCanvas.tsx`. |
| `docs/design/run.html` | One failed run with "Path it took", and at the bottom a reference sheet of every node and edge state. Markup copied from `Runs.tsx`. |
| `docs/design/landing.html` | The public landing page, with the pricing section. Its styles are inline so W can lift the file whole. |
| `docs/design/index.html` | Viewer: each mockup framed at 375 px and 1280 px. |
| `docs/design/fonts/` | Geist (still used by the marketing site in `site/`) and IBM Plex Mono as woff2 (Latin subset), with their licence texts. The console's Inter lives in `apps/web/public/fonts/`. |

The mockups open as local files. They load nothing from the network. They follow the system colour scheme because `tokens.css` carries both themes; light is the designed theme and dark was spot-checked on the Automations mockup.

## Tokens

Paste these two blocks over the `:root` blocks at the top of `apps/web/src/styles.css`. The first eleven names are the ones the stylesheet already uses, so existing rules pick up the new values. Keep the first block starting with `:root {` at the start of a line and keep the colours as six-digit hex: `apps/web/src/lib/run-flow.test.ts` parses them to check contrast.

```css
:root {
  color-scheme: light dark;

  /* Colour: surfaces and text. The first eleven names already exist in styles.css. */
  --bg: #f2f5fc;
  --surface: #ffffff;
  --text: #0f1e45;
  --muted: #4a5878;
  --border: #7c88a6;
  --accent: #1b45c9;
  --on-accent: #ffffff;
  --danger: #a3261c;
  --ok: #17643a;
  --warn: #7a4b00;
  --focus: #1b45c9;
  /* New names. */
  --sunken: #e6ebf8;
  --border-soft: #c9d3ee;
  --accent-hover: #14349a;
  --accent-tint: #dbe4ff;

  /* Colour: the plain states. Soft fills with darker text of the same hue; only Needs you is solid, in the main blue. */
  --done: #dff1e6;
  --on-done: #17643a;
  --waiting: #fbefc9;
  --on-waiting: #7a4b00;
  --needs-you: #1b45c9;
  --on-needs-you: #ffffff;
  --problem: #fbe3e0;
  --on-problem: #a3261c;
  --working: #e6ebf8;
  --on-working: #0f1e45;

  /* Colour: lines for the run animation, node borders and the state edge on cards. Each meets 3:1 on --surface and --bg. */
  --run-path: #2f8a57;
  --run-failed: #c2483e;
  --run-wait: #b0791f;
  --run-working: #1b45c9;
  --run-idle: #7c88a6;

  /* Type */
  --font-sans: "Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "IBM Plex Mono", "Cascadia Mono", Consolas, monospace;
  --text-xs: 0.8125rem;   /* 13 px: tags, states, table labels */
  --text-sm: 0.9375rem;   /* 15 px: hints, secondary lines, code */
  --text-md: 1rem;        /* 16 px: body, buttons, inputs */
  --text-lg: 1.125rem;    /* 18 px: h3, lead text */
  --text-xl: 1.375rem;    /* 22 px: card titles, h2, console h1 on a phone */
  --text-2xl: 1.75rem;    /* 28 px: console h1 on desktop, landing h2 on a phone */
  --text-3xl: 2.25rem;    /* 36 px: landing h2, landing h1 on a phone */
  --text-4xl: 3.75rem;    /* 60 px: landing h1 on desktop */
  --leading-tight: 1.1;
  --leading-snug: 1.3;
  --leading-body: 1.5;
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-bold: 600;
  --tracking-display: -0.04em; /* 3xl and 4xl */
  --tracking-heading: -0.02em; /* xl and 2xl */
  --tracking-caps: 0.04em;     /* uppercase xs labels */

  /* Spacing, on a 4 px base */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-7: 3rem;
  --space-8: 4rem;
  --space-9: 6rem;

  /* Shape */
  --radius-sm: 4px;   /* tags, states, code */
  --radius-md: 8px;   /* buttons, inputs, cards, nodes */
  --radius-lg: 16px;  /* landing page frames */
  --border-width: 1px;
  --edge-width: 6px; /* the state line on a card's left edge */
  --target: 44px;     /* smallest touch target */

  /* Shadow: the design is flat. One shadow, for things that float over the page. */
  --shadow-overlay: 0 8px 24px rgb(15 30 69 / 0.18);

  /* Motion */
  --ease: cubic-bezier(0.32, 0.72, 0, 1); /* fast start, long settle, no overshoot */
  --dur-fast: 100ms;    /* hover and pressed colour changes */
  --dur-base: 200ms;    /* menu, details, dialogs */
  --dur-reveal: 900ms;  /* scroll reveal, landing page and console */
  --dur-flow: 1200ms;   /* the dot travelling one edge */
  --dur-pulse: 1600ms;  /* the Working node's ring */
  --reveal-shift: 64px;
  --reveal-blur: 8px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b1020;
    --surface: #131a30;
    --text: #eef2ff;
    --muted: #a3aecb;
    --border: #6b7799;
    --accent: #8fb0ff;
    --on-accent: #0b1020;
    --danger: #f0a199;
    --ok: #7fcfa3;
    --warn: #e6c26a;
    --focus: #8fb0ff;
    --sunken: #0b1020;
    --border-soft: #2a3558;
    --accent-hover: #b3c8ff;
    --accent-tint: #1c2a55;

    --done: #173323;
    --on-done: #7fcfa3;
    --waiting: #3a2f10;
    --on-waiting: #e6c26a;
    --needs-you: #8fb0ff;
    --on-needs-you: #0b1020;
    --problem: #401c18;
    --on-problem: #f0a199;
    --working: #232c4a;
    --on-working: #eef2ff;

    --run-path: #5fb98a;
    --run-failed: #e08379;
    --run-wait: #d1ab4f;
    --run-working: #8fb0ff;
    --run-idle: #6b7799;

    --shadow-overlay: 0 8px 24px rgb(0 0 0 / 0.5);
  }
}
```

`docs/design/tokens.css` holds the same values and is what the mockups load. If the two ever differ, this file is right.

## Colour roles

| Token | Role |
| --- | --- |
| `--bg` | The page: a very light blue. |
| `--surface` | Cards, inputs, buttons, the header bar, diagram nodes, the diagram canvas. |
| `--sunken` | Code and JSON blocks, the hover fill of quiet buttons and of the step list. |
| `--text`, `--muted` | Main text (navy) and secondary text. `--muted` is never used on a state fill. |
| `--accent`, `--accent-hover`, `--on-accent` | The main blue. Primary button fill, default button outline and text, links, the On tag, the current menu item. |
| `--accent-tint` | Default button hovered, the selected step in the editor, the Working and Needs you nodes. |
| `--border` | A blue-grey line that meets 3:1: input and select outlines, plain diagram nodes, the dashed outline of a draft card. |
| `--border-soft` | A pale blue line for things that are not controls: cards, panels, the header rule, dividers, disabled buttons. It is decorative and does not need 3:1. |
| `--ok`, `--warn`, `--danger` | State words set as text on the page or a card (messages, raw badges, the Delete step button). |
| `--focus` | The 2 px focus outline, offset 2 px. On the Needs you strip the outline is `--on-needs-you`. |

## The plain states

The label always shows. The colour and the card edge repeat it.

| State | Block fill | Block text | Card edge, node border |
| --- | --- | --- | --- |
| Done | `--done` | `--on-done` | `--run-path` |
| Waiting | `--waiting` | `--on-waiting` | `--run-wait` |
| Needs you | `--needs-you` (solid blue) | `--on-needs-you` | `--needs-you` on the card, `--run-working` on a node |
| Problem | `--problem` | `--on-problem` | `--run-failed` |
| Working | `--working` | `--on-working` | `--border-soft` on the card, `--run-working` on a node |

- A state block is uppercase `--text-xs` at weight 600 with `--tracking-caps`, padding 6 px by 10 px, radius `--radius-sm`.
- On is an outlined tag in `--accent`. Off and Draft are outlined in `--border-soft` with `--muted` text. A draft card has a dashed `--border` outline.
- Messages reuse the fills: `.message.error` is `--problem` with a `--run-failed` left edge, `.message.ok` is `--done` with `--run-path`, `.notice` is `--waiting` with `--run-wait`. Their text is `--text`.
- The pale fills do not reach 3:1 against white, so a fill is never the only mark of a state: every block has its word in it, and lines use the `--run-*` tokens, which do reach 3:1.

## Run animation

These apply to the editor canvas and to "Path it took". The class names are the ones `FlowCanvas.tsx` already sets.

| Thing | Class | Style |
| --- | --- | --- |
| Green path | `.run-edge.done`, `.run-edge.flowing` | Stroke `--run-path`, 2.5 px, solid. |
| Moving dot | `.run-dot` on a flowing edge | Radius 4, fill `--run-path`, 1.5 px `--surface` outline, one trip per `--dur-flow` (1.2 s, linear, as today). |
| Not yet reached edge | `.run-edge` | Stroke `--run-idle`, 1.5 px, dash 2 5. |
| Branch not taken | `.run-edge.skipped` | Stroke `--run-idle`, 1.5 px, dash 7 5. |
| Red failed step | `.node.run-problem` | Border `--run-failed`, fill `--problem`, outer ring 1 px `--run-failed`, status line `--on-problem`. |
| Amber wait | `.node.run-waiting` | Border `--run-wait`, fill `--waiting`, status line `--on-waiting`. |
| Working step | `.node.run-working` | Border `--run-working`, fill `--accent-tint`, status line `--accent`, ring pulsing from 0 to 4 px at 30% `--run-working` every `--dur-pulse`. |
| Needs you step | `.node.run-needs_you` | As Working, without the pulse. |
| Done step | `.node.run-done` | Border `--run-path`, fill `--done`, status line `--on-done`. |
| Not reached | `.node.run-idle` | Dashed border `--run-idle`, fill `--surface`, status line `--muted`. |
| Node with no run | `.node` | Border `--border`, fill `--surface`. Selected: border `--accent` with a 1 px `--accent` ring. |
| Editor edge with no run | `.react-flow__edge-path` | Stroke `--border`, 1.5 px. |

Node text is `--text` on every fill. `.node-status` sets `font-variant-emoji: text` so the pause symbol stays a plain glyph.

## Type

Inter for everything, IBM Plex Mono for code, JSON, textareas that hold JSON, and raw state badges. Both are under the SIL Open Font License 1.1 and are self-hosted. The font stacks fall back to Segoe UI, Roboto, Helvetica Neue and Arial, then to Cascadia Mono and Consolas.

| Use | Size | Weight | Line height | Tracking |
| --- | --- | --- | --- | --- |
| Landing h1, desktop | `--text-4xl` | 500 | 1 | `--tracking-display` |
| Landing h1 on a phone, landing h2 on desktop, the price on a plan | `--text-3xl` | 500 | `--leading-tight` | `--tracking-display` |
| Console h1 on desktop, landing h2 on a phone | `--text-2xl` | 600 console, 500 landing | `--leading-tight` | `--tracking-heading` console, `--tracking-display` landing |
| Console h1 on a phone, h2, card titles | `--text-xl` | 600 | `--leading-snug` | `--tracking-heading` |
| h3, headings inside the editor panel and the technician block, lead text | `--text-lg` | 600 (lead text 400) | `--leading-snug` | 0 |
| Body, buttons, inputs | `--text-md` | 400 (buttons and links 500) | `--leading-body` | 0 |
| Hints, field labels, code, node titles | `--text-sm` | 400 (labels and node titles 600) | `--leading-body` | 0 |
| Tags, states, node text | `--text-xs` | 600 for tags and states, uppercase | 1 | `--tracking-caps` |

Rule of thumb: weight 500 with `--tracking-display` from 28 px up on the landing page, weight 600 below that. Nothing is set in italics or in a weight above 600.

## Spacing, shape and shadow

- Spacing uses `--space-1` to `--space-9` only. Inside a card or panel: `--space-4`. Between cards: `--space-4`. Between page sections in the console: `--space-6`. Between landing page sections: `--space-7` on a phone, `--space-8` on desktop.
- The console page is 64 rem wide at most (it was 56 rem), with `--space-4` side padding on a phone and `--space-5` from 600 px.
- Every button, input, select, menu link and action link is at least `--target` (44 px) tall at every width.
- Radius: `--radius-sm` for tags, states, badges and code blocks, `--radius-md` for buttons, inputs, cards, messages and nodes, `--radius-lg` for frames on the landing page.
- Borders are `--border-width` (1 px). The state line on a card's left edge and on messages is `--edge-width` (6 px).
- `--shadow-overlay` is for the open phone menu if it floats, confirm dialogs and toasts. Cards and buttons never have a shadow.

## Motion

- Hover and pressed states change colour only, over `--dur-fast` with `--ease`. Nothing moves, scales or bounces on hover. A default button fills with `--accent-tint`. A primary button darkens to `--accent-hover`.
- Opening the phone menu or a details block may fade over `--dur-base`. It does not need to animate.
- `--ease` is `cubic-bezier(0.32, 0.72, 0, 1)`: quick at the start, long settle, no overshoot. There are no spring or elastic curves anywhere.
- The Working node pulses (`--dur-pulse`, `ease-in-out`). The dot travels a flowing edge (`--dur-flow`, linear).

### Scroll reveal

A block starts `--reveal-shift` (64 px) low, transparent and blurred by `--reveal-blur` (8 px), and settles once over `--dur-reveal` (900 ms) with `--ease` the first time it enters the view. It does not replay when scrolled past again. Blocks already in view when the page opens settle together at once.

- Landing page: every element marked `data-reveal` in `landing.html`.
- Console: the top-level blocks of `.page` (everything except the header) and each automation card. The selector is `.page > :not(header, .cards), .cards > li`. The editor has no `.page`, so nothing in it moves.
- `docs/design/reveal.js` does it. It sets `data-reveal="pending"` on each target, then `data-reveal="in"` when the target enters the view, and watches for blocks added later (a route change, a new row while polling). It uses a data attribute because React rewrites `className` when a card's state changes. The CSS is two rules under the "Scroll reveal" comment in `console.css`.
- The starting state is only ever set by the script, so with JavaScript off nothing is hidden.

### Reduced motion

Under `prefers-reduced-motion: reduce`:

- Transitions take 0 s. Colours still change on hover and focus.
- The Working pulse and the moving dot are off. The node keeps its blue border and tint and the edge keeps its green stroke, so the state still shows. `FlowCanvas.tsx` already removes the dot in this case.
- The scroll reveal does not run: `reveal.js` returns before marking anything, and the stylesheet forces any marked block to full opacity with no shift or blur. Smooth scrolling on the landing page is off.

## Contrast

WCAG 2.x ratios, computed from the token values for both themes. Text needs 4.5:1. Outlines of controls, focus outlines and diagram lines need 3:1. Every pair passes.

| Foreground | Background | Use | Light | Dark | Needs |
| --- | --- | --- | --- | --- | --- |
| `--text` | `--bg` | Body text on the page | 14.89 | 16.93 | 4.5:1 |
| `--text` | `--surface` | Body text on cards, inputs, nodes | 16.25 | 15.42 | 4.5:1 |
| `--text` | `--sunken` | Code and JSON blocks | 13.63 | 16.93 | 4.5:1 |
| `--muted` | `--bg` | Secondary text on the page | 6.50 | 8.54 | 4.5:1 |
| `--muted` | `--surface` | Secondary text on cards, disabled button text | 7.10 | 7.78 | 4.5:1 |
| `--muted` | `--sunken` | Secondary text in code blocks | 5.95 | 8.54 | 4.5:1 |
| `--accent` | `--bg` | Links on the page | 7.02 | 8.86 | 4.5:1 |
| `--accent` | `--surface` | Links on cards, default button text, On tag | 7.66 | 8.06 | 4.5:1 |
| `--accent` | `--accent-tint` | Default button hovered, selected step, Working node status | 6.04 | 6.50 | 4.5:1 |
| `--accent-hover` | `--bg` | Hovered links on the page | 9.68 | 11.38 | 4.5:1 |
| `--accent-hover` | `--surface` | Hovered links on cards | 10.57 | 10.36 | 4.5:1 |
| `--on-accent` | `--accent` | Primary button | 7.66 | 8.86 | 4.5:1 |
| `--on-accent` | `--accent-hover` | Primary button, hovered | 10.57 | 11.38 | 4.5:1 |
| `--text` | `--accent-tint` | Text in a Working or Needs you node | 12.81 | 12.42 | 4.5:1 |
| `--ok` | `--bg` | Success text on the page | 6.59 | 10.24 | 4.5:1 |
| `--ok` | `--surface` | Success text on cards, raw badges | 7.19 | 9.32 | 4.5:1 |
| `--warn` | `--bg` | Waiting text on the page | 6.79 | 11.08 | 4.5:1 |
| `--warn` | `--surface` | Waiting text on cards, raw badges | 7.41 | 10.09 | 4.5:1 |
| `--danger` | `--bg` | Error text on the page | 6.75 | 9.25 | 4.5:1 |
| `--danger` | `--surface` | Error text on cards, Delete step | 7.37 | 8.43 | 4.5:1 |
| `--on-done` | `--done` | Done state block, Done node status | 6.12 | 7.40 | 4.5:1 |
| `--on-waiting` | `--waiting` | Waiting state block, Waiting node status | 6.45 | 7.71 | 4.5:1 |
| `--on-needs-you` | `--needs-you` | Needs you state block and strip | 7.66 | 8.86 | 4.5:1 |
| `--on-problem` | `--problem` | Problem state block, Problem node status, Delete step hovered | 6.02 | 7.34 | 4.5:1 |
| `--on-working` | `--working` | Working state block | 13.63 | 12.27 | 4.5:1 |
| `--text` | `--done` | Text in a Done node, success message | 13.83 | 12.24 | 4.5:1 |
| `--text` | `--waiting` | Text in a Waiting node, mail notice | 14.16 | 11.78 | 4.5:1 |
| `--text` | `--problem` | Text in a Problem node, error message | 13.29 | 13.44 | 4.5:1 |
| `--border` | `--surface` | Borders of inputs and plain nodes (non-text) | 3.54 | 3.88 | 3:1 |
| `--border` | `--bg` | Input borders against the page (non-text) | 3.25 | 4.26 | 3:1 |
| `--accent` | `--surface` | Button outline, focus outline on cards (non-text) | 7.66 | 8.06 | 3:1 |
| `--focus` | `--bg` | Focus outline on the page (non-text) | 7.02 | 8.86 | 3:1 |
| `--run-path` | `--surface` | Green path, Done node border, Done card edge (non-text) | 4.29 | 7.22 | 3:1 |
| `--run-path` | `--bg` | Green path against the page (non-text) | 3.93 | 7.93 | 3:1 |
| `--run-failed` | `--surface` | Failed step border, Problem card edge (non-text) | 4.89 | 6.31 | 3:1 |
| `--run-failed` | `--bg` | Failed step border against the page (non-text) | 4.48 | 6.93 | 3:1 |
| `--run-wait` | `--surface` | Waiting step border, Waiting card edge (non-text) | 3.75 | 7.92 | 3:1 |
| `--run-wait` | `--bg` | Waiting step border against the page (non-text) | 3.44 | 8.70 | 3:1 |
| `--run-working` | `--surface` | Working step border and ring (non-text) | 7.66 | 8.06 | 3:1 |
| `--run-working` | `--bg` | Working step border against the page (non-text) | 7.02 | 8.86 | 3:1 |
| `--run-idle` | `--surface` | Not reached border, untaken edge (non-text) | 3.54 | 3.88 | 3:1 |
| `--run-idle` | `--bg` | Not reached border against the page (non-text) | 3.25 | 4.26 | 3:1 |

Not in the table on purpose: `--border-soft` (decorative card and panel lines) and the pale state fills as shapes against the page. Neither is the only mark of anything. Disabled buttons use `--muted` text with a `--border-soft` outline.

## Notes for V2 (console)

Scope: `apps/web/src/styles.css`, `apps/web/src/demo.css`, font files under `apps/web/public/fonts/`, and one small script for the scroll reveal. No component's markup needs to change.

The reveal script is the one thing in V2 that is not CSS. The owner asked for it during the V1 review, after the V2 entry in `PROJECT.md` was written ("CSS variables and component styles only"). Treat it as agreed, and say so in the V2 plan.

Steps:

1. Copy `docs/design/fonts/*.woff2` and the two licence texts to `apps/web/public/fonts/`. Add the `@font-face` rules from `tokens.css` to `styles.css` with `url("/fonts/...")`. The API's helmet defaults already allow fonts from the same origin.
2. Replace the two `:root` blocks with the ones above.
3. Port `docs/design/console.css` rule by rule, stopping at the "Mockup only" comment. Its selectors match the existing ones.
4. Apply the same recipe to the selectors the mockups do not show (list below).
5. Port `docs/design/reveal.js` to `apps/web/src/reveal.ts` and import it once from `main.tsx`. Keep the selector list and the data attribute as they are.
6. Run `pnpm test` (the contrast test in `run-flow.test.ts`), `pnpm e2e`, then the N4 exit check.

Risk to check in step 6: Playwright waits for an element to stop moving before it clicks, so each newly revealed block can add up to 0.9 s before the first click on it. The suite should still pass unchanged. If it turns slow or flaky, the clean fix is `reducedMotion: "reduce"` in the Playwright config's `use` block, which is a test-config change the owner must agree to. Do not shorten the reveal or skip it for automated browsers without asking.

Selectors that change, all in `styles.css`:

- Base: `body`, `h1`, `h2`, `a`, `code`, `pre`, `.muted`, `.hint`, `:focus-visible`.
- Controls: `button` and its `:hover`, `:disabled`, `.primary`, `.danger`, `.quiet`, `[aria-pressed="true"]` variants, `input`, `select`, `textarea`, `.field label`, `legend`, `fieldset`, `.actions`, `.message`, `.notice`. A default button is blue text with a blue outline. Disabled buttons lose `opacity: 0.55` and use `--muted` and `--border-soft`. Inputs use `--surface`, not `--bg`.
- Layout: `.page` (64 rem), `.toolbar`, `.toolbar.plain`, `.console-header` and its `nav`, `.who`, `.menu-button`. From 800 px the header is two rows: logo, title and account on top, the menu as a row under it with Sign out at the far end. The logo is drawn at 36 px by CSS; the `img` attributes stay.
- Automations: `.needs-you`, `.cards`, `.card` (state edge through `:has(.state.done)` and the like, dashed for `:has(p a.tag)`), `.card-head`, `.tag`, `.tag.ok`, `.card p a.tag`, `.state` and its five variants, `.create` (a grid that flows by column from 800 px, because the markup is flat).
- Run page: `details summary`, `.technician`, `.extras`, `.badge` and its variants, `.run .steps`.
- Diagram: `.run-canvas` (600 px tall, so a five-row diagram shows at about full size), `.node` and every `.run-*` variant, `.node-type`, `.node-title`, `.node-summary`, `.node-status`, `.react-flow__node.selected .node`, `.react-flow__edge-path` and the `.run-edge` variants, `.run-dot`, `.react-flow__edge-textbg`, `.react-flow__edge-text`, `@keyframes node-pulse`.
- Editor: `.workspace`, `.panel`, `.outline button`.
- New: the two `[data-reveal]` rules and the reduced-motion override.

Selectors the mockups do not show. Use the same recipe: `--surface` fill, a `--border-width` line (`--border` if it can be typed in, `--accent` if it is a button, `--border-soft` if it is neither), `--radius-md`, `--space-4` padding, text sizes from the type table.

- `.table`, `.table.cards` (rows separated by a `--border-soft` line; under 600 px each row is a card with a `--border-soft` outline), `.field.inline`.
- `.in-use`, `.token`, `.chat li`, `.connection`, `.deliveries`, `.versions`, `.changes`, `.change .before` (`--danger`), `.change .after` (`--ok`), `.numbered`, `.choices`, `.choice`, `.page.narrow`.
- Everything in `demo.css`: swap its colours, radii and font sizes for tokens.
- React Flow's own `Controls` and `Background`: set the dot colour to `--border-soft` and the control buttons to the default button recipe.

What must not change:

- Routes, hash paths and link targets.
- Any visible text, label, `aria-label` or `title`. The vocabulary table in `docs/console-redesign-brief.md` stays as built in N4.
- The API, the data the pages load and the polling.
- Markup, class names, element order and `role` attributes. The Playwright suite must pass unchanged.
- Breakpoints: the menu collapses under 800 px, tables become cards under 600 px, the diagram on the run page is hidden under 600 px.
- The eleven existing token names and the two `:root` block shapes the contrast test parses.
- Accessibility already in place: labels, `role="alert"`, visible focus, both colour schemes, reduced motion.

## Notes for W (landing page)

- Build the page from `docs/design/landing.html`: one HTML file with its styles inline, `tokens.css` beside it (or inlined), `reveal.js` (or inlined), the two fonts, and the logo. No build step, no framework, no analytics, no external requests. `reveal.js` is the only JavaScript.
- Replace the framed mockup in the hero with a real screenshot of the Automations home taken after V2 (`docs/screenshots/workflows.png` is retaken by `e2e/demo.spec.ts`). Give it a `--border-soft` outline and `--radius-lg`.
- The copy in the mockup is final unless a fact changes. Check the "What it does not do" list against the README's known limitations on the day you publish, and the "What the demo does not do" list against phase N5 as built.
- The "Open the demo" links are placeholders (`#demo`). Point them at the public demo once N5 is up. Until then, leave those buttons out and keep the section text.
- On 17 November 2026 the owner decided to sell kymavo as a managed subscription and to keep self-hosting off the page. This is newer than the W entry in `PROJECT.md`, which asks for a GitHub link and has no pricing. So the page has a Pricing section, no "Run it yourself" section, and GitHub only as a footer link to the source and to two README anchors. Say so in the W plan and ask the owner to update the W entry.
- Pricing is stated as facts, with no sales copy: Demo at ₱0, a 14-day Pilot at ₱0, and Business at ₱1,500 per business per month plus ₱3,000 setup once. Business Plus is held back until there are three paying customers and one of them reaches 5 automations or asks for changes every month.
- Every line in the Pricing section is a promise. Before publishing, check each one against what is deployed: the service is live on a server (N3 is not finished), backups run nightly and one restore was rehearsed, the daily email limit and the monthly AI allowance are enforced or watched by hand (N6 is not built), and the owner answers email within 2 working days. Remove any line that is not yet true. Do not add what happens when the AI allowance runs out until N6 defines it.
- "What is planned" lists the open phases N6 to N10 in plain words, in roadmap order, with no dates. Check it against `PROJECT.md` on the day you publish. When a phase ships, remove its line and add the feature to a plan.
- The contact address `hello@example.com` is a placeholder. Replace it with the owner's.
- The GitHub links point at `https://github.com/chaxsthexryz/daloy` and at README anchors. Check the anchors exist.
- Third-party products (Gmail, Outlook, Teams, Google Sheets, Slack) appear as plain words. If a logo is ever added, use the vendor's official mark file unchanged.
- The kymavo mark is `apps/web/public/logo.svg`, used as it is.

## Follow-ups outside V1 and V2

These need a component or copy change, so V2 cannot do them.

- On a phone the run page has no "Path it took": the diagram is hidden under 600 px and the step list sits inside "Details for a technician" with raw states. A plain step list with the state blocks, outside that block, would give phone users the path.
- The editor does not say "Use a computer to edit the diagram" under 800 px, which the N4 brief asked for. The canvas takes the top half of the screen instead.
- The request reference (REQ-V7E6FW) could be set in `--font-mono` on the Automations card. It needs a `span` around the reference in `lastEvent`.
- The public form at `/forms/:id` is served by the API with its own styles. It is not covered by V2.

## Fonts and licences

| Font | Files | Licence | Source |
| --- | --- | --- | --- |
| Inter (variable, weights 100 to 900) | `apps/web/public/fonts/inter-variable.woff2` | SIL OFL 1.1, `apps/web/public/fonts/OFL-inter.txt` | github.com/rsms/inter |
| IBM Plex Mono 400 and 500 | `fonts/ibm-plex-mono-400.woff2`, `fonts/ibm-plex-mono-500.woff2` | SIL OFL 1.1, `fonts/OFL-ibmplexmono.txt` | github.com/IBM/plex, Latin subset from Fontsource |
