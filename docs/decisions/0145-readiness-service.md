# 0145: Single server-side readiness service

Date: 2026-11-26

## Context

Readiness checks ("can this automation run?") were previously split across at least six client and server files (`Editor.tsx`, `Guide.tsx`, `lib/guide.ts`, `packages/engine/src/flow-guide.ts`, `apps/api/src/explain.ts`, and `apps/api/src/workflows.ts`). Because the client and server evaluated different rules for SMS, Resources, Knowledge, Lalamove, PayMongo, Google Drive, and plan limits, the UI could show a workflow as ready while Publish failed, or fail to warn up front on Library cards.

## Options

1. Keep expanding client-side preflight helpers in `flow-guide.ts` and `Editor.tsx`.
2. Introduce one server-side `evaluateReadiness` service in `apps/api/src/readiness.ts` returning a uniform `ReadinessReport`, expose it via `GET /workflows/:id/readiness`, `POST /workflows/readiness`, and `GET /templates/readiness`, and have `WorkflowsController.addVersion` (`publish: true`) gate publishing on the exact same function.

## Decision

Option 2. All readiness rules now live in `evaluateReadiness` (`apps/api/src/readiness.ts`) using shared engine types (`packages/engine/src/readiness.ts`: `ReadinessKind`, `ReadinessBlocker`, `ReadinessReport`, `TemplateReadiness`).

- `POST /workflows/:id/versions` (`publish: true`) runs `evaluateReadiness` inside its workspace lock transaction and rejects on any `blocker`.
- `Editor.tsx`, `Guide.tsx` (`SampleTest` and `TurnOnSheet`), and `NewAutomation.tsx` read `ReadinessReport` directly from the API instead of recomputing workspace readiness locally.
- `GET /templates/readiness` batches workspace lookups once via `loadWorkspaceReadinessEnv` so all library templates evaluate quickly in one request.

## Consequences

- The UI cannot display green readiness when Publish would refuse, and Library cards show exact workspace blockers (such as missing apps, missing resources, unpublished Knowledge, missing secrets, or SMS plan limits) before selection.
- Future integrations only need to be added once in `apps/api/src/readiness.ts`.
