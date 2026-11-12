# 0007: Builder UI choices

## Context

Phase 5 adds the console. PROJECT.md asks for a React Flow builder whose step forms come from each step's JSON Schema, test runs with mocked external steps, and light and dark mode with full keyboard use. The API uses a session cookie and has no path prefix.

## Options

Step forms:

1. A JSON Schema form library such as `@rjsf/core` (Apache-2.0). It handles any schema, but adds several packages and its own widget styling to restyle.
2. A small renderer for the shapes our schemas use: strings, enums, integers, nested objects, a string map and one union.

Serving the console:

1. A separate web container or proxy in compose.
2. `@nestjs/serve-static`. It is a CommonJS Nest add-on, and those load a second `@nestjs/core` under tsx (see the handoff notes for phase 3).
3. `app.useStaticAssets()` from `@nestjs/platform-express`, which is already installed.

Test runs need a definition the worker can load. Options: a `definition` column on `runs`, or save the draft as an unpublished version.

## Decision

- A 120-line form renderer (`apps/web/src/SchemaForm.tsx`). If a future step needs a shape it does not handle, add that case there.
- The API serves the built console with `useStaticAssets()` when `WEB_DIST` is set. The console uses hash routes (`#/w/<id>`), so no console path can collide with an API route and no fallback route is needed.
- A test run saves the draft as an unpublished version, unless the newest version has the same definition. Runs keep pointing at a version, so phase 6 run history reads definitions from one place.
- The editor lays out nodes itself and turns off dragging and edge drawing. Steps are added from the side panel. This keeps the canvas equal to the definition and gives keyboard users the same actions as mouse users.

## Consequences

- Each test run of a changed draft adds a version, so the version list in phase 6 should mark which versions were published.
- The API container now builds the console (`Dockerfile`), which makes the api image build slower.
- Users cannot arrange nodes by hand. For linear flows with branches this has not been needed.
