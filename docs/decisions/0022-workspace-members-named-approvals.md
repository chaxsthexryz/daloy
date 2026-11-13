# 0022: Office teams and named approvals

## Context

Roadmap phase 4 lets an office have more than one person: an owner, staff who run things, people who approve purchases, and people who only send requests. Until now every account was alone, and an approval link worked for whoever held it ([decision 0009](0009-approval-links.md)). The acceptance check asks for the signed-in approver to be verified on the server, so that a forwarded link, a repeated answer or someone from another workspace cannot authorize a purchase, and for the record to say who decided and when. Accounts and approval links that exist before the upgrade must keep working.

## Options

How a workspace is identified:

1. A new `workspaces` table, with every owner-scoped table (`workflows`, `secrets`, `api_tokens`, `connections`, `mail_senders` and more) moved from `user_id` to `workspace_id`.
2. The owner's user id is the workspace id. Every existing `user_id` column already names the workspace, and a `workspace_members` table says who else belongs to it.

Where the approver check runs:

1. In the API controller, before calling `recordDecision`.
2. In the same guarded UPDATE that uses the link.

What happens to links sent before the upgrade:

1. Expire them, so every approval needs a named approver.
2. Keep them as link-holder approvals until they are used or expire.

## Decision

- Option 2 for the workspace. `workspace_members (user_id primary key, workspace_id, role)`, so an account belongs to exactly one workspace. A check constraint makes the owner row the one where `workspace_id = user_id`: nobody else can become owner and the owner can't be demoted. Controllers filter on `user.workspaceId` where they filtered on `user.id`.
- Roles. Owner: everything, including the Team page, settings, connections, API tokens and changing automations. Operator: sees automations, runs and requests, and retries or confirms deliveries. Approver: answers approvals named to them, and sees their own requests. Requester: sends requests and sees their own. `Allow(MANAGE | OPERATE | ANY_MEMBER)` guards each route after `SessionGuard`, and `apps/api/src/members.test.ts` checks every route against every role.
- Invites are one-time links the owner copies (32 random bytes, only the SHA-256 stored, seven days). Accepting creates the account, or adds an account that is in no workspace after checking its password. The invite, the account and the membership are written in one transaction. An owner can't be invited.
- Removing a member deletes their membership and their sessions. An account with no membership counts as signed out and can't sign in. The account itself stays, so past decisions keep their author.
- An approval step takes either `to` (a link-holder approval, as before) or `approver`, the sign-in email of a member who may approve (owner or approver). The approver is a plain email, not a template, so publishing can check it, and the worker checks it again before it creates the link. The email goes to that member's sign-in address and says which account to sign in with.
- Option 2 for the check. `recordDecision` uses the link with one UPDATE whose WHERE clause requires an unused, unexpired link and, for a named approval, the signed-in user to be the approver and, at that moment, a member of the run's workspace with a role that may approve. Removal, demotion, a move to another workspace, a replayed answer, an expired link and two answers at the same moment are all settled by that one statement under the row lock. The controller runs the same check first only to choose the page to show.
- The decider's id and email go into `approvals.decided_by` and `decided_by_email` with `used_at` as the time. The worker copies `decidedBy` and `decidedAt` into the step output, so later steps and the run history can show them.
- A named approval page shows nothing about the request until the named approver is signed in. A signed-out visitor gets a sign-in link (`#/answer/<token>`) that returns to the page after sign-in; anyone else gets "assigned to someone else". The confirmation page shows only the decision.
- Option 2 for old links. Migration 0009 makes every existing account the owner of its own workspace and leaves `approver_id` null on existing approvals, so a link already in someone's inbox works once, as it did, and `apps/api/src/upgrade.test.ts` proves it. `approver_id` cascades on delete instead of being set to null, so a named approval never turns into a link-holder one.
- A form sent by a signed-in member of the workflow's workspace records them in `requests.requested_by`, for My requests.

## Consequences

- Link-holder approvals still exist for people outside the office, such as a client. An owner who needs a verified decision must name an approver; the editor shows both fields.
- One workspace per account. Someone who works for two offices needs two accounts.
- API tokens and the MCP endpoint act for the workspace with owner rights, and only the owner can create them. There are no per-token roles.
- Invites are not emailed. The owner copies the link and sends it.
- Workspace ids are owner user ids, so ownership can't be handed to another account without moving every row.
