# 0148. Unified Inbox for conversations, receipts, approvals and checks

## Status

Accepted

## Context

Staff work that waits on a human (conversations handed over from the bot, payment receipts awaiting review, paused approvals, and `needs_review` runs) previously lived across Conversations, Receipts to review, the Automations alert banner, and emailed approval links.

## Decision

Add one workspace Inbox (`GET /inbox`, `POST /inbox/approvals/:id/decide`, UI at `#/inbox`) for owners and operators:

1. **Single aggregator (`loadInboxData` in `apps/api/src/inbox.ts`):** merges staff-paused conversations, open receipt claims/failed confirmation replies, pending non-test workflow approvals (deduplicated per waiting step and masked via `historyHider`), and `needs_review` runs/deliveries sorted oldest-first.
2. **In-console approvals (`listPendingApprovals` and `decideApprovalById` in `packages/db/src/approvals.ts`):** reuses the atomic run row lock and `allowed(actor)` SQL check from decision 0022 so named approvals remain restricted to their assigned `approver` or `owner`, concurrent clicks settle at most once, and sibling email links settle together.
3. **Nav badge and deep-link preservation:** `Nav.tsx` displays the live Inbox count badge, while `#/conversations` and `#/receipts` stay reachable for conversation and payment configuration.

## Consequences

- Operators and owners have one queue for all person-action work.
- G5 Home reuses `loadInboxData` so the Home `Needs you` card and the Inbox sidebar badge always match.
