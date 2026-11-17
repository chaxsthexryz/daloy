# 0037: Public demo of the AI helper as a second Vite page

Supersedes [0034](0034-browser-demo.md).

## Context

The owner now pitches the AI helper: describe a task and Daloy drafts it. The public site (daloyapp.pages.dev, Cloudflare Pages) needs a demo of that flow with no API, no sign-in and nothing saved. The old demo was the office-request page at `/#/demo` inside the console bundle, and the copy on the site was a build patched by hand. The real helper (N4f) is not built and no real model's draft quality has been measured.

## Options

- Keep `/#/demo` in the console bundle and copy its build to the site.
- A second Vite page in `apps/web` that reuses the console's styles, canvas and engine code, built to the site with one command.
- A separate static page written by hand.

## Decision

A second page, `apps/web/demo/index.html` with `src/demo/`. The normal build includes it (the API serves it at `/demo/`, which Playwright tests); `pnpm demo:site` builds it alone with relative paths into `site/demo/`. The helper's replies are scripted for three starter prompts and say so on every screen; other text gets the nearest script and a note that the live helper is not ready. The questions are the fixed N4f questions. Drafts are real definitions checked by `definitionSchema` and `lintDefinition`, and the test run walks them with the engine's resolver and branches (`src/demo/simulate.ts`), so the demo shows what the product does with a draft, never what a model would write. The page is light only, like the site. `/#/demo`, `Demo.tsx` and `demo.css` are removed.

## Consequences

The demo cannot drift from the engine: a template or lint change shows up in it on the next build. The demo bundle is large (about 170 KB gzipped, mostly React Flow). Free text never reaches a model, so the demo says nothing about real draft quality. When N4f lands, the scripted replies stay in the public demo until N6 adds AI quotas.
