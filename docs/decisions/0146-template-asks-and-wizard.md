# 0146: Template asks metadata and generated guided wizard

Date: 2026-11-26

## Context

Previously, only two starter templates (`office-request` and `purchase-request`) opened a guided setup wizard (`#/a/:id`). Every other Library template, Build with AI draft, and Onboarding's "Open my draft" button dropped owners directly into the node-diagram editor (`#/w/:id`), because templates did not declare which questions an owner needs to answer before going live.

## Options

1. Hand-write separate React wizards for more templates.
2. Add structured `asks` metadata (`TemplateAsk[]`) to templates and derive fallback asks for custom or AI-generated workflows, then generate one 4-step wizard (`#/a/:id`) and calm status page from that metadata plus the G1 readiness service.

## Decision

Option 2.

- Added `packages/engine/src/template-asks.ts` with `TEMPLATE_ASKS` covering all 39 starter templates (with English and Tagalog labels, field types, and config targets) plus `asksForTemplate`, `defaultAskAnswers`, `answersFromDefinition`, and `applyAskAnswers`.
- Extended `guidedSetupInput` in `packages/engine/src/purchase-request.ts` with `generatedSetupInput` (`kind: "generated"`) stored in the existing `workflows.setup` JSONB column (zero migrations).
- Added `GeneratedWizard` and `AutomationStatusPage` in `apps/web/src/GuidedWizard.tsx` and wired `#/a/:id` (`OfficeRequests.tsx`) to serve every workflow (while preserving the legacy `office-request` and `purchase-request` flows).
- Routed Library templates (`NewAutomation.tsx`), `BuildWithAi.tsx`, `Automations.tsx`, and `Onboarding.tsx` (`#/a/:workflowId`, plus initial setup seeding in `apps/api/src/onboarding.ts`) to `#/a/:id`, switched `Editor.tsx` to open in List view by default, and kept `AutomationTabs` displaying Overview, Activity, and Steps on every workflow.

## Consequences

- Every starter template and AI draft opens in a single-column guided wizard (`Questions -> Connect -> Test -> Turn on`) and transitions into a calm status page once live.
- The diagram/step editor (`#/w/:id`) is reached only via "Edit steps" or when creating a blank automation.
