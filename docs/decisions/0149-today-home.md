# 0149. Today Home screen and end-to-end UX architecture

## Status

Accepted

## Context

Previously `#/` landed owners on the full Automations table with KPI cards, while recent runs lived on a separate `Activity` item and person-action queues were split across Conversations, Receipts to review, and Alert banners.

## Decision

Mount a dedicated Today Home view at `#/` (`GET /home?tz=...` + `apps/web/src/Home.tsx`) and keep `#/automations` for the full automation management list:

1. **Needs you (`HomeController.summary` reusing `loadInboxData`):** reports the exact same pending counts as `#/inbox` and links straight into Inbox.
2. **Problems:** combines recent failed live runs, failed app/mail connections, and missed schedules with direct fix links (`#/runs/:id`, `#/business?tab=apps`, `#/a/:id`).
3. **What ran:** shows running automations (each linking to `#/a/:id` with today's run count in the viewer's IANA timezone), a searchable recent runs feed, and the inline `Ask about a request` helper for owners and operators.
4. **Role scoping:** approvers and requesters receive only their own assigned pending approval count on `#/`, with empty workspace-wide runs, problems, and automations arrays.

## Consequences

- Every owner opens to today's actionable summary first while Automations, Business tabs, Bookings tabs, Inbox, and the `#/a/:id` wizard handle configuration and detail work cleanly across desktop and 390x844 mobile.
