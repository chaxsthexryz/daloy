# 0123: Daloy internal triggers and reusable sub-workflows

## Context

G1 of "Triggers and app expansion" adds automations that react to changes inside Daloy itself (`booking_event` and `payment_event`) and reusable child automations (`sub_workflow` called via a `call_workflow` step). Before G1, Daloy workflows could only chain through HTTP webhooks, duplicating trigger boilerplate or leaving staff-driven booking and payment state changes isolated from automations.

## Options

1. Add database triggers or background polling for bookings and payment dues. Rejected: polling delays event delivery and misses exact transition context such as `rescheduled` or settled checkout amounts.
2. Dispatch internal triggers explicitly at the booking and payment transition sites (`apps/api`, `apps/worker`) using `@daloy/db`'s shared helper, and invoke sub-workflows via a dedicated `call_workflow` step. Chosen.

## Decision

- Three triggers are added in `packages/engine/src/definition.ts` without any database migration, using the existing `triggers` table, `workflow_versions`, and `runs.event_key`:
  - `booking_event`: subscribes to one or more of `created`, `rescheduled`, `cancelled` (`events` array, minimum 1).
  - `payment_event`: subscribes to one or more of `confirmed`, `expired` (`events` array, minimum 1).
  - `sub_workflow`: accepts an optional `fields` schema (`parsePayload` validated at runtime when present) and is excluded from `priceTrusted` so trusted L7 pricing still requires signed webhooks or a `payment` trigger.
- `dispatchInternalTrigger` in `packages/db/src/internal-triggers.ts` finds live, unpaused workflows in the same workspace subscribed to the matching event and starts one deduplicated run per listener via `createKeyedRun` (`booking:<id>:v<version>:<event>` or `payment_due:<id>:<event>`). Test bookings and test payment dues do not dispatch live listeners.
- `startSubWorkflow` resolves a published, unpaused `sub_workflow` by slug inside the caller's workspace, checks cycle detection (`_callChain.includes(target.id)`) and nesting limit (`MAX_SUB_WORKFLOW_DEPTH = 3`), validates declared trigger fields against active workspace resources, and starts one keyed child run (`sub:<parentRunId>:<stepId>`).
- `call_workflow` in `apps/worker/src/steps/index.ts` simulates in mock mode (`{ mocked: true, simulated: true, workflowSlug, payload }`), passes `_callChain` forward on live runs, refuses cycles, depth overruns, paused targets, and non-`sub_workflow` targets without retry, and enqueues non-duplicate child runs onto `RUN_QUEUE`.
- Booking transitions in `apps/worker` (`booking` and `payment_expire` steps) and `apps/api/src/bookings.ts` (`confirmStayBooking`, `rescheduleBooking`, `cancelBooking`), plus payment transitions in `apps/api/src/payments.ts` (`decide`), `apps/api/src/public.ts` (`settleCheckout`), and `apps/worker` (`payment_expire`), emit events using shared payload builders `bookingEventPayload` and `paymentEventPayload`.

## Consequences

- Event dispatch stays inside the workspace boundary and deduplicates across retries without extra tables or polling loops.
- `MAX_SUB_WORKFLOW_DEPTH = 3` keeps nested automation chains bounded and predictable.
- Future internal lifecycle events (such as receipt review flags or conversation closure) can extend `dispatchInternalTrigger` without schema changes.
