# 0081. Browser demo: its own scoped stylesheet, the real flow diagram, "Needs you" for a waiting approval

## Context

The approved E11 frames show the public demo with a banner across the top, a 232px sidebar, white cards on a grey page, Inter, and the draft with Done, Needs you and Not reached labels beside each step. The demo used the console stylesheet (an older look) and a yellow notice inside the page. The frames draw a small hand-made diagram. The demo runs the real React Flow canvas (`RunFlow`) with the real checker, so what it shows is what the console shows.

## Decision

`demo.css` styles only what is inside `.demo`, with its own tokens, and uses the console stylesheet as a base for the flow canvas. Buttons are restyled inside the page and sidebar only, so the React Flow controls keep their own look. The banner moved out of the page so it spans the top. The diagram stays the real canvas with the frame's caption under it, rather than a copy of the frame's drawing. A step waiting for the visitor's approval shows "Needs you" in the draft list and on the diagram while the status line still says "Waiting for your approval". The Daloy mark is an inline SVG (the flat blue one from the frames) so the page needs no image request.

## Consequences

- The demo still makes no request after load, and nothing is stored: `e2e/portfolio-demo.spec.ts` checks both with the network offline.
- Node boxes in the diagram look like the console's, not the frame's simplified boxes. Changing that means changing `FlowCanvas.tsx` for the whole console.
- Light only, as before.
